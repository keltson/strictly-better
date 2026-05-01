#!/usr/bin/env python3
"""
Generates card-cache.json from card-pairs.json.
Fetches static card metadata (images, oracle text, types, etc.) from Scryfall.
Prices are intentionally excluded — they are fetched live and cached in the browser.

Usage:
    python3 scripts/build-cache.py

Requirements: Python 3.7+
"""

import json
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent.parent
PAIRS_PATH = ROOT / "card-pairs.json"
CACHE_PATH = ROOT / "card-cache.json"
BATCH_SIZE = 75
BATCH_DELAY_S = 0.15


def get_image_uri(card):
    if "image_uris" in card:
        return card["image_uris"].get("normal")
    faces = card.get("card_faces", [])
    if faces and "image_uris" in faces[0]:
        return faces[0]["image_uris"].get("normal")
    return None


def extract_static_fields(card):
    faces = card.get("card_faces")
    if faces:
        oracle = "\n".join(f.get("oracle_text", "") for f in faces).lower()
        type_line = " // ".join(
            f.get("type_line", card.get("type_line", "")) for f in faces
        ).lower()
        mana_cost = (faces[0].get("mana_cost") or "").lower()
    else:
        oracle = (card.get("oracle_text") or "").lower()
        type_line = (card.get("type_line") or "").lower()
        mana_cost = (card.get("mana_cost") or "").lower()

    return {
        "name": card["name"],
        "image": get_image_uri(card),
        "url": card.get("scryfall_uri"),
        "oracle": oracle,
        "type": type_line,
        "colors": card.get("colors", []),
        "colorIdentity": card.get("color_identity", []),
        "cmc": card.get("cmc", 0),
        "rarity": card.get("rarity", ""),
        "keywords": [k.lower() for k in card.get("keywords", [])],
        "legalities": card.get("legalities", {}),
        "power": card.get("power"),
        "toughness": card.get("toughness"),
        "set": card.get("set", ""),
        "manaCost": mana_cost,
    }


def scryfall_name(name):
    """Scryfall collection API doesn't accept '// back face' DFC names — use front face only."""
    return name.split(" // ")[0] if " // " in name else name


def fetch_batch(names):
    # Map scryfall lookup name → original name for DFCs
    lookup = {scryfall_name(n): n for n in names}
    payload = json.dumps({"identifiers": [{"name": k} for k in lookup]}).encode("utf-8")
    req = urllib.request.Request(
        "https://api.scryfall.com/cards/collection",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "strictly-better-cache-builder/1.0",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    for w in data.get("warnings", []):
        print(f"  Scryfall warning: {w}", file=sys.stderr)
    # Re-key cards by original name (restores the full DFC name where needed)
    results = []
    for card in data.get("data", []):
        original = lookup.get(card["name"], card["name"])
        card["name"] = original
        results.append(card)
    return results


def main():
    if not PAIRS_PATH.exists():
        print(f"card-pairs.json not found at {PAIRS_PATH}", file=sys.stderr)
        sys.exit(1)

    pairs = json.loads(PAIRS_PATH.read_text(encoding="utf-8"))

    # Collect unique names preserving insertion order
    seen = set()
    name_list = []
    for row in pairs:
        better, *worse = row
        for name in [better, *worse]:
            if name not in seen:
                seen.add(name)
                name_list.append(name)

    print(f"Found {len(name_list)} unique card names in card-pairs.json")

    chunks = [name_list[i : i + BATCH_SIZE] for i in range(0, len(name_list), BATCH_SIZE)]
    cards = {}
    done = 0
    not_found = 0

    for i, chunk in enumerate(chunks):
        print(f"\rFetching batch {i + 1}/{len(chunks)} ({done}/{len(name_list)} cards)...", end="", flush=True)
        try:
            results = fetch_batch(chunk)
            for card in results:
                cards[card["name"]] = extract_static_fields(card)
            missing = len(chunk) - len(results)
            if missing > 0:
                not_found += missing
                found_names = {c["name"] for c in results}
                for name in chunk:
                    if name not in found_names:
                        print(f'\n  Not found on Scryfall: "{name}"', file=sys.stderr)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            print(f"\n  Batch {i + 1} HTTP error {e.code}: {e.reason} — {body[:300]}", file=sys.stderr)
        except Exception as e:
            print(f"\n  Batch {i + 1} failed: {e}", file=sys.stderr)

        done = min(done + BATCH_SIZE, len(name_list))
        if i < len(chunks) - 1:
            time.sleep(BATCH_DELAY_S)

    print(f"\rFetched {len(cards)} cards ({not_found} not found on Scryfall)        ")

    output = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "count": len(cards),
        "cards": cards,
    }

    CACHE_PATH.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote card-cache.json")


if __name__ == "__main__":
    main()
