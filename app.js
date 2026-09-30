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
const TABS = ["spin", "calendar", "completed", "help"];

const els = {
  worlds: document.getElementById("worlds"),
  pick: document.getElementById("pick"),
  count: document.getElementById("count"),
  result: document.getElementById("result"),
  clear: document.getElementById("clear"),
  filters: FILTER_IDS.map((id) => document.getElementById(id)),
  progressSummary: document.getElementById("progress-summary"),
  progressBar: document.getElementById("progress-bar"),
  checklist: document.getElementById("checklist"),
  copyProgress: document.getElementById("copy-progress"),
  clearProgress: document.getElementById("clear-progress"),
  progressMessage: document.getElementById("progress-message"),
  progressLink: document.getElementById("progress-link"),
  themeToggle: document.getElementById("theme-toggle"),
  reel: document.getElementById("reel"),
  reelStrip: document.getElementById("reel-strip"),
  settings: document.getElementById("settings"),
  settingsSummary: document.getElementById("settings-summary"),
};

let routes = [];
let activeWorlds = [];
let lastPickId = null;
let shownRoute = null;
// Today's worlds picked on the chips; empty means all of them. Not saved,
// since the worlds change daily.
let selectedWorlds = new Set();
// Terrain (Flat/Rolling/Hilly) and route type (loop/p2p) pills; empty means any.
const shape = { terrain: new Set(), type: new Set() };
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
    matchesShape(r) &&
    !(skipDone && done[sport].has(r.id))
  );
}

function matchesShape(route) {
  return (shape.terrain.size === 0 || shape.terrain.has(terrain(route))) &&
    (shape.type.size === 0 || shape.type.has(route.loop ? "loop" : "p2p"));
}

function updatePills() {
  document.querySelectorAll(".pill-toggle").forEach((pill) => {
    pill.setAttribute("aria-pressed", String(shape[pill.dataset.shape].has(pill.dataset.value)));
  });
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
  els.pick.disabled = n === 0 || spinning;
  updateWorldChips(today);
  updateSettingsSummary();
  // Keep the shown route only if it still matches. Marking it done doesn't
  // count against it, so the card stays up after pressing "Mark as done".
  const keep = eligibleRoutes(today, { ignoreDone: true });
  if (shownRoute && !keep.some((r) => r.id === shownRoute.id)) hideResult();
  else if (shownRoute) renderRoute(shownRoute, today);
}

// One line under the Pick button, e.g. "Ride · Not done yet · 20 to 40 km".
// Shown on phones, where the settings sit below the spin area.
function updateSettingsSummary() {
  const limits = readFilters();
  const units = selectedUnits();
  const unit = (kind) => (kind === "distance" ? (units === "metric" ? "km" : "mi") : (units === "metric" ? "m" : "ft"));
  const show = (meters, kind) => {
    const value = fromMeters(meters, kind, units);
    return kind === "distance" ? String(Math.round(value * 10) / 10) : String(Math.round(value));
  };
  const range = (kind, suffix = "") => {
    const min = limits[`min-${kind}`];
    const max = limits[`max-${kind}`];
    if (min != null && max != null) return `${show(min, kind)} to ${show(max, kind)} ${unit(kind)}${suffix}`;
    if (min != null) return `at least ${show(min, kind)} ${unit(kind)}${suffix}`;
    if (max != null) return `up to ${show(max, kind)} ${unit(kind)}${suffix}`;
    return null;
  };
  const parts = [SPORT_NAMES[selectedSport()], badgeMode() === "undone" ? "Not done yet" : "Any route"];
  const typeNames = { loop: "Loop", p2p: "Point to point" };
  const filters = [
    // Fixed order so the summary reads the same whichever pill was tapped first.
    shape.terrain.size ? ["Flat", "Rolling", "Hilly"].filter((t) => shape.terrain.has(t)).join(" or ") : null,
    shape.type.size ? ["loop", "p2p"].filter((t) => shape.type.has(t)).map((t) => typeNames[t]).join(" or ") : null,
    range("distance"),
    range("climbing", " climbing"),
  ].filter(Boolean);
  parts.push(filters.length ? filters.join(", ") : "no limits");
  els.settingsSummary.textContent = parts.join(" · ");
}

