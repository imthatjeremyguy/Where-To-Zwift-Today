// Calendar tab: guest worlds by day, Route and Climb of the Week, and the
// climb portal rotation. Uses helpers from app.js (worldName, getNow,
// easternDate, findActiveWorlds, unitPair, terrain, routes, activeWorlds).
// Bump ?v= on its <script> tag in index.html when this file changes.

// One color per world, used as a marker beside normal text so it reads in both themes.
const WORLD_COLORS = {
  WATOPIA: "#2f9e5a",
  MAKURIISLANDS: "#d6457b",
  NEWYORK: "#0e8fa8",
  LONDON: "#c73a2e",
  RICHMOND: "#8b5cd6",
  INNSBRUCK: "#c08a1e",
  YORKSHIRE: "#7d8f24",
  SCOTLAND: "#5d6b7e",
  FRANCE: "#2d55c8",
  PARIS: "#a1672e",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const cal = { schedule: null, weekly: null, portal: null, month: null };

const calEls = {
  now: document.getElementById("cal-now"),
  month: document.getElementById("cal-month"),
};

// ---- Date helpers. A "day" is a Date at UTC midnight of that calendar date. ----

function dayFromIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isoFromDay(day) {
  return day.toISOString().slice(0, 10);
}

function addDays(day, n) {
  return new Date(day.getTime() + n * DAY_MS);
}

// Monday = 0 ... Sunday = 6.
function weekday(day) {
  return (day.getUTCDay() + 6) % 7;
}

// Midday US Eastern on that date (16:00 UTC is noon EDT or 11am EST), safely
// between the midnight world change and the next one.
function middayOf(day) {
  return new Date(day.getTime() + 16 * 60 * 60 * 1000);
}

function easternHour(date) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(date));
}

function formatDay(day, options) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(day);
}

// ---- Data lookups ----

// Guest worlds on a day (Watopia left out), or null when not yet published.
function guestWorldsOn(day) {
  const active = findActiveWorlds(cal.schedule, middayOf(day));
  return active.known ? active.worlds.filter((w) => !cal.schedule.alwaysActive.includes(w)) : null;
}

// Latest portal entry for a world on a day. Daily entries go stale after 2 days,
// monthly ones after 32, so a gap in Zwift's file never shows an old climb.
function portalOn(day, world, monthly) {
  const at = middayOf(day);
  const entries = cal.portal.schedule.filter((a) => a.world === world && a.monthly === monthly && new Date(a.start) <= at);
  const entry = entries[entries.length - 1];
  if (!entry || at - new Date(entry.start) > (monthly ? 32 : 2) * DAY_MS) return null;
  return { ...cal.portal.climbs[entry.climbId], start: entry.start };
}

function weekStarting(day) {
  return cal.weekly ? cal.weekly.weeks.find((w) => w.start === isoFromDay(day)) || null : null;
}

// Weekly challenges switch Mondays at noon Eastern; before that it's still last week's.
function currentWeek(now) {
  const today = dayFromIso(easternDate(now));
  let monday = addDays(today, -weekday(today));
  if (weekday(today) === 0 && easternHour(now) < 12) monday = addDays(monday, -7);
  return weekStarting(monday);
}

// First day from `from` (inclusive) when `world` is available, within the published schedule.
function nextDayWith(world, from) {
  if (cal.schedule.alwaysActive.includes(world)) return from;
  for (let i = 0; i < 60; i++) {
    const day = addDays(from, i);
    const worlds = guestWorldsOn(day);
    if (worlds === null) return null;
    if (worlds.includes(world)) return day;
  }
  return null;
}

// ---- Small DOM helpers ----

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function worldTag(world) {
  const tag = el("span", "cal-world", worldName(world));
  tag.style.setProperty("--wc", WORLD_COLORS[world] || "var(--muted)");
  return tag;
}

