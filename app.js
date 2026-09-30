// Where to Zwift Today: picks a random route from the worlds active right now.
// Data comes from data/*.json, refreshed daily by the "Update Zwift data" Action.

const WORLD_NAMES = {
  WATOPIA: "Watopia",
  MAKURIISLANDS: "Makuri Islands",
  NEWYORK: "New York",
  LONDON: "London",
  RICHMOND: "Richmond",
  INNSBRUCK: "Innsbruck",
  YORKSHIRE: "Yorkshire",
  SCOTLAND: "Scotland",
  FRANCE: "France",
  PARIS: "Paris",
};

// A schedule slot normally lasts about 2 days. If the newest slot is older than
// this and nothing follows it, the schedule has not been published yet.
const MAX_SLOT_MS = 4 * 24 * 60 * 60 * 1000;
const NEW_ROUTE_DAYS = 30;

const els = {
  worlds: document.getElementById("worlds"),
  pick: document.getElementById("pick"),
  count: document.getElementById("count"),
  result: document.getElementById("result"),
};

let routes = [];
let activeWorlds = [];
let lastPickId = null;

function worldName(code) {
  if (WORLD_NAMES[code]) return WORLD_NAMES[code];
  // Unknown new world: turn "SOMENEWPLACE" into "Somenewplace".
  return code.charAt(0) + code.slice(1).toLowerCase();
}

// Current time; "?now=2026-10-05T12:00Z" in the URL overrides it for testing.
function getNow() {
  const override = new URLSearchParams(location.search).get("now");
  const date = override ? new Date(override) : new Date();
  return isNaN(date) ? new Date() : date;
}

// Today's date in US Eastern as YYYY-MM-DD, matching Zwift's day boundary.
function easternDate(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(date);
}

function findActiveWorlds(schedule, now) {
  const started = schedule.appointments.filter((a) => new Date(a.start) <= now);
  const current = started[started.length - 1];
  const hasNext = schedule.appointments.length > started.length;
  if (!current || (!hasNext && now - new Date(current.start) > MAX_SLOT_MS)) {
    return { worlds: [...schedule.alwaysActive], known: false };
  }
  const worlds = [...new Set([...schedule.alwaysActive, ...current.worlds])];
  return { worlds, known: true };
}

function selectedSport() {
  return document.querySelector('input[name="sport"]:checked').value;
}

function eligibleRoutes(today) {
  const sport = selectedSport();
  return routes.filter((r) =>
    activeWorlds.includes(r.map) &&
    r[sport] &&
    !r.eventOnly &&
    (!r.publishedOn || r.publishedOn <= today)
  );
}

function daysBetween(fromDate, toDate) {
  return (new Date(toDate) - new Date(fromDate)) / (24 * 60 * 60 * 1000);
}

function formatDistance(meters) {
  const km = meters / 1000;
  return `${km.toFixed(1)} km (${(km * 0.621371).toFixed(1)} mi)`;
}

function formatAscent(meters) {
  return `${Math.round(meters)} m (${Math.round(meters * 3.28084)} ft)`;
}

function updateCount() {
  const today = easternDate(getNow());
  const n = eligibleRoutes(today).length;
  els.count.textContent = `${n} route${n === 1 ? "" : "s"} to choose from.`;
  els.pick.disabled = n === 0;
}

function pickRoute() {
  const today = easternDate(getNow());
  const pool = eligibleRoutes(today);
  if (pool.length === 0) return;
  // Avoid showing the same route twice in a row when there is a choice.
  const choices = pool.length > 1 ? pool.filter((r) => r.id !== lastPickId) : pool;
  const route = choices[Math.floor(Math.random() * choices.length)];
  lastPickId = route.id;
  renderRoute(route, today);
  els.pick.textContent = "Pick again";
}

function renderRoute(route, today) {
  const tags = [];
  if (route.publishedOn && daysBetween(route.publishedOn, today) <= NEW_ROUTE_DAYS) tags.push("New");
  if (route.levelLocked) tags.push("Level locked");

  els.result.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = route.name;
  const world = document.createElement("p");
  world.textContent = worldName(route.map);
  for (const tag of tags) {
    const span = document.createElement("span");
    span.className = "tag";
    span.textContent = tag;
    world.append(" ", span);
  }

  const details = document.createElement("dl");
  const rows = [
    ["Distance", formatDistance(route.distanceMeters)],
    ["Climbing", formatAscent(route.ascentMeters)],
    ["Lead-in", `${formatDistance(route.leadinDistanceMeters)}, ${formatAscent(route.leadinAscentMeters)}`],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    details.append(dt, dd);
  }

  els.result.append(title, world, details);
  els.result.hidden = false;
}

function restoreSport() {
  try {
    const saved = localStorage.getItem("sport");
    const input = saved && document.querySelector(`input[name="sport"][value="${saved}"]`);
    if (input) input.checked = true;
  } catch (e) { /* storage unavailable; keep the default */ }
}

function saveSport() {
  try { localStorage.setItem("sport", selectedSport()); } catch (e) { /* ignore */ }
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function init() {
  restoreSport();
  try {
    const [schedule, routeData] = await Promise.all([
      loadJson("data/schedule.json"),
      loadJson("data/routes.json"),
    ]);
    routes = routeData.routes;
    const active = findActiveWorlds(schedule, getNow());
    activeWorlds = active.worlds;
    const names = activeWorlds.map(worldName).join(", ");
    if (active.known) {
      els.worlds.textContent = `Today's worlds: ${names}`;
    } else {
      els.worlds.className = "notice";
      els.worlds.textContent = `Zwift hasn't published today's guest worlds yet, so picks come from ${names} only.`;
    }
    updateCount();
  } catch (error) {
    els.worlds.className = "notice";
    els.worlds.textContent = "Couldn't load route data. Please try again later.";
    console.error(error);
    return;
  }

  els.pick.addEventListener("click", pickRoute);
  document.querySelectorAll('input[name="sport"]').forEach((input) =>
    input.addEventListener("change", () => {
      saveSport();
      updateCount();
      els.result.hidden = true;
      els.pick.textContent = "Pick a route";
    })
  );
}

init();