function hideResult() {
  shownRoute = null;
  els.result.hidden = true;
  els.pick.textContent = "Spin";
  if (!spinning) setReel(REEL_IDLE);
}

// ---- Spinner and result card ----

// Terrain from climbing per km of the route itself (lead-in excluded).
const TERRAIN_BANDS = [[5, "Flat"], [10, "Rolling"], [Infinity, "Hilly"]];
// Bigger pools spin longer and show more names, within limits.
function spinLength(poolSize) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return {
    ms: clamp(1300 + poolSize * 8, 1300, 3000),
    filler: clamp(12 + Math.round(poolSize / 3), 12, 70), // names that fly past before the pick lands
  };
}
let spinning = false;

function terrain(route) {
  const perKm = route.ascentMeters / Math.max(route.distanceMeters / 1000, 0.1);
  return TERRAIN_BANDS.find(([limit]) => perKm < limit)[1];
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function reelItem(text) {
  const li = document.createElement("li");
  li.textContent = text;
  return li;
}

// Show a name in the middle row, optionally with neighbors above and below.
function setReel(text, above = "", below = "") {
  els.reelStrip.getAnimations().forEach((a) => a.cancel());
  els.reelStrip.style.transform = "";
  els.reelStrip.replaceChildren(reelItem(above), reelItem(text), reelItem(below));
  els.reel.classList.toggle("idle", !shownRoute && text === REEL_IDLE);
}

const REEL_IDLE = "Ready to ride?";

function pickRoute() {
  if (spinning) return;
  const today = easternDate(getNow());
  const pool = eligibleRoutes(today);
  if (pool.length === 0) return;
  // Avoid showing the same route twice in a row when there is a choice.
  const choices = pool.length > 1 ? pool.filter((r) => r.id !== lastPickId) : pool;
  const route = choices[Math.floor(Math.random() * choices.length)];
  lastPickId = route.id;

  if (prefersReducedMotion()) {
    setReel(route.name);
    renderRoute(route, today);
    els.pick.textContent = "Spin again";
    return;
  }

  // Build a strip of random names from the pool ending on the pick, then
  // slide it up so the pick lands in the middle row.
  const { ms, filler } = spinLength(pool.length);
  const names = [""];
  for (let i = 0; i < filler; i++) names.push(pool[Math.floor(Math.random() * pool.length)].name);
  const after = pool[Math.floor(Math.random() * pool.length)].name;
  names.push(route.name, after);
  els.reelStrip.getAnimations().forEach((a) => a.cancel());
  els.reelStrip.style.transform = "";
  els.reelStrip.replaceChildren(...names.map(reelItem));
  els.reel.classList.remove("idle");
  const rowHeight = els.reelStrip.firstElementChild.getBoundingClientRect().height;
  const distance = (names.length - 3) * rowHeight;

  spinning = true;
  els.pick.disabled = true;
  els.reel.classList.add("spinning");
  const animation = els.reelStrip.animate(
    [{ transform: "translateY(0)" }, { transform: `translateY(${-distance}px)` }],
    { duration: ms, easing: "cubic-bezier(0.12, 0.8, 0.22, 1)", fill: "forwards" }
  );
  animation.onfinish = () => {
    spinning = false;
    els.reel.classList.remove("spinning");
    // Freeze on the landing position, keeping the neighbors in view.
    setReel(route.name, names[names.length - 3], after);
    renderRoute(route, easternDate(getNow()));
    els.pick.textContent = "Spin again";
    updateCount();
  };
}

// "16.4 km" with "10.2 mi" as the secondary line, in the chosen units first.
function unitPair(meters, kind) {
  const metric = kind === "distance" ? `${(meters / METERS_PER_KM).toFixed(1)} km` : `${Math.round(meters)} m`;
  const imperial = kind === "distance" ? `${(meters / METERS_PER_MILE).toFixed(1)} mi` : `${Math.round(meters * FEET_PER_METER)} ft`;
  return selectedUnits() === "metric" ? [metric, imperial] : [imperial, metric];
}

function stat(label, primary, secondary) {
  const box = document.createElement("div");
  box.className = "stat";
  const l = document.createElement("span");
  l.className = "stat-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "stat-value";
  v.textContent = primary;
  const sub = document.createElement("span");
  sub.className = "stat-sub";
  sub.textContent = secondary;
  box.append(l, v, sub);
  return box;
}

function renderRoute(route, today) {
  const sport = selectedSport();
  const isDone = done[sport].has(route.id);
  const kind = terrain(route);
  const tags = [[kind, `tag-${kind.toLowerCase()}`], [route.loop ? "Loop" : "Point to point", "tag-type"]];
  if (route.publishedOn && daysBetween(route.publishedOn, today) <= NEW_ROUTE_DAYS) tags.push(["New", "tag-new"]);
  if (route.levelLocked) tags.push(["Level locked", ""]);
  if (isDone) tags.push(["Done", "tag-done"]);

  const head = document.createElement("div");
  head.className = "result-head";
  const world = document.createElement("p");
  world.className = "eyebrow result-world";
  world.textContent = worldName(route.map);
  const title = document.createElement("h2");
  title.textContent = route.name;
  const tagRow = document.createElement("p");
  tagRow.className = "tags";
  for (const [text, cls] of tags) {
    const span = document.createElement("span");
    span.className = `tag ${cls}`.trim();
    span.textContent = text;
    tagRow.append(span);
  }
  head.append(world, title, tagRow);

  const [dist, distAlt] = unitPair(route.distanceMeters, "distance");
  const [climb, climbAlt] = unitPair(route.ascentMeters, "climbing");
  const [leadDist, leadDistAlt] = unitPair(route.leadinDistanceMeters, "distance");
  const [leadClimb, leadClimbAlt] = unitPair(route.leadinAscentMeters, "climbing");
  const [totDist, totDistAlt] = unitPair(totalDistance(route), "distance");
  const [totClimb, totClimbAlt] = unitPair(totalClimbing(route), "climbing");
  const stats = document.createElement("div");
  stats.className = "stats";
  stats.append(
    stat("Distance", dist, distAlt),
    stat("Climbing", climb, climbAlt),
    stat("Lead-in", `${leadDist}, ${leadClimb}`, `${leadDistAlt}, ${leadClimbAlt}`),
    stat("Total", `${totDist}, ${totClimb}`, `${totDistAlt}, ${totClimbAlt}`),
  );

  const actions = document.createElement("div");
  actions.className = "result-actions";
  if (route.link) {
    const link = document.createElement("a");
    link.className = "btn";
    link.href = route.link;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Map and details on Zwift Insider";
    actions.append(link);
  }
  const mark = document.createElement("button");
  mark.type = "button";
  mark.id = "mark-done";
  mark.className = isDone ? "btn btn-done" : "btn";
  mark.textContent = isDone ? "Marked as done (undo)" : "Mark as done";
  mark.addEventListener("click", () => setDone(sport, [route.id], !isDone));
  actions.append(mark);

  els.result.replaceChildren(head, stats, actions);
  els.result.hidden = false;
  shownRoute = route;
}

// ---- Tabs ----
// Tabs live in the URL hash (#spin, #completed) so back and bookmarks work.
// Progress links also use the hash (#progress=...); those open Completed.

const TAB_TITLES = { spin: "", calendar: "Calendar", completed: "Completed routes", help: "Help" };

function showTab(name) {
  const tab = TABS.includes(name) ? name : "spin";
  document.title = TAB_TITLES[tab] ? `${TAB_TITLES[tab]} · Where to Zwift Today` : "Where to Zwift Today";
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

// ---- Header tagline ----
// Spread "Randomize. Ride. Discover." so it starts and ends exactly under the
// site name. The name's width depends on the font and screen size, so this
// re-runs when the font loads and when the window is resized.

function fitTagline() {
  const name = document.querySelector(".brand-name");
  const tagline = document.querySelector(".brand-tagline");
  if (!name || !tagline) return;
  tagline.style.letterSpacing = "0px";
  tagline.style.marginRight = "0px";
  const gap = name.getBoundingClientRect().width - tagline.getBoundingClientRect().width;
  const letters = tagline.textContent.length;
  if (letters < 2) return;
  // Letter spacing is added after every letter, including the last, so pull
  // the right edge back by one spacing to keep both ends flush.
  // Never squeeze letters together; if the name is narrower, leave the tagline as is.
  const spacing = Math.max(0, gap / (letters - 1));
  tagline.style.letterSpacing = `${spacing}px`;
  tagline.style.marginRight = `${-spacing}px`;
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

// Worlds the rider has expanded; kept across re-renders (e.g. after a tick).
const openWorlds = new Set();

function progressBar(fraction) {
  const bar = document.createElement("span");
  bar.className = "bar";
  bar.setAttribute("aria-hidden", "true");
  const fill = document.createElement("span");
  fill.style.width = `${Math.round(fraction * 100)}%`;
  bar.append(fill);
  return bar;
}

function renderChecklist() {
  const sport = selectedSport();
  const today = easternDate(getNow());
  const list = badgeRoutes(sport, today);
  const doneCount = list.filter((r) => done[sport].has(r.id)).length;
  els.progressSummary.textContent = `${doneCount} of ${list.length} ${SPORT_NAMES[sport]} routes`;
  els.progressBar.style.width = `${list.length ? Math.round((doneCount / list.length) * 100) : 0}%`;
  document.querySelectorAll(".sport-name").forEach((el) => { el.textContent = SPORT_NAMES[sport]; });
  const mirror = document.querySelector(`input[name="sport-completed"][value="${sport}"]`);
  if (mirror) mirror.checked = true;

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

    const group = document.createElement("details");
    group.className = "world";
    group.dataset.world = world;
    group.open = openWorlds.has(world);
    group.classList.toggle("complete", worldDone === ids.length);
    group.addEventListener("toggle", () => {
      if (group.open) openWorlds.add(world);
      else openWorlds.delete(world);
    });

    const summary = document.createElement("summary");
    const name = document.createElement("span");
    name.className = "world-name";
    name.textContent = worldName(world);
    const count = document.createElement("span");
    count.className = "world-count";
    count.textContent = `${worldDone} of ${ids.length}`;
    summary.append(name, count, progressBar(worldDone / ids.length));

    const body = document.createElement("div");
    body.className = "world-body";
    const allLabel = document.createElement("label");
    allLabel.className = "all-row";
    const all = document.createElement("input");
    all.type = "checkbox";
    all.checked = worldDone === ids.length;
    all.indeterminate = worldDone > 0 && worldDone < ids.length;
    all.setAttribute("aria-label", `All ${worldName(world)} routes`);
    all.addEventListener("change", () => setDone(sport, ids, all.checked));
    allLabel.append(all, ` All ${worldName(world)} routes`);

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
    body.append(allLabel, ul);
    group.append(summary, body);
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
    const savedShape = JSON.parse(localStorage.getItem("shape") || "null");
    if (savedShape) {
      shape.terrain = new Set(savedShape.terrain || []);
      shape.type = new Set(savedShape.type || []);
    }
  } catch (e) { /* keep the defaults */ }
  updateUnitLabels();
  updatePills();
}

function saveSettings() {
  try {
    localStorage.setItem("sport", selectedSport());
    localStorage.setItem("units", selectedUnits());
    localStorage.setItem("badges", badgeMode());
    localStorage.setItem("filters", JSON.stringify(readFilters()));
    localStorage.setItem("shape", JSON.stringify({ terrain: [...shape.terrain], type: [...shape.type] }));
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
  // Reset link at the end of the row, shown only while worlds are selected.
  const allItem = document.createElement("li");
  allItem.className = "all-worlds-item";
  const all = document.createElement("button");
  all.type = "button";
  all.id = "all-worlds";
  all.className = "link-button";
  all.textContent = "All active worlds";
  all.hidden = true;
  all.addEventListener("click", () => {
    selectedWorlds.clear();
    worldsChanged();
  });
  allItem.append(all);
  list.append(allItem);
  els.worlds.replaceChildren(list);
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
  fitTagline();
  if (document.fonts) document.fonts.ready.then(fitTagline);
  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(fitTagline);
  });
  updateThemeButton();
  els.themeToggle.addEventListener("click", toggleTheme);
  // Tab links and pasted progress links only change the hash, which doesn't
  // reload the page.
  window.addEventListener("hashchange", handleHash);
  // Arrow keys, Home and End move between tabs, as screen reader users expect.
  document.querySelector(".tabs").addEventListener("keydown", (event) => {
    const current = TABS.indexOf(document.activeElement.id.replace("tab-", ""));
    if (current < 0) return;
    const moves = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: TABS.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = TABS[(moves[event.key] + TABS.length) % TABS.length];
    document.getElementById(`tab-${next}`).focus();
    location.hash = next;
  });
  showTab(location.hash.startsWith(`#${PROGRESS_HASH}=`) ? "completed" : location.hash.slice(1));
  restoreSettings();
  loadDone();
  try {
    // The calendar's extra data is optional: if it fails, spinning still works.
    const [schedule, routeData, weekly, portal] = await Promise.all([
      loadJson("data/schedule.json"),
      loadJson("data/routes.json"),
      loadJson("data/weekly.json").catch(() => null),
      loadJson("data/portal.json").catch(() => null),
    ]);
    routes = routeData.routes;
    const active = findActiveWorlds(schedule, getNow());
    activeWorlds = active.worlds;
    renderWorlds(active, schedule.alwaysActive);
    renderChecklist();
    updateCount();
    initCalendar(schedule, weekly, portal);
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
  const sportChanged = () => {
    saveSettings();
    hideResult();
    renderChecklist();
    els.progressLink.hidden = true;
    els.progressMessage.textContent = "";
    updateCount();
  };
  document.querySelectorAll('input[name="sport"]').forEach((input) => input.addEventListener("change", sportChanged));
  // The Completed tab's switch drives the main Sport setting.
  document.querySelectorAll('input[name="sport-completed"]').forEach((input) =>
    input.addEventListener("change", () => {
      document.querySelector(`input[name="sport"][value="${input.value}"]`).checked = true;
      sportChanged();
    })
  );

  document.querySelectorAll('input[name="badges"]').forEach((input) =>
    input.addEventListener("change", () => {
      saveSettings();
      updateCount();
    })
  );


  // Jump to the settings without changing the URL hash, which drives the tabs.
  document.querySelector(".settings-jump").addEventListener("click", (event) => {
    event.preventDefault();
    els.settings.scrollIntoView({ behavior: "smooth", block: "start" });
  });

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
      renderCalendar();
    })
  );

  for (const input of els.filters) {
    input.addEventListener("input", () => {
      saveSettings();
      updateCount();
    });
  }

  document.querySelectorAll(".pill-toggle").forEach((pill) =>
    pill.addEventListener("click", () => {
      const set = shape[pill.dataset.shape];
      if (set.has(pill.dataset.value)) set.delete(pill.dataset.value);
      else set.add(pill.dataset.value);
      updatePills();
      saveSettings();
      updateCount();
    })
  );

  els.clear.addEventListener("click", () => {
    shape.terrain.clear();
    shape.type.clear();
    updatePills();
    writeFilters({});
    saveSettings();
    updateCount();
  });
}

init();
