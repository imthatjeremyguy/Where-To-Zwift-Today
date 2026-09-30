"""Fetch Zwift's schedule and route data and write them to data/ as JSON.

Uses only the Python standard library so the GitHub Action needs no installs.
Exits with an error (and writes nothing) if the data looks wrong.
"""

import html
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SCHEDULE_URL = "https://cdn.zwift.com/gameassets/MapSchedule_v2.xml"
DICTIONARY_URL = "https://cdn.zwift.com/gameassets/GameDictionary.xml"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
USER_AGENT = "Mozilla/5.0 (compatible; WhereToZwiftToday/1.0; +https://github.com/imthatjeremyguy/Where-To-Zwift-Today)"

# Route pages on Zwift Insider. There is no index of them, so we guess each
# address from the route name, check it once, and remember the answer in
# data/route-links.json. Misses are rechecked weekly in case a page appears.
ROUTE_PAGE_URL = "https://zwiftinsider.com/route/{}/"
LINKS_FILE = "route-links.json"

# Permanent position for every route ID ever seen. New routes are appended and
# nothing is ever removed or reordered, so progress links made today keep
# pointing at the same routes after future updates.
ORDER_FILE = "route-order.json"
MISS_RECHECK_DAYS = 7
MAX_LINK_CHECKS_PER_RUN = 50
LINK_CHECK_DELAY_SECONDS = 1

# Routes whose Zwift Insider address can't be guessed from the name.
LINK_OVERRIDES = {
    "R.G.V.": "https://zwiftinsider.com/route/rgv/",
    "London PRL FULL": "https://zwiftinsider.com/route/the-prl-full/",
    "London PRL Half": "https://zwiftinsider.com/route/the-prl-half/",
}

# Bit flags in a route's "sports" attribute.
SPORT_CYCLING = 1
SPORT_RUNNING = 2

# Route and Climb of the Week, from Zwift Insider's Ride of the Week calendar
# (Zwift publishes no data file for these). One page per month.
WEEKLY_URL = "https://zwiftinsider.com/weekly-challenges/?grid-list-toggle=grid&month={month}&yr={year}"
WEEKLY_FILE = "weekly.json"
WEEKLY_CATEGORIES = {"Route of the Week": "route", "Climb of the Week": "climb"}

# Climb portal rotation: Watopia's daily portal climb and France's Climb
# Portal of the Month. Shown on the Calendar only, never in the spinner.
PORTAL_URL = "https://cdn.zwift.com/gameassets/PortalRoadSchedule_v1.xml"
PORTAL_FILE = "portal.json"
PORTAL_PAGE_URL = "https://zwiftinsider.com/portal/{}/"
# Zwift's world numbers, for the worlds that have climb portals.
PORTAL_WORLDS = {"1": "WATOPIA", "10": "FRANCE"}

# Alert when the newest schedule entry starts within this many days. A slot
# lasts about 2 days, so this gives warning before the schedule runs out.
SCHEDULE_ALERT_DAYS = 2

# Problems worth a human look. The workflow turns these into a GitHub issue.
alerts = []

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
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
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
            # The picker still works with one guest world, but someone should add the pair.
            alert(f"No paired world is known for guest world {world}. Check today's worlds in Zwift and add it to GUEST_PAIRS in scripts/update_data.py.")
        appointments.append({"start": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "map": world, "worlds": worlds})
    appointments.sort(key=lambda a: a["start"])
    if not appointments:
        raise ValueError("schedule has no appointments")
    now = datetime.now(timezone.utc)
    now_text = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    current = [a for a in appointments if a["start"] <= now_text]
    if current:
        print("Active now: WATOPIA, " + ", ".join(current[-1]["worlds"]))
    check_schedule_runway(appointments, now)
    return {"alwaysActive": ["WATOPIA"], "appointments": appointments}


def alert(message):
    alerts.append(message)
    print(f"::warning::{message}")


def check_schedule_runway(appointments, now):
    last_start = datetime.fromisoformat(appointments[-1]["start"].replace("Z", "+00:00"))
    if last_start - now < timedelta(days=SCHEDULE_ALERT_DAYS):
        alert(
            f"Zwift's world schedule runs out soon: the last entry starts {last_start:%Y-%m-%d %H:%M} UTC "
            "and no newer schedule has been published. The site will fall back to Watopia only about 4 days "
            "after that. Usually Zwift publishes the next month in time and this closes itself; if not, "
            "check whether the schedule file moved."
        )


def write_alerts():
    """Write alerts as Markdown for the workflow, if it asked for them."""
    path = os.environ.get("ALERTS_FILE")
    if os.environ.get("TEST_ALERT") == "true":
        alerts.append("Test alert from a manual run. Nothing is wrong; the next normal run closes this issue.")
    if path:
        Path(path).write_text("".join(f"- {a}\n" for a in alerts), encoding="utf-8")


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
            # Laps are only offered on routes that finish where they start.
            "loop": item.get("supportedLaps") == "1",
            # YYYY-MM-DD; only set on newer routes. May be in the future for unreleased routes.
            "publishedOn": item.get("publishedOn") or None,
        })
    routes.sort(key=lambda r: (r["map"], r["name"]))
    if len(routes) < 100:
        raise ValueError(f"only {len(routes)} routes found, expected hundreds")
    return {"routes": routes}