function linkOrText(text, href) {
  if (!href) return el("span", null, text);
  const a = el("a", null, text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function distanceClimb(distanceMeters, ascentMeters) {
  return `${unitPair(distanceMeters, "distance")[0]} · ${unitPair(ascentMeters, "climbing")[0]}`;
}

// "Available today" or "Next in France: Mon, Oct 5".
function availability(world, today) {
  const next = nextDayWith(world, today);
  if (!next) return `${worldName(world)} isn't in the published schedule yet`;
  if (isoFromDay(next) === isoFromDay(today)) return "Available today";
  return `Next in ${worldName(world)}: ${formatDay(next, { weekday: "short", month: "short", day: "numeric" })}`;
}

// ---- "Right now" cards ----

function renderNow() {
  const now = getNow();
  const today = dayFromIso(easternDate(now));
  const cards = [];

  const worldsCard = el("div", "card cal-card");
  worldsCard.append(el("p", "eyebrow", "Today's worlds"));
  const list = el("div", "cal-worlds");
  const todays = guestWorldsOn(today);
  for (const w of [...cal.schedule.alwaysActive, ...(todays || [])]) list.append(worldTag(w));
  worldsCard.append(list, el("p", "muted small", todays ? "Until midnight US Eastern." : "Guest worlds not published yet."));
  cards.push(worldsCard);

  const week = currentWeek(now);
  const routeCard = el("div", "card cal-card");
  routeCard.append(el("p", "eyebrow", "Route of the Week"));
  if (week && week.route) {
    const title = el("h3", "cal-card-title");
    title.append(linkOrText(week.route.name, week.route.link));
    routeCard.append(title);
    if (week.route.reward) routeCard.append(el("span", "tag tag-new", week.route.reward));
    const route = routes.find((r) => r.id === week.route.routeId);
    if (route) {
      const meta = el("p", "cal-meta");
      meta.append(worldTag(route.map), ` ${distanceClimb(route.distanceMeters, route.ascentMeters)} · ${terrain(route)}`);
      routeCard.append(meta, el("p", "muted small", availability(route.map, today)));
    }
  } else {
    routeCard.append(el("p", "muted", cal.weekly ? "Not announced yet." : "Couldn't load this week's challenges."));
  }
  cards.push(routeCard);

  const climbCard = el("div", "card cal-card");
  climbCard.append(el("p", "eyebrow", "Climb of the Week"));
  if (week && week.climb) {
    const title = el("h3", "cal-card-title");
    title.append(linkOrText(week.climb.name, week.climb.link));
    climbCard.append(title);
    if (week.climb.reward) climbCard.append(el("span", "tag tag-new", week.climb.reward));
    climbCard.append(el("p", "muted small", "Weekly challenges switch Mondays at noon US Eastern."));
  } else {
    climbCard.append(el("p", "muted", cal.weekly ? "Not announced yet." : "Couldn't load this week's challenges."));
  }
  cards.push(climbCard);

  const portalCard = el("div", "card cal-card");
  portalCard.append(el("p", "eyebrow", "Climb portals"));
  if (cal.portal) {
    for (const [world, monthly, label] of [["WATOPIA", false, "Watopia today"], ["FRANCE", true, "France this month"]]) {
      const climb = portalOn(today, world, monthly);
      const row = el("div", "cal-portal-row");
      row.append(el("span", "cal-portal-label", label));
      if (climb) {
        const name = el("strong");
        name.append(linkOrText(climb.name, climb.link));
        row.append(name, el("span", "muted small", distanceClimb(climb.distanceMeters, climb.ascentMeters)));
        if (monthly) row.append(el("span", "muted small", availability(world, today)));
      } else {
        row.append(el("span", "muted small", "Not published yet"));
      }
      portalCard.append(row);
    }
  } else {
    portalCard.append(el("p", "muted", "Couldn't load the climb portal rotation."));
  }
  cards.push(portalCard);

  calEls.now.replaceChildren(...cards);
}

// ---- Month grid (a list on phones, from the same markup) ----

function monthRange() {
  const starts = cal.schedule.appointments.map((a) => easternDate(new Date(a.start)).slice(0, 7));
  return [starts[0], starts[starts.length - 1]];
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function weekBar(kind, entry) {
  const bar = el("div", `cal-bar cal-bar-${kind}`);
  bar.append(el("span", "cal-bar-kind", kind === "route" ? "Route" : "Climb"));
  const name = el("span", "cal-bar-name");
  name.append(linkOrText(entry.name, entry.link));
  bar.append(name);
  if (entry.reward) bar.append(el("span", "cal-bar-reward", entry.reward));
  return bar;
}

function renderMonth() {
  const [first, last] = monthRange();
  const ym = cal.month;
  const today = easternDate(getNow());
  const monthStart = dayFromIso(`${ym}-01`);
  const monthEnd = addDays(dayFromIso(`${shiftMonth(ym, 1)}-01`), -1);

  const head = el("div", "cal-head");
  const prev = el("button", "icon-button", "‹");
  prev.type = "button";
  prev.setAttribute("aria-label", "Previous month");
  prev.disabled = ym <= first;
  prev.addEventListener("click", () => { cal.month = shiftMonth(ym, -1); renderMonth(); });
  const next = el("button", "icon-button", "›");
  next.type = "button";
  next.setAttribute("aria-label", "Next month");
  next.disabled = ym >= last;
  next.addEventListener("click", () => { cal.month = shiftMonth(ym, 1); renderMonth(); });
  const title = el("h2", "cal-title", formatDay(monthStart, { month: "long", year: "numeric" }));
  title.id = "cal-title";
  head.append(prev, title, next);

  const legend = el("div", "cal-legend small muted");
  legend.append(el("span", "cal-key cal-key-route", "Route of the Week"), el("span", "cal-key cal-key-climb", "Climb of the Week"), el("span", null, "Watopia is always available."));

  const dow = el("div", "cal-dow");
  for (const name of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) dow.append(el("span", null, name));

  const weeks = el("div", "cal-weeks");
  for (let monday = addDays(monthStart, -weekday(monthStart)); monday <= monthEnd; monday = addDays(monday, 7)) {
    const week = el("section", "cal-week");
    week.setAttribute("aria-label", `Week of ${formatDay(monday, { month: "long", day: "numeric" })}`);
    const bars = el("div", "cal-bars");
    const challenge = weekStarting(monday);
    if (challenge && challenge.route) bars.append(weekBar("route", challenge.route));
    if (challenge && challenge.climb) bars.append(weekBar("climb", challenge.climb));
    if (bars.childElementCount) week.append(bars);

    const days = el("div", "cal-days");
    for (let i = 0; i < 7; i++) {
      const day = addDays(monday, i);
      const iso = isoFromDay(day);
      const cell = el("div", "cal-day");
      cell.dataset.date = iso;
      if (day < monthStart || day > monthEnd) cell.classList.add("out");
      if (iso === today) cell.classList.add("today");
      const date = el("div", "cal-date");
      date.append(el("span", "d-num", String(day.getUTCDate())), el("span", "d-long", formatDay(day, { weekday: "short", month: "short", day: "numeric" })));
      if (iso === today) date.append(el("span", "d-today", "Today"));
      cell.append(date);
      const worlds = guestWorldsOn(day);
      const list = el("div", "cal-day-worlds");
      if (worlds) worlds.forEach((w) => list.append(worldTag(w)));
      else if (!cell.classList.contains("out")) list.append(el("span", "muted small", "Not published yet"));
      cell.append(list);
      const climb = cal.portal && worlds ? portalOn(day, "WATOPIA", false) : null;
      if (climb) cell.append(el("div", "cal-day-portal", `Portal: ${climb.name}`));
      days.append(cell);
    }
    week.append(days);
    weeks.append(week);
  }

  calEls.month.replaceChildren(head, legend, dow, weeks);
  calEls.month.setAttribute("aria-labelledby", "cal-title");
}

function renderCalendar() {
  if (!cal.schedule) return;
  renderNow();
  renderMonth();
}

// Called by app.js once data has loaded; weekly or portal may be null if they failed.
function initCalendar(schedule, weekly, portal) {
  Object.assign(cal, { schedule, weekly, portal });
  const [first, last] = monthRange();
  const current = easternDate(getNow()).slice(0, 7);
  cal.month = current < first ? first : current > last ? last : current;
  renderCalendar();
}
