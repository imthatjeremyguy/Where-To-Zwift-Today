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

const METERS_PER_KM = 1000;
const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;
const FILTER_IDS = ["min-distance", "max-distance", "min-climbing", "max-climbing"];

const els = {
  worlds: document.getElementById("worlds"),
  pick: document.getElementById("pick"),
  count: document.getElementById("count"),
  result: document.getElementById("result"),
  clear: document.getElementById("clear"),
  filters: FILTER_IDS.map((id) => document.getElementById(id)),
};

let routes = [];
let activeWorlds = [];
let lastPickId = null;
let shownRoute = null;

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

function selectedUnits() {
  return document.querySelector('input[name="units"]:checked').value;
}

// Filter boxes show the chosen units; everything else works in meters.
function toMeters(value, kind, units) {
  if (kind === "distance") return value * (units === "metric" ? METERS_PER_KM : METERS_PER_MILE);
  return units === "metric" ? value : value / FEET_PER_METER;
}

function fromMeters(meters, kind, units) {
  if (kind === "distance") return meters / (units === "metric" ? METERS_PER_KM : METERS_PER_MILE);
  return units === "metric" ? meters : meters * FEET_PER_METER;
}

// Returns {min-distance: meters or null, ...} from the filter boxes.
function readFilters(units = selectedUnits()) {
  const limits = {};
  for (const input of els.filters) {
    const value = input.value.trim() === "" ? NaN : Number(input.value);
    limits[input.id] = Number.isFinite(value) && value >= 0 ? toMeters(value, input.dataset.kind, units) : null;
  }
  return limits;
}

function writeFilters(limits, units = selectedUnits()) {
  for (const input of els.filters) {
    const meters = limits[input.id];
    if (meters == null) {
      input.value = "";
    } else {
      const value = fromMeters(meters, input.dataset.kind, units);
      input.value = input.dataset.kind === "distance" ? String(Math.round(value * 10) / 10) : String(Math.round(value));
    }
  }
}

function limitsConflict(limits) {
  const over = (min, max) => limits[min] != null && limits[max] != null && limits[min] > limits[max];
  return over("min-distance", "max-distance") || over("min-climbing", "max-climbing");
}

function totalDistance(route) {
  return route.distanceMeters + route.leadinDistanceMeters;
}

function totalClimbing(route) {
  return route.ascentMeters + route.leadinAscentMeters;
}

function withinLimits(route, limits) {
  const inRange = (value, min, max) =>
    (limits[min] == null || value >= limits[min]) && (limits[max] == null || value <= limits[max]);
  return inRange(totalDistance(route), "min-distance", "max-distance") &&
    inRange(totalClimbing(route), "min-climbing", "max-climbing");
}

function eligibleRoutes(today) {
  const sport = selectedSport();
  const limits = readFilters();
  return routes.filter((r) =>
    activeWorlds.includes(r.map) &&
    r[sport] &&
    !r.eventOnly &&
    (!r.publishedOn || r.publishedOn <= today) &&
    withinLimits(r, limits)
  );
}

function daysBetween(fromDate, toDate) {
  return (new Date(toDate) - new Date(fromDate)) / (24 * 60 * 60 * 1000);
}

// Shows the chosen units first and the other system in brackets.
function formatDistance(meters) {
  const km = `${(meters / METERS_PER_KM).toFixed(1)} km`;
  const mi = `${(meters / METERS_PER_MILE).toFixed(1)} mi`;
  return selectedUnits() === "metric" ? `${km} (${mi})` : `${mi} (${km})`;
}

function formatAscent(meters) {
  const m = `${Math.round(meters)} m`;
  const ft = `${Math.round(meters * FEET_PER_METER)} ft`;
  return selectedUnits() === "metric" ? `${m} (${ft})` : `${ft} (${m})`;
}

function updateCount() {
  const today = easternDate(getNow());
  const pool = eligibleRoutes(today);
  const n = pool.length;
  if (limitsConflict(readFilters())) {
    els.count.textContent = "A minimum is higher than its maximum.";
  } else if (n === 0) {
    els.count.textContent = "No routes match. Try widening the filters.";
  } else {
    els.count.textContent = `${n} route${n === 1 ? "" : "s"} to choose from.`;
  }
  els.pick.disabled = n === 0;
  // Keep the shown route only if it still matches.
  if (shownRoute && !pool.some((r) => r.id === shownRoute.id)) hideResult();
  else if (shownRoute) renderRoute(shownRoute, today);
}

function hideResult() {
  shownRoute = null;
  els.result.hidden = true;
  els.pick.textContent = "Pick a route";
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
    ["Total", `${formatDistance(totalDistance(route))}, ${formatAscent(totalClimbing(route))}`],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    details.append(dt, dd);
  }

  els.result.append(title, world, details);
  if (route.link) {
    const more = document.createElement("p");
    const link = document.createElement("a");
    link.href = route.link;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Map and details on Zwift Insider";
    more.append(link);
    els.result.append(more);
  }
  els.result.hidden = false;
  shownRoute = route;
}

// Per-device settings. Storage can be unavailable (private mode), so failures are ignored.
function restoreSettings() {
  try {
    for (const name of ["sport", "units"]) {
      const saved = localStorage.getItem(name);
      const input = saved && document.querySelector(`input[name="${name}"][value="${saved}"]`);
      if (input) input.checked = true;
    }
    const limits = JSON.parse(localStorage.getItem("filters") || "null");
    if (limits) writeFilters(limits);
  } catch (e) { /* keep the defaults */ }
  updateUnitLabels();
}

function saveSettings() {
  try {
    localStorage.setItem("sport", selectedSport());
    localStorage.setItem("units", selectedUnits());
    localStorage.setItem("filters", JSON.stringify(readFilters()));
  } catch (e) { /* ignore */ }
}

function updateUnitLabels() {
  const metric = selectedUnits() === "metric";
  document.querySelector(".unit-distance").textContent = metric ? "km" : "mi";
  document.querySelector(".unit-climbing").textContent = metric ? "m" : "ft";
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function init() {
  restoreSettings();
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
      saveSettings();
      hideResult();
      updateCount();
    })
  );

  // Remember the units the boxes were in, so switching converts the typed values.
  let previousUnits = selectedUnits();
  document.querySelectorAll('input[name="units"]').forEach((input) =>
    input.addEventListener("change", () => {
      writeFilters(readFilters(previousUnits));
      previousUnits = selectedUnits();
      updateUnitLabels();
      saveSettings();
      updateCount();
    })
  );

  for (const input of els.filters) {
    input.addEventListener("input", () => {
      saveSettings();
      updateCount();
    });
  }

  els.clear.addEventListener("click", () => {
    writeFilters({});
    saveSettings();
    updateCount();
  });
}

init();