def slugify(name):
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    text = text.replace("'", "").replace("&", "and")
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def link_candidates(name):
    # Zwift Insider covers run variants on the ride page and drops "Watopia" from some names.
    names = [name]
    base = re.sub(r"\s+Run$", "", name)
    for candidate in (base, re.sub(r"^Watopia\s+", "", base)):
        if candidate not in names:
            names.append(candidate)
    return names


def find_route_page(name, url_pattern=ROUTE_PAGE_URL, kind="/route/"):
    """Return the page URL, or None if no guess exists. Raises on network trouble."""
    for candidate in link_candidates(name):
        url = url_pattern.format(slugify(candidate))
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        time.sleep(LINK_CHECK_DELAY_SECONDS)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                final_url = response.geturl()
                if kind in final_url:
                    return final_url
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
    return None


def update_links(routes, climbs=()):
    """Add a "link" to each route and climb, checking only names not already in the cache.

    Climbs are cached under "portal:<name>" and looked up on Zwift Insider's /portal/ pages.
    """
    path = DATA_DIR / LINKS_FILE
    cache = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    today = datetime.now(timezone.utc).date()
    recheck_before = (today - timedelta(days=MISS_RECHECK_DAYS)).isoformat()

    names = sorted({r["name"] for r in routes if not r["eventOnly"]} - LINK_OVERRIDES.keys())
    names += sorted({f"portal:{c['name']}" for c in climbs})
    for name in LINK_OVERRIDES:
        cache.pop(name, None)
    due = [n for n in names if n not in cache or (cache[n]["url"] is None and cache[n]["checked"] < recheck_before)]
    checked = 0
    for name in due[:MAX_LINK_CHECKS_PER_RUN]:
        try:
            if name.startswith("portal:"):
                url = find_route_page(name[len("portal:"):], PORTAL_PAGE_URL, "/portal/")
            else:
                url = find_route_page(name)
            cache[name] = {"url": url, "checked": today.isoformat()}
            checked += 1
        except Exception as error:
            # Zwift Insider trouble should never block the schedule and route update.
            print(f"::warning::Route link check stopped at {name!r}: {error}")
            break
    print(f"checked {checked} route links, {max(len(due) - checked, 0)} left for later runs")

    for route in routes:
        entry = cache.get(route["name"])
        route["link"] = LINK_OVERRIDES.get(route["name"]) or (entry["url"] if entry else None)
    for climb in climbs:
        entry = cache.get(f"portal:{climb['name']}")
        climb["link"] = entry["url"] if entry else None
    return dict(sorted(cache.items()))


def update_order(routes):
    """Give each route a permanent "index" from the append-only order file."""
    path = DATA_DIR / ORDER_FILE
    order = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    known = set(order)
    new_ids = sorted({r["id"] for r in routes} - known, key=int)
    order.extend(new_ids)
    if new_ids:
        print(f"added {len(new_ids)} new routes to {ORDER_FILE}")
    position = {route_id: i for i, route_id in enumerate(order)}
    for route in routes:
        route["index"] = position[route["id"]]
    return order


def build_portal(root):
    """Climbs by id plus the dated rotation (UTC start times), from PortalRoadSchedule_v1.xml."""
    climbs = {}
    for item in root.iter("PortalRoadMetadata"):
        climbs[item.get("id")] = {
            "name": item.get("name"),
            "distanceMeters": round(float(item.get("distanceCentimeters") or 0) / 100, 1),
            "ascentMeters": round(float(item.get("elevCentimeters") or 0) / 100, 1),
        }
    schedule = []
    for item in root.iter("appointment"):
        world = PORTAL_WORLDS.get(item.get("world"))
        if not world:
            alert(f"The climb portal schedule has an unknown world number {item.get('world')}; add it to PORTAL_WORLDS in scripts/update_data.py.")
            continue
        if item.get("road") not in climbs:
            raise ValueError(f"portal appointment for unknown climb {item.get('road')}")
        schedule.append({
            "start": parse_start(item.get("start")).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "world": world,
            "monthly": item.get("portal_of_month") == "true",
            "climbId": item.get("road"),
        })
    schedule.sort(key=lambda a: (a["start"], a["world"]))
    if not schedule:
        raise ValueError("climb portal schedule is empty")
    # Only keep climbs that are actually scheduled, so the file stays small.
    used = {a["climbId"] for a in schedule}
    return {"climbs": {k: v for k, v in sorted(climbs.items()) if k in used}, "schedule": schedule}


def load_portal():
    """Fetch the portal rotation; on trouble return None (the last good file is kept)."""
    try:
        return build_portal(fetch_xml(PORTAL_URL))
    except Exception as error:
        alert(f"Couldn't update the climb portal rotation ({error}). The site keeps the last good data.")
        return None


