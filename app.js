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
const SPORT_NAMES = { cycling: "Ride", running: "Run" };
const PROGRESS_HASH = "progress";
const PROGRESS_VERSION = "v1";
const TABS = ["spin", "completed"];

const els = {
  worlds: document.getElementById("worlds"),
  pick: document.getElementById("pick"),
  count: document.getElementById("count"),
  result: document.getElementById("result"),
  clear: document.getElementById("clear"),
  filters: FILTER_IDS.map((id) => document.getElementById(id)),
  progressSummary: document.getElementById("progress-summary"),
  checklist: document.getElementById("checklist"),
  copyProgress: document.getElementById("copy-progress"),
  clearProgress: document.getElementById("clear-progress"),
  progressMessage: document.getElementById("progress-message"),
  progressLink: document.getElementById("progress-link"),
  themeToggle: document.getElementById("theme-toggle"),
};

let routes = [];
let activeWorlds = [];
let lastPickId = null;
let shownRoute = null;
// Today's worlds picked on the chips; empty means all of them. Not saved,
// since the worlds change daily.
let selectedWorlds = new Set();
// Completed route IDs per sport; Zwift awards separate Ride and Run badges.
let done = { cycling: new Set(), running: new Set() };

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

function badgeMode() {
  return document.querySelector('input[name="badges"]:checked').value;
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

// Routes that can earn a badge for this sport today, in any world.
function badgeRoutes(sport, today) {
  return routes.filter((r) => r[sport] && !r.eventOnly && (!r.publishedOn || r.publishedOn <= today));
}

// ignoreDone: include completed routes even in "Not done yet" mode.
// world: count for one world instead of the chip selection (used by the chips).
function eligibleRoutes(today, { ignoreDone = false, world = null } = {}) {
  const sport = selectedSport();
  const limits = readFilters();
  const skipDone = !ignoreDone && badgeMode() === "undone";
  return badgeRoutes(sport, today).filter((r) =>
    (world ? r.map === world : selectedWorlds.size ? selectedWorlds.has(r.map) : activeWorlds.includes(r.map)) &&
    withinLimits(r, limits) &&
    !(skipDone && done[sport].has(r.id))
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
  } else if (n === 0 && eligibleRoutes(today, { ignoreDone: true }).length > 0) {
    els.count.textContent = "You've done every route that fits. Nice work! Widen the filters or switch to Any route.";
  } else if (n === 0) {
    els.count.textContent = "No routes match. Try widening the filters.";
  } else {
    const where = selectedWorlds.size ? ` in ${listNames([...selectedWorlds].map(worldName))}` : "";
    els.count.textContent = `${n} route${n === 1 ? "" : "s"} to choose from${where}.`;
  }
  els.pick.disabled = n === 0;
  updateWorldChips(today);
  // Keep the shown route only if it still matches. Marking it done doesn't
  // count against it, so the card stays up after pressing "Mark as done".
  const keep = eligibleRoutes(today, { ignoreDone: true });
  if (shownRoute && !keep.some((r) => r.id === shownRoute.id)) hideResult();
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
  const sport = selectedSport();
  const isDone = done[sport].has(route.id);
  if (isDone) tags.push("Done");

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
  const mark = document.createElement("button");
  mark.type = "button";
  mark.id = "mark-done";
  mark.className = "btn";
  mark.textContent = isDone ? "Marked as done (undo)" : "Mark as done";
  mark.addEventListener("click", () => setDone(sport, [route.id], !isDone));
  els.result.append(mark);
  els.result.hidden = false;
  shownRoute = route;
}

// ---- Tabs ----
// Tabs live in the URL hash (#spin, #completed) so back and bookmarks work.
// Progress links also use the hash (#progress=...); those open Completed.

function showTab(name) {
  const tab = TABS.includes(name) ? name : "spin";
  for (const t of TABS) {
    const selected = t === tab;
    document.getElementById(`tab-${t}`).setAttribute("aria-selected", String(selected));
    document.getElementById(`panel-${t}`).hidden = !selected;
  }
}

function handleHash() {
  // A progress link can only be decoded once the route list has loaded.
  if (location.hash.startsWith(`#${PROGRESS_HASH}=`) && routes.length) {
    loadProgressFromLink();
    renderChecklist();
    updateCount();
    showTab("completed");
  } else {
    showTab(location.hash.slice(1));
  }
}

// ---- Light and dark theme ----
// No saved choice means "follow the device". The toggle saves an explicit choice.

function currentTheme() {
  const saved = document.documentElement.dataset.theme;
  if (saved) return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateThemeButton() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  els.themeToggle.setAttribute("aria-label", `Switch to ${next} mode`);
}

function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
  updateThemeButton();
}

