"""Fetch Zwift's schedule and route data and write them to data/ as JSON.

Uses only the Python standard library so the GitHub Action needs no installs.
Exits with an error (and writes nothing) if the data looks wrong.
"""

import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

SCHEDULE_URL = "https://cdn.zwift.com/gameassets/MapSchedule_v2.xml"
DICTIONARY_URL = "https://cdn.zwift.com/gameassets/GameDictionary.xml"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# Bit flags in a route's "sports" attribute.
SPORT_CYCLING = 1
SPORT_RUNNING = 2

# The schedule names one guest world per slot; the game always pairs it with a
# fixed second world that the XML never mentions. Verified against the in-game
# worlds and Zwift Insider's calendar for September 2026.
GUEST_PAIRS = {
    "FRANCE": "PARIS",
    "INNSBRUCK": "RICHMOND",
    "RICHMOND": "LONDON",
    "LONDON": "YORKSHIRE",
    "MAKURIISLANDS": "NEWYORK",
    "SCOTLAND": "MAKURIISLANDS",
}


def fetch_xml(url):
    request = urllib.request.Request(url, headers={"User-Agent": "where-to-zwift-today"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return ET.fromstring(response.read())


def parse_start(value):
    # Zwift writes offsets as "-04"; Python wants "-04:00".
    if len(value) >= 3 and value[-3] in "+-" and value[-2:].isdigit():
        value += ":00"
    start = datetime.fromisoformat(value)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    return start.astimezone(timezone.utc)


def build_schedule(root):
    appointments = []
    for item in root.iter("appointment"):
        world = item.get("map")
        start = parse_start(item.get("start"))
        worlds = [world]
        if world in GUEST_PAIRS:
            worlds.append(GUEST_PAIRS[world])
        else:
            # Shows as a warning on the Action run; the picker still gets one world.
            print(f"::warning::No paired world known for {world}; update GUEST_PAIRS")
        appointments.append({"start": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "map": world, "worlds": worlds})
    appointments.sort(key=lambda a: a["start"])
    if not appointments:
        raise ValueError("schedule has no appointments")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    current = [a for a in appointments if a["start"] <= now]
    if current:
        print("Active now: WATOPIA, " + ", ".join(current[-1]["worlds"]))
    return {"alwaysActive": ["WATOPIA"], "appointments": appointments}


def build_routes(root):
    routes = []
    for item in root.iter("ROUTE"):
        world = item.get("map")
        if not world:
            continue  # climb portal entries, not real routes
        sports = int(item.get("sports") or 0)
        routes.append({
            "id": item.get("signature"),
            "name": item.get("name"),
            "map": world,
            "distanceMeters": round(float(item.get("distanceInMeters") or 0), 1),
            "ascentMeters": round(float(item.get("ascentInMeters") or 0), 1),
            "leadinDistanceMeters": round(float(item.get("leadinDistanceInMeters") or 0), 1),
            "leadinAscentMeters": round(float(item.get("leadinAscentInMeters") or 0), 1),
            "cycling": bool(sports & SPORT_CYCLING),
            "running": bool(sports & SPORT_RUNNING),
            "eventOnly": item.get("eventOnly") == "1",
            "levelLocked": item.get("levelLocked") == "1",
        })
    routes.sort(key=lambda r: (r["map"], r["name"]))
    if len(routes) < 100:
        raise ValueError(f"only {len(routes)} routes found, expected hundreds")
    return {"routes": routes}


def write_json(name, payload):
    path = DATA_DIR / name
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(DATA_DIR.parent)}")


def main():
    # Build everything first so a failure leaves the existing files untouched.
    schedule = build_schedule(fetch_xml(SCHEDULE_URL))
    routes = build_routes(fetch_xml(DICTIONARY_URL))
    DATA_DIR.mkdir(exist_ok=True)
    write_json("schedule.json", schedule)
    write_json("routes.json", routes)
    print(f"{len(schedule['appointments'])} appointments, {len(routes['routes'])} routes")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"update failed: {error}", file=sys.stderr)
        sys.exit(1)