def fetch_text(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8", errors="replace")


def parse_weekly_month(page, year, month):
    """Return {date: {"route": (title, link), "climb": (title, link)}} for one month page."""
    # The legend maps category numbers to names, e.g. 367 -> Route of the Week.
    categories = {}
    for number, label in re.findall(r'data-category="(\d+)">(?:&nbsp;|\s)*([^<]+)</td>', page):
        kind = WEEKLY_CATEGORIES.get(html.unescape(label).strip())
        if kind:
            categories[number] = kind
    if set(categories.values()) != set(WEEKLY_CATEGORIES.values()):
        raise ValueError("category legend not found")
    days = {}
    for day, body in re.findall(r'<td class="spiffy-day-(\d+)[^"]*"[^>]*>(.*?)</td>', page, re.S):
        entries = {}
        for number, link, title in re.findall(
            r'class="calnk category_(\d+)[^"]*".*?<a href="([^"]*)"[^>]*>\s*<span class="spiffy-title">(.*?)</span>', body, re.S
        ):
            if number in categories:
                entries[categories[number]] = (html.unescape(title).strip(), link)
        if entries:
            days[date(year, month, int(day))] = entries
    return days


def split_reward(title):
    """'Volcano Flat (250 XP)' -> ('Volcano Flat', '250 XP')."""
    match = re.match(r"^(.*?)\s*\(([^()]*(?:XP|Drops))\)$", title)
    return (match.group(1), match.group(2)) if match else (title, None)


def build_weekly(routes):
    """Route and Climb of the Week by week (weeks start Monday), for last, this and next month."""
    today = datetime.now(timezone.utc).date()
    first = today.replace(day=1)
    months = [(first - timedelta(days=1)).replace(day=1), first, (first + timedelta(days=32)).replace(day=1)]
    days = {}
    for m in months:
        page = fetch_text(WEEKLY_URL.format(month=m.strftime("%b").lower(), year=m.year))
        days.update(parse_weekly_month(page, m.year, m.month))
    if not any(d.month == first.month for d in days):
        raise ValueError(f"no weekly challenges found for {first:%B %Y}")

    by_name = {r["name"].lower(): r for r in routes}
    weeks = {}
    for day in sorted(days):
        start = day - timedelta(days=day.weekday())
        week = weeks.setdefault(start.isoformat(), {"start": start.isoformat()})
        for kind, (title, link) in days[day].items():
            if kind in week:
                continue
            name, reward = split_reward(title)
            entry = {"name": name, "reward": reward, "link": link or None}
            if kind == "route":
                # Zwift Insider drops the "Watopia" prefix some route names carry.
                match = by_name.get(name.lower()) or by_name.get(f"watopia {name.lower()}")
                entry["routeId"] = match["id"] if match else None
            week[kind] = entry
    return {"switchesAt": "Mondays 12:00 US Eastern", "weeks": [weeks[k] for k in sorted(weeks)]}


def update_weekly(routes):
    """Refresh weekly.json; on trouble keep the last good file and raise an alert."""
    try:
        weekly = build_weekly(routes)
    except Exception as error:
        alert(f"Couldn't update Route and Climb of the Week from Zwift Insider ({error}). The site keeps the last good data; the page layout may have changed.")
        return
    this_week = (datetime.now(timezone.utc).date() - timedelta(days=datetime.now(timezone.utc).date().weekday())).isoformat()
    current = next((w for w in weekly["weeks"] if w["start"] == this_week), None)
    if not current or "route" not in current or "climb" not in current:
        alert("Zwift Insider's calendar has no Route or Climb of the Week for this week.")
    unmatched = [w["route"]["name"] for w in weekly["weeks"] if "route" in w and not w["route"]["routeId"]]
    if unmatched:
        print(f"::notice::Weekly routes not matched to routes.json: {', '.join(unmatched)}")
    write_json(WEEKLY_FILE, weekly)


def write_json(name, payload):
    path = DATA_DIR / name
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(DATA_DIR.parent)}")


def main():
    # Build everything first so a failure leaves the existing files untouched.
    schedule = build_schedule(fetch_xml(SCHEDULE_URL))
    routes = build_routes(fetch_xml(DICTIONARY_URL))
    DATA_DIR.mkdir(exist_ok=True)
    order = update_order(routes["routes"])
    portal = load_portal()
    links = update_links(routes["routes"], portal["climbs"].values() if portal else ())
    write_json("schedule.json", schedule)
    write_json("routes.json", routes)
    write_json(LINKS_FILE, links)
    if portal:
        write_json(PORTAL_FILE, portal)
    update_weekly(routes["routes"])
    # One ID per line keeps diffs readable as routes are added.
    (DATA_DIR / ORDER_FILE).write_text("[\n" + ",\n".join(json.dumps(i) for i in order) + "\n]\n", encoding="utf-8")
    print(f"wrote data/{ORDER_FILE}")
    print(f"{len(schedule['appointments'])} appointments, {len(routes['routes'])} routes")
    write_alerts()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"update failed: {error}", file=sys.stderr)
        sys.exit(1)