// ---- Completed routes ----

function loadDone() {
  try {
    const saved = JSON.parse(localStorage.getItem("done") || "null");
    if (saved) done = { cycling: new Set(saved.cycling || []), running: new Set(saved.running || []) };
  } catch (e) { /* start empty */ }
}

function saveDone() {
  try {
    localStorage.setItem("done", JSON.stringify({ cycling: [...done.cycling], running: [...done.running] }));
  } catch (e) { /* ignore */ }
}

function setDone(sport, ids, value) {
  for (const id of ids) {
    if (value) done[sport].add(id);
    else done[sport].delete(id);
  }
  saveDone();
  renderChecklist();
  updateCount();
}

function worldOrder(a, b) {
  if (a === "WATOPIA") return -1;
  if (b === "WATOPIA") return 1;
  return worldName(a).localeCompare(worldName(b));
}

function renderChecklist() {
  const sport = selectedSport();
  const today = easternDate(getNow());
  const list = badgeRoutes(sport, today);
  const doneCount = list.filter((r) => done[sport].has(r.id)).length;
  els.progressSummary.textContent = `${doneCount} of ${list.length} ${SPORT_NAMES[sport]}`;
  document.querySelectorAll(".sport-name").forEach((el) => { el.textContent = SPORT_NAMES[sport]; });

  const byWorld = new Map();
  for (const route of list) {
    if (!byWorld.has(route.map)) byWorld.set(route.map, []);
    byWorld.get(route.map).push(route);
  }

  els.checklist.replaceChildren();
  for (const world of [...byWorld.keys()].sort(worldOrder)) {
    const worldRoutes = byWorld.get(world).sort((a, b) => a.name.localeCompare(b.name));
    const ids = worldRoutes.map((r) => r.id);
    const worldDone = ids.filter((id) => done[sport].has(id)).length;

    const group = document.createElement("fieldset");
    group.className = "world";
    const legend = document.createElement("legend");
    const allLabel = document.createElement("label");
    const all = document.createElement("input");
    all.type = "checkbox";
    all.checked = worldDone === ids.length;
    all.indeterminate = worldDone > 0 && worldDone < ids.length;
    all.setAttribute("aria-label", `All ${worldName(world)} routes`);
    all.addEventListener("change", () => setDone(sport, ids, all.checked));
    allLabel.append(all, ` ${worldName(world)} (${worldDone} of ${ids.length})`);
    legend.append(allLabel);

    const ul = document.createElement("ul");
    for (const route of worldRoutes) {
      const li = document.createElement("li");
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = done[sport].has(route.id);
      box.dataset.id = route.id;
      box.addEventListener("change", () => setDone(sport, [route.id], box.checked));
      label.append(box, ` ${route.name}`);
      li.append(label);
      ul.append(li);
    }
    group.append(legend, ul);
    els.checklist.append(group);
  }
}

// Progress links pack one bit per route, using each route's permanent index
// from data/route-order.json, then base64url-encode the bytes.
function encodeDone(ids) {
  const indexes = routes.filter((r) => ids.has(r.id)).map((r) => r.index);
  const bytes = new Uint8Array(indexes.length ? Math.max(...indexes) + 8 >> 3 : 0);
  for (const i of indexes) bytes[i >> 3] |= 1 << (i & 7);
  let text = "";
  bytes.forEach((b) => { text += String.fromCharCode(b); });
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeDone(code) {
  const text = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
  const byIndex = new Map(routes.map((r) => [r.index, r.id]));
  const ids = new Set();
  for (let byte = 0; byte < text.length; byte++) {
    const bits = text.charCodeAt(byte);
    for (let bit = 0; bit < 8; bit++) {
      const id = (bits & (1 << bit)) && byIndex.get(byte * 8 + bit);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function progressLink() {
  const code = `${PROGRESS_VERSION}.${encodeDone(done.cycling)}.${encodeDone(done.running)}`;
  return `${location.origin}${location.pathname}#${PROGRESS_HASH}=${code}`;
}

// Loads progress from a "#progress=v1.<ride>.<run>" link, asking before it replaces anything.
function loadProgressFromLink() {
  const match = location.hash.match(new RegExp(`^#${PROGRESS_HASH}=([^&]*)`));
  if (!match) return;
  history.replaceState(null, "", `${location.pathname}${location.search}#completed`);
  let incoming;
  try {
    const [version, ride, run] = match[1].split(".");
    if (version !== PROGRESS_VERSION) throw new Error("unknown version");
    incoming = { cycling: decodeDone(ride || ""), running: decodeDone(run || "") };
  } catch (e) {
    els.progressMessage.textContent = "That progress link looks damaged, so nothing was loaded.";
    return;
  }
  const hasExisting = done.cycling.size + done.running.size > 0;
  const question = `Load progress from this link? It has ${incoming.cycling.size} Ride and ${incoming.running.size} Run routes, ` +
    "and will replace the progress saved on this device.";
  if (hasExisting && !window.confirm(question)) return;
  done = incoming;
  saveDone();
  els.progressMessage.textContent = `Progress loaded: ${done.cycling.size} Ride and ${done.running.size} Run routes.`;
}

async function copyProgressLink() {
  const link = progressLink();
  els.progressLink.value = link;
  try {
    await navigator.clipboard.writeText(link);
    els.progressLink.hidden = true;
    els.progressMessage.textContent = "Link copied. Open it on another device, or bookmark it as a backup.";
  } catch (e) {
    // Clipboard blocked: show the link so it can be copied by hand.
    els.progressLink.hidden = false;
    els.progressLink.select();
    els.progressMessage.textContent = "Copy this link, then open it on another device or bookmark it:";
  }
}

function clearProgress() {
  const sport = selectedSport();
  const n = done[sport].size;
  if (n === 0) return;
  if (!window.confirm(`Clear all ${n} completed ${SPORT_NAMES[sport]} routes on this device?`)) return;
  setDone(sport, [...done[sport]], false);
  els.progressMessage.textContent = `${SPORT_NAMES[sport]} progress cleared.`;
}

// Per-device settings. Storage can be unavailable (private mode), so failures are ignored.
function restoreSettings() {
  try {
    for (const name of ["sport", "units", "badges"]) {
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
    localStorage.setItem("badges", badgeMode());
    localStorage.setItem("filters", JSON.stringify(readFilters()));
  } catch (e) { /* ignore */ }
}

function updateUnitLabels() {
  const metric = selectedUnits() === "metric";
  document.querySelector(".unit-distance").textContent = metric ? "km" : "mi";
  document.querySelector(".unit-climbing").textContent = metric ? "m" : "ft";
}

function renderWorlds(active, alwaysActive) {
  if (!active.known) {
    const notice = document.createElement("p");
    notice.className = "notice";
    notice.textContent = `Zwift hasn't published today's guest worlds yet, so picks come from ${active.worlds.map(worldName).join(", ")} only.`;
    els.worlds.replaceChildren(notice);
    return;
  }
  const list = document.createElement("ul");
  list.className = "world-chips";
  for (const world of active.worlds) {
    const li = document.createElement("li");
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "world-chip";
    chip.dataset.world = world;
    chip.setAttribute("aria-pressed", "false");
    const name = document.createElement("span");
    name.textContent = worldName(world);
    const count = document.createElement("span");
    count.className = "chip-count";
    chip.append(name, count);
    if (alwaysActive.includes(world)) chip.title = "Always available";
    chip.addEventListener("click", () => toggleWorld(world));
    li.append(chip);
    list.append(li);
  }
  const all = document.createElement("button");
  all.type = "button";
  all.id = "all-worlds";
  all.className = "link-button";
  all.textContent = "All worlds";
  all.hidden = true;
  all.addEventListener("click", () => {
    selectedWorlds.clear();
    worldsChanged();
  });
  const hint = document.createElement("p");
  hint.className = "muted small world-hint";
  hint.textContent = "Tap worlds to spin only their routes.";
  els.worlds.replaceChildren(list, hint);
  hint.append(" ", all);
}

function toggleWorld(world) {
  if (selectedWorlds.has(world)) selectedWorlds.delete(world);
  else selectedWorlds.add(world);
  // Every world selected is the same as no selection.
  if (selectedWorlds.size === activeWorlds.length) selectedWorlds.clear();
  worldsChanged();
}

function worldsChanged() {
  // Keep the shown route only if its world is still in the spin.
  if (shownRoute && selectedWorlds.size && !selectedWorlds.has(shownRoute.map)) hideResult();
  updateCount();
}

// "A", "A and B", "A, B and C"
function listNames(names) {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Pressed state plus a live count of matching routes on each chip.
function updateWorldChips(today) {
  for (const chip of els.worlds.querySelectorAll(".world-chip")) {
    const world = chip.dataset.world;
    const n = eligibleRoutes(today, { world }).length;
    chip.querySelector(".chip-count").textContent = String(n);
    chip.setAttribute("aria-pressed", String(selectedWorlds.has(world)));
    chip.setAttribute("aria-label", `${worldName(world)}, ${n} route${n === 1 ? "" : "s"}`);
    chip.classList.toggle("dimmed", selectedWorlds.size > 0 && !selectedWorlds.has(world));
  }
  const all = document.getElementById("all-worlds");
  if (all) all.hidden = selectedWorlds.size === 0;
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function init() {
  updateThemeButton();
  els.themeToggle.addEventListener("click", toggleTheme);
  // Tab links and pasted progress links only change the hash, which doesn't
  // reload the page.
  window.addEventListener("hashchange", handleHash);
  showTab(location.hash.startsWith(`#${PROGRESS_HASH}=`) ? "completed" : location.hash.slice(1));
  restoreSettings();
  loadDone();
  try {
    const [schedule, routeData] = await Promise.all([
      loadJson("data/schedule.json"),
      loadJson("data/routes.json"),
    ]);
    routes = routeData.routes;
    const active = findActiveWorlds(schedule, getNow());
    activeWorlds = active.worlds;
    renderWorlds(active, schedule.alwaysActive);
    renderChecklist();
    updateCount();
    handleHash();
  } catch (error) {
    const notice = document.createElement("p");
    notice.className = "notice";
    notice.textContent = "Couldn't load route data. Please try again later.";
    els.worlds.replaceChildren(notice);
    console.error(error);
    return;
  }

  els.pick.addEventListener("click", pickRoute);
  document.querySelectorAll('input[name="sport"]').forEach((input) =>
    input.addEventListener("change", () => {
      saveSettings();
      hideResult();
      renderChecklist();
      els.progressLink.hidden = true;
      els.progressMessage.textContent = "";
      updateCount();
    })
  );

  document.querySelectorAll('input[name="badges"]').forEach((input) =>
    input.addEventListener("change", () => {
      saveSettings();
      updateCount();
    })
  );


  els.copyProgress.addEventListener("click", copyProgressLink);
  els.clearProgress.addEventListener("click", clearProgress);

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
