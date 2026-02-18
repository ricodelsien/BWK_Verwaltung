// script.js
(() => {
  const APP = {
    name: "BWK-Aufgabenplanung",
    version: "0.6.1",
    buildDate: "2026-02-18",
    author: "Nico Siedler"
  };

  const STORAGE_KEY_V2 = "bwk_aufgabenplanung_v2";
  const STORAGE_KEY_V1 = "bwk_aufgabenplanung_v1";

  const $ = (sel, el = document) => el.querySelector(sel);

  const toastEl = $("#toast");
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  function uid() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return "id_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function clampStr(s) {
    return String(s ?? "").trim();
  }

  // --- People sorting (by surname) ---
  function personSortKey(name) {
    const s = clampStr(name).toLowerCase();
    if (!s) return "";
    // "Nachname, Vorname"
    if (s.includes(",")) {
      const [last, first] = s.split(",").map(x => x.trim());
      return `${last} ${first}`.trim();
    }
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return parts[0] || s;
    const last = parts[parts.length - 1];
    const first = parts.slice(0, -1).join(" ");
    return `${last} ${first}`.trim();
  }

  function sortedPeople() {
    const people = state.people.filter(p => p.type !== "group").slice();
    const groups = state.people.filter(p => p.type === "group").slice();

    const sortFn = (a, b) => {
      const ak = personSortKey(a.name);
      const bk = personSortKey(b.name);
      if (ak !== bk) return ak.localeCompare(bk, "de");
      return (a.name || "").localeCompare(b.name || "", "de");
    };

    people.sort(sortFn);
    groups.sort(sortFn);
    return [...people, ...groups];
  }

  // --- Drag helpers ---
  function getDraggedPersonId(dt) {
    if (!dt) return "";
    return dt.getData("text/person-id") || dt.getData("text/plain") || "";
  }

  // --- Berlin holiday / school holiday (Ferien) caches ---
  const HOLI_CACHE_PREFIX = "bwk_holidays_DE-BE_";
  const SCHOOL_CACHE_PREFIX = "bwk_schoolholidays_DE-BE_";
  let holidayYearLoaded = null;
  let berlinHolidays = {}; // { 'YYYY-MM-DD': 'Name' }
  let schoolYearLoaded = null;
  let berlinSchoolHolidays = []; // [{name,start,end}]
  let holidayYearFetching = null;
  let schoolYearFetching = null;

  function toISODateLocal(date) {
    const d = new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function isoToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return toISODateLocal(d);
  }

  function parseISODate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }

  function fmtMonthLabel(year, monthIndex0) {
    const d = new Date(year, monthIndex0, 1);
    return d.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  }

  function isDateInRange(dayISO, startISO, endISO) {
    return dayISO >= startISO && dayISO <= endISO;
  }

  function addDaysISO(iso, days) {
    const d = parseISODate(iso);
    d.setDate(d.getDate() + days);
    return toISODateLocal(d);
  }

  function addMonthsISO(iso, months) {
    const d = parseISODate(iso);
    const day = d.getDate();
    d.setMonth(d.getMonth() + months);
    if (d.getDate() !== day) d.setDate(0);
    return toISODateLocal(d);
  }

  // ---------- ISO week helpers (for KW jump + timeline) ----------
  function startOfWeekISO(iso) {
    const d = parseISODate(iso);
    const day = (d.getDay() + 6) % 7; // Mon=0
    d.setDate(d.getDate() - day);
    return toISODateLocal(d);
  }

  function getISOWeekInfo(dateObj) {
    const d = new Date(dateObj);
    d.setHours(0, 0, 0, 0);

    // Thursday decides the ISO week-year
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const weekYear = d.getFullYear();

    const firstThursday = new Date(weekYear, 0, 4);
    firstThursday.setHours(0, 0, 0, 0);
    firstThursday.setDate(firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7));

    const week = 1 + Math.round((d - firstThursday) / 86400000 / 7);
    return { weekYear, week };
  }

  function toWeekInputValue(iso) {
    const d = parseISODate(iso);
    const { weekYear, week } = getISOWeekInfo(d);
    return `${weekYear}-W${String(week).padStart(2, "0")}`;
  }

  function isoFromWeekInput(val) {
    const m = /^(\d{4})-W(\d{2})$/.exec(String(val || "").trim());
    if (!m) return null;
    const year = Number(m[1]);
    const week = Number(m[2]);
    if (!year || !week) return null;

    const jan4 = new Date(year, 0, 4);
    jan4.setHours(0, 0, 0, 0);
    const day = (jan4.getDay() + 6) % 7;

    const monday = new Date(jan4);
    monday.setDate(jan4.getDate() - day + (week - 1) * 7);
    return toISODateLocal(monday);
  }

  function clampDayToMonthISO(iso, monthStr) {
    const [y, m] = String(monthStr || "").split("-").map(Number);
    const day = Number(String(iso || "").split("-")[2]) || 1;
    if (!y || !m) return isoToday();

    const last = new Date(y, m, 0).getDate();
    const d = Math.min(Math.max(day, 1), last);
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function diffDaysISO(aISO, bISO) {
    const a = parseISODate(aISO);
    const b = parseISODate(bISO);
    return Math.round((a - b) / 86400000);
  }


  function nextRepeatStart(iso, repeat) {
    if (repeat === "daily") return addDaysISO(iso, 1);
    if (repeat === "weekly") return addDaysISO(iso, 7);
    if (repeat === "monthly") return addMonthsISO(iso, 1);
    return iso;
  }

  function monthStartEndISO(year, monthIndex0) {
    const mm = String(monthIndex0 + 1).padStart(2, "0");
    const lastDay = new Date(year, monthIndex0 + 1, 0).getDate();
    const sIso = `${year}-${mm}-01`;
    const eIso = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;
    return { sIso, eIso };
  }

  async function fetchBerlinPublicHolidays(year) {
    // Try Nager.Date first (works well with CORS)
    try {
      const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/DE`, { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const arr = await res.json();
      const map = {};
      for (const h of Array.isArray(arr) ? arr : []) {
        const appliesBerlin = !h.counties || (Array.isArray(h.counties) && h.counties.includes("DE-BE"));
        if (!appliesBerlin) continue;
        if (h.date) map[h.date] = h.localName || h.name || "Feiertag";
      }
      return map;
    } catch {
      // Fallback: feiertage-api.de
      try {
        const res2 = await fetch(`https://feiertage-api.de/api/?jahr=${year}&nur_land=BE`, { cache: "no-cache" });
        if (!res2.ok) throw new Error("HTTP " + res2.status);
        const obj = await res2.json();
        const map = {};
        for (const [name, info] of Object.entries(obj || {})) {
          const date = info?.datum;
          if (date) map[date] = name;
        }
        return map;
      } catch {
        return {};
      }
    }
  }

  async function ensureBerlinHolidays(year) {
    if (holidayYearLoaded === year) return;
    if (holidayYearFetching === year) return;

    const cacheKey = HOLI_CACHE_PREFIX + String(year);
    const cached = safeParse(localStorage.getItem(cacheKey) || "");
    if (cached && typeof cached === "object") {
      berlinHolidays = cached;
      holidayYearLoaded = year;
      return;
    }

    berlinHolidays = {};
    holidayYearFetching = year;

    const map = await fetchBerlinPublicHolidays(year);
    berlinHolidays = map;
    holidayYearLoaded = year;
    holidayYearFetching = null;
    try {
      localStorage.setItem(cacheKey, JSON.stringify(map));
    } catch {
      // ignore
    }
  }

  async function fetchBerlinSchoolHolidays(year) {
    // Try Nager.Date first
    try {
      const res = await fetch(`https://date.nager.at/api/v3/SchoolHolidays/${year}/DE`, { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const arr = await res.json();
      const out = [];
      for (const h of Array.isArray(arr) ? arr : []) {
        const appliesBerlin = !h.counties || (Array.isArray(h.counties) && h.counties.includes("DE-BE"));
        if (!appliesBerlin) continue;
        const start = h.startDate || h.start;
        const end = h.endDate || h.end;
        if (start && end) out.push({ name: h.localName || h.name || "Ferien", start, end });
      }
      return out;
    } catch {
      // Fallback: ferien-api.de
      try {
        const res2 = await fetch(`https://ferien-api.de/api/v1/holidays/BE/${year}`, { cache: "no-cache" });
        if (!res2.ok) throw new Error("HTTP " + res2.status);
        const arr2 = await res2.json();
        const out2 = [];
        for (const h of Array.isArray(arr2) ? arr2 : []) {
          const start = h.start || h.startDate;
          const end = h.end || h.endDate;
          const name = h.name || h.holidayName || "Ferien";
          if (start && end) out2.push({ name, start, end });
        }
        return out2;
      } catch {
        return [];
      }
    }
  }

  async function ensureBerlinSchoolHolidays(year) {
    if (schoolYearLoaded === year) return;
    if (schoolYearFetching === year) return;

    const cacheKey = SCHOOL_CACHE_PREFIX + String(year);
    const cached = safeParse(localStorage.getItem(cacheKey) || "");
    if (Array.isArray(cached)) {
      berlinSchoolHolidays = cached;
      schoolYearLoaded = year;
      return;
    }

    berlinSchoolHolidays = [];
    schoolYearFetching = year;

    const list = await fetchBerlinSchoolHolidays(year);
    berlinSchoolHolidays = list;
    schoolYearLoaded = year;
    schoolYearFetching = null;
    try {
      localStorage.setItem(cacheKey, JSON.stringify(list));
    } catch {
      // ignore
    }
  }

  function renderFerienBox(year, monthIndex0) {
    const box = $("#ferienBox");
    const sum = $("#ferienSummary");
    if (!box || !sum) return;

    const { sIso, eIso } = monthStartEndISO(year, monthIndex0);
    const inMonth = (berlinSchoolHolidays || []).filter(r => !(r.end < sIso || r.start > eIso));

    if (!inMonth.length) {
      sum.textContent = "";
      box.textContent = "Keine Daten in diesem Monat.";
      return;
    }

    sum.textContent = `• ${inMonth.length}`;
    box.innerHTML = "";
    for (const r of inMonth.slice(0, 6)) {
      const line = document.createElement("div");
      line.textContent = `${r.name}: ${r.start} → ${r.end}`;
      box.appendChild(line);
    }
    if (inMonth.length > 6) {
      const more = document.createElement("div");
      more.textContent = `… +${inMonth.length - 6} weitere`;
      box.appendChild(more);
    }
  }

  function safeParse(json) {
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  function defaultStateV2() {
    const today = isoToday();
    return {
      version: 2,
      people: [],
      tasks: [],
      ui: {
        activePersonId: null,
        month: today.slice(0, 7),
        selectedDay: today,
        sidebarOpen: false,
        sidebarCollapsed: false,
        theme: "system",
        accent: "blue"
      },
      lastSavedAt: null
    };
  }

  function normalizePerson(p) {
    p.id ??= uid();
    p.name = clampStr(p.name) || "Unbenannt";
    p.type = clampStr(p.type) || "person";
    if (!["person", "group"].includes(p.type)) p.type = "person";
    p.role = clampStr(p.role) || "";
    p.members = Array.isArray(p.members) ? p.members.filter(Boolean) : [];
    if (p.type !== "group") p.members = [];
    p.createdAt ??= new Date().toISOString();
    return p;
  }

  function normalizeTask(t) {
    t.id ??= uid();
    t.title = clampStr(t.title) || "(ohne Titel)";
    t.note = clampStr(t.note);
    t.priority = Number(t.priority ?? 0);
    t.repeat ??= "none";

    t.repeatUntil = clampStr(t.repeatUntil) || null;

    // Type: task | appointment | milestone
    t.kind ??= "task";
    const okKind = new Set(["task", "appointment", "milestone"]);
    if (!okKind.has(t.kind)) t.kind = "task";

    // Optional time range (appointments only)
    t.timeStart = clampStr(t.timeStart) || null;
    t.timeEnd = clampStr(t.timeEnd) || null;
    if (t.kind !== "appointment") {
      t.timeStart = null;
      t.timeEnd = null;
    }

    t.isBacklog = !!t.isBacklog;
    if (t.isBacklog) {
      t.start = null;
      t.end = null;
      if (t.status !== "done") t.status = "backlog";
    } else {
      t.start = t.start || isoToday();
      t.end = t.end || t.start;

      // Appointments and milestones are single-day entries
      if (t.kind === "appointment" || t.kind === "milestone") {
        t.end = t.start;
      }

      t.status ??= "planned";
    }

        // Repeat end handling
    if (t.isBacklog || t.repeat === "none") {
      t.repeatUntil = null;
    } else if (t.repeatUntil && t.repeatUntil < t.start) {
      // Defensive: invalid end before start
      t.repeatUntil = t.start;
    }

    t.assignees = Array.isArray(t.assignees) ? t.assignees.filter(Boolean) : [];
    t.createdAt ??= new Date().toISOString();
    t.doneAt ??= null;

    // Defensive: unknown status
    const okStatus = new Set(["planned", "inprogress", "backlog", "done"]);
    if (!okStatus.has(t.status)) t.status = t.isBacklog ? "backlog" : "planned";

    return t;
  }

  function migrateV1ToV2(v1) {
    const v2 = defaultStateV2();
    v2.ui = {
      ...v2.ui,
      ...(v1.ui || {})
    };

    const usedTaskIds = new Set();

    v2.people = (v1.people || []).map(rawP => {
      const p = normalizePerson({
        id: rawP.id,
        name: rawP.name,
        createdAt: rawP.createdAt
      });

      // Lift tasks into global list
      const tasks = Array.isArray(rawP.tasks) ? rawP.tasks : [];
      for (const rawT of tasks) {
        const t = normalizeTask({ ...rawT });
        if (usedTaskIds.has(t.id)) t.id = uid();
        usedTaskIds.add(t.id);
        t.assignees = [p.id];
        v2.tasks.push(t);
      }

      return p;
    });

    v2.lastSavedAt = v1.lastSavedAt ?? null;

    // UI sanity
    if (!v2.ui.selectedDay) v2.ui.selectedDay = isoToday();
    if (!v2.ui.month) v2.ui.month = v2.ui.selectedDay.slice(0, 7);
    if (!v2.ui.activePersonId || !v2.people.some(p => p.id === v2.ui.activePersonId)) {
      v2.ui.activePersonId = v2.people[0]?.id ?? null;
    }

    return v2;
  }

  function loadState() {
    const rawV2 = localStorage.getItem(STORAGE_KEY_V2);
    if (rawV2) {
      const parsed = safeParse(rawV2);
      if (parsed?.version === 2 && Array.isArray(parsed.people) && Array.isArray(parsed.tasks)) {
        const s = parsed;
        s.ui ??= defaultStateV2().ui;
      s.ui.theme ??= "system";
      s.ui.accent ??= "blue";
        s.people = s.people.map(p => normalizePerson(p));
        s.tasks = s.tasks.map(t => normalizeTask(t));
        s.lastSavedAt ??= null;
        return s;
      }
    }

    const rawV1 = localStorage.getItem(STORAGE_KEY_V1);
    if (rawV1) {
      const parsed = safeParse(rawV1);
      if (parsed?.version === 1 && Array.isArray(parsed.people)) {
        const migrated = migrateV1ToV2(parsed);
        // Persist into v2 key immediately
        try {
          localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(migrated));
        } catch {
          // ignore
        }
        return migrated;
      }
    }

    return defaultStateV2();
  }

  let state = loadState();
  let pendingImport = null;
  let saveTimer = null;

  function saveState(debounced = true) {
    const write = () => {
      state.lastSavedAt = new Date().toISOString();
      localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(state));
      updateSaveInfo();
    };

    if (!debounced) {
      write();
      return;
    }

    clearTimeout(saveTimer);
    saveTimer = setTimeout(write, 120);
  }

  function activePerson() {
    return state.people.find(p => p.id === state.ui.activePersonId) || null;
  }

  function personNameById(id) {
    return state.people.find(p => p.id === id)?.name || "(unbekannt)";
  }

  function personById(id) {
    return state.people.find(p => p.id === id) || null;
  }

  function resolveGroupPersonIds(groupId, visited = new Set()) {
    const g = personById(groupId);
    if (!g || g.type !== "group") return [];
    if (visited.has(groupId)) return [];
    visited.add(groupId);

    const out = [];
    for (const mid of (g.members || [])) {
      const m = personById(mid);
      if (!m) continue;
      if (m.type === "group") out.push(...resolveGroupPersonIds(m.id, visited));
      else out.push(m.id);
    }
    return out;
  }

  function groupIdsForPerson(personId) {
    const direct = state.people
      .filter(p => p.type === "group" && Array.isArray(p.members) && p.members.includes(personId))
      .map(p => p.id);

    const seen = new Set(direct);
    const stack = [...direct];

    while (stack.length) {
      const gid = stack.pop();
      for (const g of state.people) {
        if (g.type !== "group" || !Array.isArray(g.members)) continue;
        if (g.members.includes(gid) && !seen.has(g.id)) {
          seen.add(g.id);
          stack.push(g.id);
        }
      }
    }
    return [...seen];
  }

  function effectiveAssigneeIdsForView(activeId) {
    const p = personById(activeId);
    if (!p) return [activeId];

    if (p.type === "group") {
      const groupIds = new Set([p.id]);
      const stack = [...(p.members || [])];
      while (stack.length) {
        const id = stack.pop();
        if (groupIds.has(id)) continue;
        groupIds.add(id);
        const x = personById(id);
        if (x?.type === "group" && Array.isArray(x.members)) {
          for (const mid of x.members) stack.push(mid);
        }
      }
      const memberPersons = resolveGroupPersonIds(p.id);
      return [...new Set([...groupIds, ...memberPersons])];
    }

    return [...new Set([p.id, ...groupIdsForPerson(p.id)])];
  }

  function tasksForPerson(personId) {
    const ids = new Set(effectiveAssigneeIdsForView(personId));
    return state.tasks.filter(t =>
      Array.isArray(t.assignees) && t.assignees.some(a => ids.has(a))
    );
  }

  function expandedAssigneeNames(assigneeIds) {
    const parts = [];
    for (const id of (assigneeIds || [])) {
      const p = personById(id);
      if (!p) continue;
      if (p.type === "group") {
        const members = resolveGroupPersonIds(p.id).map(personNameById).filter(x => x && x !== "(unbekannt)");
        parts.push(members.length ? `${p.name} (${members.join(", ")})` : p.name);
      } else {
        parts.push(p.name);
      }
    }
    return [...new Set(parts)];
  }

  function expandedAssigneePersonCount(assigneeIds) {
    const out = new Set();
    for (const id of (assigneeIds || [])) {
      const p = personById(id);
      if (!p) continue;
      if (p.type === "group") {
        for (const mid of resolveGroupPersonIds(p.id)) out.add(mid);
      } else out.add(p.id);
    }
    return out.size;
  }

  function filterMatch(t, q) {
    const s = clampStr(q).toLowerCase();
    if (!s) return true;
    const hay = `${t.title} ${t.note ?? ""}`.toLowerCase();
    return hay.includes(s);
  }

  function taskSort(a, b) {
    const p = (b.priority ?? 0) - (a.priority ?? 0);
    if (p !== 0) return p;

    const aKey = a.isBacklog ? "9999-12-31" : (a.end || a.start || "9999-12-31");
    const bKey = b.isBacklog ? "9999-12-31" : (b.end || b.start || "9999-12-31");
    if (aKey !== bKey) return aKey.localeCompare(bKey);

    // On same day: appointments by time
    const aTime = (a.kind === "appointment" ? (a.timeStart || "") : "");
    const bTime = (b.kind === "appointment" ? (b.timeStart || "") : "");
    if (aTime !== bTime) return aTime.localeCompare(bTime);

    return (a.title || "").localeCompare(b.title || "");
  }

  function tasksForDay(personId, dayISO, q) {
    const list = [];
    for (const t of tasksForPerson(personId)) {
      if (t.status === "done") continue;
      if (t.isBacklog) continue;
      if (!filterMatch(t, q)) continue;

      const start = t.start;
      const end = t.end || t.start;
      if (start && end && isDateInRange(dayISO, start, end)) list.push(t);
    }
    return list.sort(taskSort);
  }

  function countBuckets(personId, q) {
    const out = { inprogress: 0, planned: 0, backlog: 0, done: 0 };
    for (const t of tasksForPerson(personId)) {
      if (!filterMatch(t, q)) continue;
      if (t.status === "inprogress") out.inprogress++;
      else if (t.status === "planned") out.planned++;
      else if (t.status === "backlog") out.backlog++;
      else if (t.status === "done") out.done++;
    }
    return out;
  }

  function repeatText(repeat) {
    switch (repeat) {
      case "daily": return "täglich";
      case "weekly": return "wöchentlich";
      case "monthly": return "monatlich";
      default: return "—";
    }
  }

  function priorityText(p) {
    if (p === 3) return "hoch";
    if (p === 2) return "mittel";
    if (p === 1) return "niedrig";
    return "keine";
  }

  function statusText(s) {
    if (s === "inprogress") return "in Arbeit";
    if (s === "planned") return "geplant";
    if (s === "backlog") return "backlog";
    if (s === "done") return "erledigt";
    return "—";
  }

  function taskRangeText(t) {
    if (t.isBacklog) return "ohne Datum";
    if (!t.start || !t.end) return "—";
    if (t.start === t.end) return t.start;
    return `${t.start} → ${t.end}`;
  }

  function taskKindText(t) {
    if (t.kind === "appointment") return "Termin";
    if (t.kind === "milestone") return "Meilenstein";
    return "Aufgabe";
  }

  function taskTimeText(t) {
    if (t.kind !== "appointment") return "";
    const s = t.timeStart || "";
    const e = t.timeEnd || "";
    if (s && e) return `${s}–${e}`;
    if (s) return `${s}`;
    return "";
  }

  function advanceRepeatingTask(t) {
    if (t.isBacklog || t.repeat === "none") return false;

    const start = t.start;
    const end = t.end ?? t.start;

    const ds = parseISODate(start);
    const de = parseISODate(end);
    const durDays = Math.max(0, Math.round((de - ds) / 86400000));

    const newStart = nextRepeatStart(start, t.repeat);

    const until = t.repeatUntil;
    if (until && newStart > until) return false;
    const newEnd = addDaysISO(newStart, durDays);

    t.start = newStart;
    t.end = newEnd;
    t.status = "planned";
    t.doneAt = null;
    return true;
  }

  function updateSaveInfo() {
    const saveEl = $("#saveInfo");
    const appEl = $("#appInfo");

    if (!state.lastSavedAt) {
      saveEl.textContent = "Noch nicht gespeichert";
    } else {
      const d = new Date(state.lastSavedAt);
      saveEl.textContent = `Zuletzt gespeichert: ${d.toLocaleString("de-DE")}`;
    }

    appEl.textContent = `${APP.name} v${APP.version} • ${APP.author} • ${APP.buildDate} • 💾 speichert im Browser (localStorage)`;
  }

  function ensureFirstRun() {
    const hasPeople = state.people.length > 0;

    // No forced prompt on first run. Instead: keep UI usable and guide when user acts.
    $("#btnAddTask").disabled = !hasPeople;

    if (!hasPeople) {
      state.ui.activePersonId = null;
      return;
    }

    if (!state.ui.activePersonId || !activePerson()) {
      state.ui.activePersonId = sortedPeople()[0]?.id ?? state.people[0].id;
    }
  }

  // ---------- Rendering ----------

    function renderSidebar() {
    const list = $("#personList");
    list.innerHTML = "";

    const q = $("#searchInput").value;
    const all = sortedPeople();
    const persons = all.filter(p => p.type !== "group");
    const groups = all.filter(p => p.type === "group");

    const renderSection = (title, items) => {
      const head = document.createElement("div");
      head.className = "person-section-title";
      head.textContent = title;
      list.appendChild(head);

      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "tiny muted person-section-empty";
        empty.textContent = "—";
        list.appendChild(empty);
        return;
      }

      for (const p of items) {
        const isActive = p.id === state.ui.activePersonId;
        const counts = countBuckets(p.id, q);

        const item = document.createElement("div");
        item.className = "person-item" + (isActive ? " active" : "") + (p.type === "group" ? " is-group" : "");
        item.draggable = true;

        item.addEventListener("dragstart", (e) => {
          try {
            e.dataTransfer.setData("text/person-id", p.id);
            e.dataTransfer.setData("text/plain", p.id);
            e.dataTransfer.effectAllowed = "copy";
          } catch {
            // ignore
          }
          item.classList.add("dragging");
        });
        item.addEventListener("dragend", () => item.classList.remove("dragging"));

        const left = document.createElement("div");
        left.className = "person-left";

        const name = document.createElement("div");
        name.className = "person-name";
        name.textContent = `${p.type === "group" ? "👥 " : ""}${p.name}`;

        const role = document.createElement("div");
        role.className = "person-role";
        role.textContent = `${p.type === "group" ? "Gruppe" : "Person"}${p.role ? " · " + p.role : ""}`;

        const stats = document.createElement("div");
        stats.className = "person-stats";

        const mkStat = (icon, val, title) => {
          const s = document.createElement("span");
          s.className = "stat";
          s.title = title;
          s.setAttribute("aria-label", `${title}: ${val}`);
          const i = document.createElement("span");
          i.className = "stat-ic";
          i.textContent = icon;
          const v = document.createElement("span");
          v.className = "stat-val";
          v.textContent = String(val);
          s.appendChild(i);
          s.appendChild(v);
          return s;
        };

        stats.appendChild(mkStat("🟠", counts.inprogress, "In Arbeit"));
        stats.appendChild(mkStat("🗓", counts.planned, "Geplant"));
        stats.appendChild(mkStat("📦", counts.backlog, "Backlog"));

        left.appendChild(name);
        left.appendChild(role);
        left.appendChild(stats);

        const actions = document.createElement("div");
        actions.className = "person-actions";

        const edit = document.createElement("button");
        edit.className = "icon-btn";
        edit.type = "button";
        edit.title = "Bearbeiten";
        edit.textContent = "✏️";
        edit.addEventListener("click", (e) => {
          e.stopPropagation();
          openPersonDialog(p);
        });

        const del = document.createElement("button");
        del.className = "icon-btn";
        del.type = "button";
        del.title = "Löschen";
        del.textContent = "🗑️";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          deletePerson(p.id);
        });

        actions.appendChild(edit);
        actions.appendChild(del);

        item.appendChild(left);
        item.appendChild(actions);

        item.addEventListener("click", () => {
          state.ui.activePersonId = p.id;
          saveState();
          renderAll();
          closeSidebarOnMobile();
        });

        list.appendChild(item);
      }
    };

    // Empty state
    if (all.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tiny";
      empty.textContent = "Noch keine Personen oder Gruppen. Mit '＋' hinzufügen.";
      list.appendChild(empty);
    } else {
      renderSection("Personen", persons);
      const sep = document.createElement("div");
      sep.className = "person-section-sep";
      list.appendChild(sep);
      renderSection("Gruppen / Institutionen", groups);
    }

    const ap = activePerson();
    $("#activePersonChip").textContent = ap ? ap.name : "—";
  }

  function renderWeekdays() {
    const row = $("#weekdayRow");
    const labels = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
    row.innerHTML = "";

    // KW header (left column)
    const kw = document.createElement("div");
    kw.className = "kwhead";
    kw.textContent = "KW";
    row.appendChild(kw);

    for (const l of labels) {
      const d = document.createElement("div");
      d.textContent = l;
      row.appendChild(d);
    }
  }

  let lastTouchTap = { iso: null, time: 0 };

  function renderCalendar() {
    const grid = $("#calendarGrid");
    grid.innerHTML = "";

    const [yStr, mStr] = state.ui.month.split("-");
    const y = Number(yStr);
    const m0 = Number(mStr) - 1;

    $("#calendarMonthLabel").textContent = fmtMonthLabel(y, m0);

    // sync jump inputs
    const jm = $("#jumpMonth");
    if (jm) jm.value = state.ui.month;
    const jw = $("#jumpWeek");
    if (jw) jw.value = toWeekInputValue(state.ui.selectedDay);


    const firstOfMonth = new Date(y, m0, 1);

    const weekdayMonBased = (d) => (d.getDay() + 6) % 7;
    const startOffset = weekdayMonBased(firstOfMonth);
    const startDate = new Date(y, m0, 1 - startOffset);

    const totalCells = 42;
    const today = isoToday();
    const ap = activePerson();
    const q = $("#searchInput").value;
    const selWi = getISOWeekInfo(parseISODate(state.ui.selectedDay));

    // Render 6 week rows with KW numbers on the left
    for (let w = 0; w < 6; w++) {
      const monday = new Date(startDate);
      monday.setDate(startDate.getDate() + (w * 7));
      const wi = getISOWeekInfo(monday);
      const isActiveWeek = (wi.week === selWi.week && wi.year === selWi.year);

      const kwCell = document.createElement("div");
      kwCell.className = "weeknum";
      if (isActiveWeek) kwCell.classList.add("active-week");
      kwCell.textContent = String(wi.week).padStart(2, "0");
      kwCell.title = `Kalenderwoche ${wi.week}`;
      grid.appendChild(kwCell);

      for (let dIdx = 0; dIdx < 7; dIdx++) {
        const i = (w * 7) + dIdx;
        const d = new Date(startDate);
        d.setDate(startDate.getDate() + i);
        const iso = toISODateLocal(d);
        const inMonth = d.getMonth() === m0;

        const cell = document.createElement("div");
        cell.className = "day" + (inMonth ? "" : " muted");
        if (isActiveWeek) cell.classList.add("week-active");
        cell.tabIndex = 0;

      if (iso === today) cell.classList.add("today");
      if (iso === state.ui.selectedDay) cell.classList.add("selected");

      const holName = berlinHolidays?.[iso];
      if (holName) {
        cell.classList.add("holiday");
        cell.title = `Feiertag: ${holName}`;
      }

      const num = document.createElement("div");
      num.className = "daynum";
      num.textContent = String(d.getDate());
      cell.appendChild(num);

      if (holName) {
        const hn = document.createElement("div");
        hn.className = "holidayname";
        hn.textContent = holName;
        cell.appendChild(hn);
      }

      if (ap) {
        const dayList = tasksForDay(ap.id, iso, q);
        const c = dayList.length;
        if (c > 0) {
          const badge = document.createElement("div");
          badge.className = "badge";
          badge.textContent = c > 99 ? "99+" : String(c);
          cell.appendChild(badge);
        }

        if (dayList.some(t => t.kind === "milestone")) cell.classList.add("has-milestone");
        if (dayList.some(t => t.kind === "appointment")) cell.classList.add("has-appointment");
      }

      const pick = () => {
        state.ui.selectedDay = iso;
        state.ui.month = iso.slice(0, 7);
        saveState();
        renderAll();
      };

      const openNewOnThisDay = () => {
        // Keep selection in sync
        state.ui.selectedDay = iso;
        state.ui.month = iso.slice(0, 7);
        saveState();
        renderAll();
        openTaskDialog(null, { prefillDate: iso });
      };

      cell.addEventListener("click", (e) => {
        // Desktop: click detail 2 = double click
        if (e.detail === 2) {
          openNewOnThisDay();
          return;
        }
        pick();
      });

      cell.addEventListener("pointerup", (e) => {
        if (e.pointerType !== "touch") return;

        const now = Date.now();
        if (lastTouchTap.iso === iso && (now - lastTouchTap.time) < 380) {
          lastTouchTap = { iso: null, time: 0 };
          openNewOnThisDay();
          return;
        }
        lastTouchTap = { iso, time: now };
      });

      cell.addEventListener("dblclick", (e) => {
        // Some browsers still fire dblclick on desktop
        e.preventDefault();
        openNewOnThisDay();
      });

      // Drag & Drop: Person -> day (open planning for that person)
      cell.addEventListener("dragover", (e) => {
        const pid = getDraggedPersonId(e.dataTransfer);
        if (!pid) return;
        e.preventDefault();
        cell.classList.add("dragover");
      });
      cell.addEventListener("dragleave", () => cell.classList.remove("dragover"));
      cell.addEventListener("drop", (e) => {
        const pid = getDraggedPersonId(e.dataTransfer);
        if (!pid) return;
        e.preventDefault();
        cell.classList.remove("dragover");

        state.ui.activePersonId = pid;
        state.ui.selectedDay = iso;
        state.ui.month = iso.slice(0, 7);
        saveState();
        renderAll();
        openTaskDialog(null, { prefillDate: iso, prefillAssignees: [pid] });
        closeSidebarOnMobile();
      });

      cell.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick();
        }
      });

        grid.appendChild(cell);
      }
    }

    const selIso = state.ui.selectedDay;
    const hol = berlinHolidays?.[selIso];
    const holTxt = hol ? ` · Feiertag: ${hol}` : "";
    $("#selectedDayLabel").textContent =
      `Ausgewählt: ${new Date(selIso).toLocaleDateString("de-DE", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}${holTxt}`;
  }

  
  function renderTimeline() {
    const grid = $("#timelineGrid");
    const label = $("#timelineRangeLabel");
    const printBox = $("#timelinePrint");
    if (!grid || !label) return;

    grid.innerHTML = "";
    if (printBox) printBox.innerHTML = "";

    const ap = activePerson();
    if (!ap) {
      label.textContent = "—";
      return;
    }

    const q = $("#searchInput").value;
    const rangeStart = startOfWeekISO(state.ui.selectedDay);
    const days = 14;
    const rangeEnd = addDaysISO(rangeStart, days - 1);

    const wi = getISOWeekInfo(parseISODate(rangeStart));
    label.textContent = `KW ${String(wi.week).padStart(2, "0")} · ${rangeStart} bis ${rangeEnd}`;

    grid.style.gridTemplateColumns = `minmax(170px, 260px) repeat(${days}, minmax(30px, 1fr))`;
    grid.style.gridAutoRows = "34px";

    // Corner (top-left)
    const corner = document.createElement("div");
    corner.className = "tl-label";
    corner.style.gridColumn = "1";
    corner.style.gridRow = "1";
    corner.textContent = " ";
    grid.appendChild(corner);

    // Header days
    const today = isoToday();
    const selected = state.ui.selectedDay;

    for (let i = 0; i < days; i++) {
      const iso = addDaysISO(rangeStart, i);
      const d = parseISODate(iso);
      const dayTxt = d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit" });

      const cell = document.createElement("div");
      cell.className = "tl-day" + (iso === today ? " today" : "");
      if (iso === selected) cell.style.borderColor = "var(--p2)";
      cell.style.gridColumn = String(2 + i);
      cell.style.gridRow = "1";
      cell.textContent = dayTxt.replace(".", "");
      cell.title = d.toLocaleDateString("de-DE", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      cell.addEventListener("click", () => {
        state.ui.selectedDay = iso;
        state.ui.month = iso.slice(0, 7);
        saveState();
        renderAll();
      });

      grid.appendChild(cell);
    }

    // Tasks that overlap the range
    const tasks = tasksForPerson(ap.id)
      .filter(t => filterMatch(t, q))
      .filter(t => t.status !== "done" && t.status !== "backlog" && t.start && t.end)
      .filter(t => !(t.end < rangeStart || t.start > rangeEnd))
      .slice();

    tasks.sort((a, b) => {
      const aS = (a.status === "inprogress") ? 0 : 1;
      const bS = (b.status === "inprogress") ? 0 : 1;
      if (aS !== bS) return aS - bS;
      if (a.start !== b.start) return (a.start || "").localeCompare(b.start || "");
      return (b.priority ?? 0) - (a.priority ?? 0);
    });


    // Empty state
    if (tasks.length === 0) {
      const msg = document.createElement("div");
      msg.className = "tl-empty";
      msg.style.gridColumn = `1 / span ${days + 1}`;
      msg.style.gridRow = "2";
      msg.textContent = "Keine aktiven Einträge im Zeitraum.";
      grid.appendChild(msg);

      if (printBox) {
        const p = document.createElement("div");
        p.className = "tiny muted";
        p.textContent = "Keine aktiven Einträge (nächste 14 Tage).";
        printBox.appendChild(p);
      }
      return;
    }

    const maxRows = 12;
    const shown = tasks.slice(0, maxRows);

    shown.forEach((t, idx) => {
      const row = 2 + idx;

      const icon = (t.kind === "appointment") ? "🕒" : (t.kind === "milestone" ? "🏁" : "🧩");
      const labelCell = document.createElement("div");
      labelCell.className = "tl-label";
      labelCell.style.gridColumn = "1";
      labelCell.style.gridRow = String(row);
      labelCell.title = t.note || "";
      labelCell.textContent = `${icon} ${t.title || "(ohne Titel)"}`;

      const rangeTxt = `${t.start}${t.end !== t.start ? "–" + t.end : ""}`;
      const small = document.createElement("span");
      small.className = "muted";
      small.textContent = ` · ${rangeTxt}`;
      labelCell.appendChild(small);

      labelCell.addEventListener("click", () => openTaskDialog(t, { keepSelectedDay: true }));

      grid.appendChild(labelCell);

      let s = Math.max(0, diffDaysISO(t.start, rangeStart));
      let e = Math.min(days - 1, diffDaysISO(t.end, rangeStart));
      if (e < s) e = s;

      const bar = document.createElement("div");
      bar.className = `tl-bar status-${t.status} kind-${t.kind}`;
      bar.style.gridColumn = `${2 + s} / ${2 + e + 1}`;
      bar.style.gridRow = String(row);
      bar.title = `${taskKindText(t)} · ${statusText(t.status)} · ${t.title || ""}`;
      grid.appendChild(bar);
    });

    if (tasks.length > maxRows) {
      const row = 2 + maxRows;
      const more = document.createElement("div");
      more.className = "tl-label";
      more.style.gridColumn = "1 / -1";
      more.style.gridRow = String(row);
      more.textContent = `+ ${tasks.length - maxRows} weitere Einträge (Filter nutzen)`;
      grid.appendChild(more);
    }

    // Print-friendly list (hidden on screen)
    if (printBox) {
      const lines = tasks.slice(0, 30).map(t => {
        const persons = expandedAssigneeNames(t.assignees).join(", ");
        const time = taskTimeText(t);
        const range = taskRangeText(t);
        return `${range}${time ? " · " + time : ""} · ${taskKindText(t)} · ${statusText(t.status)} · ${t.title}${persons ? " · " + persons : ""}`;
      });
      printBox.textContent = lines.join("\n");
    }
  }

  function renderPrintProjects() {
    const box = $("#printProjects");
    if (!box) return;

    const ap = activePerson();
    if (!ap) {
      box.textContent = "";
      return;
    }

    const q = $("#searchInput").value;

    const rangeStart = state.ui.selectedDay;
    const rangeEnd = addDaysISO(rangeStart, 89); // next ~90 days from selected day

    const tasks = tasksForPerson(ap.id)
      .filter(t => filterMatch(t, q))
      .filter(t => t.status !== "done" && t.status !== "backlog" && t.start && t.end)
      .filter(t => !(t.end < rangeStart || t.start > rangeEnd))
      .slice();

    tasks.sort((a, b) => {
      if (a.start !== b.start) return (a.start || "").localeCompare(b.start || "");
      return (b.priority ?? 0) - (a.priority ?? 0);
    });

    if (tasks.length === 0) {
      box.textContent = "";
      return;
    }

    box.innerHTML = "";
    const title = document.createElement("div");
    title.className = "print-projects-title";
    title.textContent = `Aktive Einträge (nächste 90 Tage ab ${rangeStart})`;
    box.appendChild(title);

    const table = document.createElement("table");
    table.className = "print-projects-table";

    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Zeitraum</th><th>Typ</th><th>Status</th><th>Personen</th><th>Titel</th></tr>";
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const t of tasks) {
      const persons = expandedAssigneeNames(t.assignees).join(", ");
      const time = taskTimeText(t);
      const period = `${taskRangeText(t)}${time ? " · " + time : ""}`;

      const tr = document.createElement("tr");
      const esc = (s) => String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

      tr.innerHTML = `<td>${esc(period)}</td>
                      <td>${esc(taskKindText(t))}</td>
                      <td>${esc(statusText(t.status))}</td>
                      <td>${esc(persons)}</td>
                      <td>${esc(t.title || "")}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
  }

function renderLists() {
    const ap = activePerson();
    const q = $("#searchInput").value;
    const selWi = getISOWeekInfo(parseISODate(state.ui.selectedDay));

    $("#dayTasks").innerHTML = "";
    $("#listMilestones").innerHTML = "";
    $("#listInProgress").innerHTML = "";
    $("#listPlanned").innerHTML = "";
    $("#listBacklog").innerHTML = "";
    $("#listDone").innerHTML = "";

    if (!ap) return;

    // Milestones overview (next 90 days)
    const from = isoToday();
    const to = addDaysISO(from, 90);
    const ms = [];
    for (const t of tasksForPerson(ap.id)) {
      if (!filterMatch(t, q)) continue;
      if (t.kind !== "milestone") continue;
      if (t.status === "done") continue;
      if (!t.start || t.isBacklog) continue;
      if (t.start < from || t.start > to) continue;
      ms.push(t);
    }
    ms.sort((a, b) => (a.start || "").localeCompare(b.start || "") || taskSort(a, b));
    $("#countMilestones").textContent = ms.length;

    if (ms.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tiny";
      empty.textContent = "Keine Meilensteine in den nächsten 90 Tagen.";
      $("#listMilestones").appendChild(empty);
    } else {
      for (const t of ms) $("#listMilestones").appendChild(taskRow(t));
    }

    const todays = tasksForDay(ap.id, state.ui.selectedDay, q);
    $("#countDay").textContent = todays.length;

    if (todays.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tiny";
      empty.textContent = "Keine Aufgaben für diesen Tag.";
      $("#dayTasks").appendChild(empty);
    } else {
      for (const t of todays) $("#dayTasks").appendChild(taskRow(t));
    }

    const inprogress = [];
    const planned = [];
    const backlog = [];
    const done = [];

    for (const t of tasksForPerson(ap.id)) {
      if (!filterMatch(t, q)) continue;

      if (t.status === "inprogress") inprogress.push(t);
      else if (t.status === "planned") planned.push(t);
      else if (t.status === "backlog") backlog.push(t);
      else if (t.status === "done") done.push(t);
    }

    inprogress.sort(taskSort);
    planned.sort(taskSort);
    backlog.sort(taskSort);
    done.sort(taskSort);

    $("#countInProgress").textContent = inprogress.length;
    $("#countPlanned").textContent = planned.length;
    $("#countBacklog").textContent = backlog.length;
    $("#countDone").textContent = done.length;

    renderBucket("#listInProgress", inprogress, "Nichts in Arbeit.");
    renderBucket("#listPlanned", planned, "Keine geplanten Aufgaben.");
    renderBucket("#listBacklog", backlog, "Backlog ist leer.");
    renderBucket("#listDone", done, "Noch nichts erledigt.");
  }

  function renderBucket(sel, arr, emptyText) {
    const el = $(sel);
    if (arr.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tiny";
      empty.textContent = emptyText;
      el.appendChild(empty);
      return;
    }
    for (const t of arr) el.appendChild(taskRow(t));
  }

  function taskRow(t) {
    const wrap = document.createElement("div");
    wrap.className = `task prio-${t.priority ?? 0}`;
    wrap.dataset.taskId = t.id;

    const main = document.createElement("div");
    main.className = "task-main";

    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = t.title || "(ohne Titel)";

    const sub = document.createElement("div");
    sub.className = "task-sub";

    // Compact meta row (keeps the lists readable and avoids tall cards)
    const pDate = document.createElement("span");
    pDate.className = "pill";
    const kIcon = (t.kind === "appointment") ? "🕒" : (t.kind === "milestone" ? "🏁" : "🧩");
    const time = taskTimeText(t);
    pDate.textContent = `${kIcon} ${taskRangeText(t)}${time ? " · " + time : ""}`;

    const pStatus = document.createElement("span");
    pStatus.className = "pill";
    pStatus.textContent = `🔖 ${statusText(t.status)}`;

    const pPrio = document.createElement("span");
    pPrio.className = "pill";
    pPrio.textContent = `⚖️ ${priorityText(t.priority ?? 0)}`;

    sub.appendChild(pDate);
    sub.appendChild(pStatus);
    sub.appendChild(pPrio);

    if (t.repeat && t.repeat !== "none") {
      const pRep = document.createElement("span");
      pRep.className = "pill";
      let rep = repeatText(t.repeat);
      if (t.repeatUntil) rep += ` bis ${t.repeatUntil}`;
      pRep.textContent = `🔁 ${rep}`;
      sub.appendChild(pRep);
    }

    const aCount = expandedAssigneePersonCount(t.assignees);
    if (aCount > 1) {
      const pA = document.createElement("span");
      pA.className = "pill";
      pA.textContent = `👥 ${aCount}`;
      pA.title = expandedAssigneeNames(t.assignees).join(", ");
      sub.appendChild(pA);
    }

    if (t.note) {
      const pN = document.createElement("span");
      pN.className = "pill";
      pN.textContent = `📝 ${t.note.length > 42 ? t.note.slice(0, 42) + "…" : t.note}`;
      sub.appendChild(pN);
    }

    main.appendChild(title);
    main.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "task-actions";

    // Primary status action (more understandable)
    if (t.status === "planned") {
      const start = document.createElement("button");
      start.className = "icon-btn";
      start.type = "button";
      start.title = "Starten (In Arbeit)";
      start.setAttribute("aria-label", "Starten");
      start.textContent = "▶";
      start.addEventListener("click", () => {
        t.status = "inprogress";
        saveState();
        renderAll();
      });
      actions.appendChild(start);
    } else if (t.status === "inprogress") {
      const pause = document.createElement("button");
      pause.className = "icon-btn";
      pause.type = "button";
      pause.title = "Pausieren (zurück zu Geplant)";
      pause.setAttribute("aria-label", "Pausieren");
      pause.textContent = "⏸";
      pause.addEventListener("click", () => {
        t.status = "planned";
        saveState();
        renderAll();
      });
      actions.appendChild(pause);
    } else if (t.status === "backlog") {
      const plan = document.createElement("button");
      plan.className = "icon-btn";
      plan.type = "button";
      plan.title = "Planen (Datum setzen)";
      plan.setAttribute("aria-label", "Planen");
      plan.textContent = "📅";
      plan.addEventListener("click", () => openTaskDialog(t, { forceBacklog: false, focusStart: true }));
      actions.appendChild(plan);
    }

    if (t.status !== "done") {
      const doneBtn = document.createElement("button");
      doneBtn.className = "icon-btn";
      doneBtn.type = "button";
      doneBtn.title = "Erledigt";
      doneBtn.setAttribute("aria-label", "Erledigt");
      doneBtn.textContent = "✅";
      doneBtn.addEventListener("click", () => markDone(t));
      actions.appendChild(doneBtn);
    } else {
      const restore = document.createElement("button");
      restore.className = "icon-btn";
      restore.type = "button";
      restore.title = "Wiederherstellen";
      restore.setAttribute("aria-label", "Wiederherstellen");
      restore.textContent = "↩";
      restore.addEventListener("click", () => {
        t.status = t.isBacklog ? "backlog" : "planned";
        t.doneAt = null;
        saveState();
        renderAll();
      });
      actions.appendChild(restore);
    }

    const edit = document.createElement("button");
    edit.className = "icon-btn";
    edit.type = "button";
    edit.title = "Bearbeiten";
    edit.setAttribute("aria-label", "Bearbeiten");
    edit.textContent = "✏️";
    edit.addEventListener("click", () => openTaskDialog(t));
    actions.appendChild(edit);

    // Drag & Drop: add another assignee by dropping a person onto the task
    wrap.addEventListener("dragover", (e) => {
      const pid = getDraggedPersonId(e.dataTransfer);
      if (!pid) return;
      e.preventDefault();
      wrap.classList.add("droptarget");
    });
    wrap.addEventListener("dragleave", () => wrap.classList.remove("droptarget"));
    wrap.addEventListener("drop", (e) => {
      const pid = getDraggedPersonId(e.dataTransfer);
      if (!pid) return;
      e.preventDefault();
      wrap.classList.remove("droptarget");

      t.assignees ??= [];
      if (!t.assignees.includes(pid)) {
        t.assignees.push(pid);
        normalizeTask(t);
        saveState();
        renderAll();
        toast(`${personNameById(pid)} hinzugefügt`);
      }
    });

    wrap.appendChild(main);
    wrap.appendChild(actions);
    return wrap;
  }

  function renderAll() {
    ensureFirstRun();
    renderSidebar();
    renderWeekdays();
    renderCalendar();
    renderTimeline();
    renderLists();
    renderAnalytics();
    updatePrintMeta();
    renderPrintProjects();
    updateSaveInfo();

    // Load holidays/ferien in the background (no blocking). When available, we re-render once.
    const [yStr, mStr] = String(state.ui.month || isoToday().slice(0, 7)).split("-");
    const y = Number(yStr);
    const m0 = Math.max(0, Number(mStr) - 1);

    if (y && holidayYearLoaded !== y && holidayYearFetching !== y) {
      ensureBerlinHolidays(y).then(() => {
        // Only re-render if we're still on the same year
        if (String(state.ui.month || "").startsWith(String(y))) renderAll();
      });
    }

    // Desktop sidebar collapsed state
    document.body.classList.toggle("sidebar-collapsed", !!state.ui.sidebarCollapsed);

    // Mobile sidebar open state
    $("#sidebar").classList.toggle("open", !!state.ui.sidebarOpen);
  }

  // ---------- Person CRUD ----------

  const personDialog = $("#personDialog");

  function updateGroupMembersVisibility() {
    const field = $("#groupMembersField");
    if (!field) return;
    field.hidden = ($("#personType").value !== "group");
  }

  function renderGroupMembersPicker(selectedIds = [], editingId = null) {
    const box = $("#groupMembers");
    if (!box) return;
    box.innerHTML = "";

    const items = sortedPeople().filter(p => p.id !== editingId);
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tiny muted";
      empty.textContent = "Keine Einträge vorhanden.";
      box.appendChild(empty);
      return;
    }

    for (const p of items) {
      const label = document.createElement("label");
      label.className = "member-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = p.id;
      cb.checked = selectedIds.includes(p.id);

      const span = document.createElement("span");
      span.textContent = `${p.type === "group" ? "Gruppe: " : ""}${p.name}${p.role ? " · " + p.role : ""}`;

      label.appendChild(cb);
      label.appendChild(span);
      box.appendChild(label);
    }
  }

  function openPersonDialog(person = null) {
    $("#personEditId").value = person?.id || "";
    $("#personDialogTitle").textContent = person ? (person.type === "group" ? "Gruppe bearbeiten" : "Person bearbeiten") : "Person hinzufügen";
    $("#personName").value = person?.name || "";
    $("#personType").value = person?.type || "person";
    $("#personRole").value = person?.role || "";
    renderGroupMembersPicker(person?.members || [], person?.id || null);
    updateGroupMembersVisibility();

    safeShowModal(personDialog);
    setTimeout(() => $("#personName").focus(), 50);
  }

  function upsertPerson(data, id = null) {
    const clean = clampStr(data?.name);
    if (!clean) return;

    const type = (data?.type === "group") ? "group" : "person";
    const role = clampStr(data?.role) || "";
    const rawMembers = Array.isArray(data?.members) ? data.members.filter(Boolean) : [];

    const validIds = new Set(state.people.map(p => p.id));
    const members = [...new Set(rawMembers.filter(mid => validIds.has(mid)))];

    if (id) {
      const p = state.people.find(x => x.id === id);
      if (p) {
        p.name = clean;
        p.type = type;
        p.role = role;
        p.members = (type === "group") ? members.filter(mid => mid !== id) : [];
      }
    } else {
      const p = normalizePerson({ id: uid(), name: clean, type, role, members, createdAt: new Date().toISOString() });
      p.members = (p.type === "group") ? p.members.filter(mid => mid !== p.id) : [];
      state.people.unshift(p);
      state.ui.activePersonId = p.id;
    }

    saveState();
    renderAll();
  }

  function deletePerson(id) {
    const p = state.people.find(x => x.id === id);
    if (!p) return;

    const onlyAssignedTasks = state.tasks.filter(t => t.assignees?.length === 1 && t.assignees[0] === id);
    const msg = `„${p.name}“ wirklich löschen?\n\nHinweis: Aufgaben, die nur dieser Person zugewiesen sind, werden ebenfalls gelöscht (${onlyAssignedTasks.length}).`;
    const ok = confirm(msg);
    if (!ok) return;

    // Remove person
    state.people = state.people.filter(x => x.id !== id);

    // Remove from group memberships
    for (const g of state.people) {
      if (g.type === "group" && Array.isArray(g.members)) {
        g.members = g.members.filter(mid => mid !== id);
      }
    }

    // Unassign tasks and drop orphans
    state.tasks = state.tasks
      .map(t => ({ ...t, assignees: (t.assignees || []).filter(a => a !== id) }))
      .filter(t => (t.assignees || []).length > 0);

    if (state.people.length > 0) {
      state.ui.activePersonId = state.people[0].id;
    } else {
      state.ui.activePersonId = null;
    }

    saveState(false);
    renderAll();
  }

  // ---------- Task CRUD ----------

  const taskDialog = $("#taskDialog");

  function renderAssigneePicker(selectedIds) {
    const box = $("#assigneeList");
    box.innerHTML = "";

    for (const p of sortedPeople()) {
      const label = document.createElement("label");
      label.className = "assignee-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = p.id;
      cb.checked = selectedIds.includes(p.id);

      const span = document.createElement("span");
      span.textContent = `${p.type === "group" ? "Gruppe: " : ""}${p.name}${p.role ? " · " + p.role : ""}`;

      label.appendChild(cb);
      label.appendChild(span);
      box.appendChild(label);
    }
  }

  function openTaskDialog(task = null, opts = {}) {
    const ap = activePerson();
    if (!ap) return;

    const isEdit = !!task;

    $("#taskEditId").value = task?.id || "";
    $("#taskDialogTitle").textContent = isEdit ? "Aufgabe bearbeiten" : "Aufgabe hinzufügen";

    const prefillDate = opts.prefillDate || state.ui.selectedDay || isoToday();

    $("#taskTitle").value = task?.title || "";
    $("#taskKind").value = task?.kind || "task";
    $("#taskPriority").value = String(task?.priority ?? 0);
    $("#taskRepeat").value = task?.repeat ?? "none";
    $("#taskRepeatUntil").value = task?.repeatUntil || "";
    $("#taskNote").value = task?.note || "";

    let isBacklog = !!task?.isBacklog;
    if (typeof opts.forceBacklog === "boolean") isBacklog = opts.forceBacklog;
    $("#taskIsBacklog").checked = isBacklog;

    const start = task?.start || prefillDate;
    const end = task?.end || start;

    $("#taskStart").value = start;
    $("#taskEnd").value = end;

    $("#taskTimeStart").value = task?.timeStart || "";
    $("#taskTimeEnd").value = task?.timeEnd || "";

    const selectedAssignees = isEdit
      ? (Array.isArray(task.assignees) ? task.assignees.slice() : [ap.id])
      : (Array.isArray(opts.prefillAssignees) && opts.prefillAssignees.length ? opts.prefillAssignees.slice() : [ap.id]);

    renderAssigneePicker(selectedAssignees);

    $("#taskDeleteBtn").style.display = isEdit ? "" : "none";

    syncKindInputs();
    syncDateInputs();
    syncRepeatInputs();
    updateTaskHint();
    safeShowModal(taskDialog);

    setTimeout(() => {
      if (!isEdit) {
        $("#taskTitle").focus();
      } else if (opts.focusStart) {
        $("#taskStart").focus();
      } else {
        $("#taskTitle").focus();
      }
    }, 60);
  }

  function syncDateInputs() {
    const isBacklog = $("#taskIsBacklog").checked;
    $("#dateRow").style.opacity = isBacklog ? ".45" : "1";
    $("#taskStart").disabled = isBacklog;
    $("#taskEnd").disabled = isBacklog || $("#taskKind").value !== "task";
  }

  function syncRepeatInputs() {
    const repeat = $("#taskRepeat").value;
    const repeatUntilRaw = clampStr($("#taskRepeatUntil").value) || "";
    const isBacklog = $("#taskIsBacklog").checked;

    const row = $("#repeatUntilRow");
    const show = repeat !== "none" && !isBacklog;
    row.classList.toggle("show", show);

    const inp = $("#taskRepeatUntil");
    inp.disabled = !show;

    // Keep input constraints in sync with chosen date
    const start = $("#taskStart").value || isoToday();
    inp.min = start;

    // If the user picked an end before start, auto-correct to start
    if (inp.value && inp.value < start) inp.value = start;
  }


  function syncKindInputs() {
    const kind = $("#taskKind").value;
    const backlogCb = $("#taskIsBacklog");

    // Appointments and milestones need a date
    if (kind === "appointment" || kind === "milestone") {
      backlogCb.checked = false;
      backlogCb.disabled = true;
      // Single day: keep end in sync and disabled
      if ($("#taskStart").value) {
        $("#taskEnd").value = $("#taskStart").value;
      }
    } else {
      backlogCb.disabled = false;
    }

    const timeRow = $("#timeRow");
    timeRow.classList.toggle("show", kind === "appointment");
    if (kind !== "appointment") {
      $("#taskTimeStart").value = "";
      $("#taskTimeEnd").value = "";
    }

    syncDateInputs();
  }

  function updateTaskHint(msg = "") {
    const el = $("#taskHint");
    const isBacklog = $("#taskIsBacklog").checked;
    const today = isoToday();

    if (msg) {
      el.textContent = msg;
      return;
    }

    if (isBacklog) {
      el.textContent = "Backlog: ohne Datum. Idee: Sammeln, später planen (Datum ergänzen) oder direkt starten.";
      return;
    }

    const kind = $("#taskKind").value;
    if (kind === "appointment") {
      el.textContent = `Termin: Datum wählen (nicht vor ${today}). Optional Uhrzeit. Ende muss ≥ Start sein.`;
      return;
    }
    if (kind === "milestone") {
      el.textContent = `Meilenstein: ein Datum (nicht vor ${today}). Ideal für Deadlines/Abgaben.`;
      return;
    }

    el.textContent = `Geplant: Startdatum beim Anlegen nicht vor ${today}. Ende muss ≥ Start sein.`;
  }

  function selectedAssigneesFromUI() {
    const checks = Array.from($("#assigneeList").querySelectorAll("input[type=checkbox]"));
    return checks.filter(c => c.checked).map(c => c.value);
  }

  function validateTaskInput(isEdit = false) {
    const title = clampStr($("#taskTitle").value);
    if (!title) return { ok: false, msg: "Bitte einen Namen vergeben." };

    const assignees = selectedAssigneesFromUI();
    if (assignees.length === 0) return { ok: false, msg: "Bitte mindestens eine Person auswählen." };

    const kind = $("#taskKind").value;
    const isBacklog = $("#taskIsBacklog").checked;
    const repeat = $("#taskRepeat").value;
    const repeatUntilRaw = clampStr($("#taskRepeatUntil").value) || "";
    const prio = Number($("#taskPriority").value);

    if (isBacklog) {
      return {
        ok: true,
        task: { title, kind: "task", assignees, isBacklog: true, start: null, end: null, timeStart: null, timeEnd: null, repeat, repeatUntil: null, priority: prio, note: $("#taskNote").value }
      };
    }

    const start = $("#taskStart").value;
    const end = (kind === "task") ? ($("#taskEnd").value || start) : start;

    if (!start) return { ok: false, msg: "Bitte ein Startdatum setzen (oder Backlog aktivieren)." };

    const today = isoToday();
    if (!isEdit && start < today) {
      return { ok: false, msg: "Startdatum liegt in der Vergangenheit. Nutze Backlog oder setze ein heutiges/futuriges Datum." };
    }

    if (end < start) return { ok: false, msg: "Enddatum muss am selben Tag oder nach dem Start liegen." };

    let repeatUntil = null;
    if (repeat !== "none" && repeatUntilRaw) {
      if (repeatUntilRaw < start) return { ok: false, msg: "Wiederholung: Enddatum muss am selben Tag oder nach dem Start liegen." };
      repeatUntil = repeatUntilRaw;
    }

    let timeStart = null;
    let timeEnd = null;
    if (kind === "appointment") {
      timeStart = clampStr($("#taskTimeStart").value) || null;
      timeEnd = clampStr($("#taskTimeEnd").value) || null;
      if (timeStart && timeEnd && timeEnd < timeStart) {
        return { ok: false, msg: "Uhrzeit: 'Bis' muss nach 'Von' liegen." };
      }
    }

    return {
      ok: true,
      task: {
        title,
        kind,
        assignees,
        isBacklog: false,
        start,
        end,
        timeStart,
        timeEnd,
        repeat,
        repeatUntil,
        priority: prio,
        note: $("#taskNote").value
      }
    };
  }

  function upsertTask(input, id = null) {
    if (id) {
      const t = state.tasks.find(x => x.id === id);
      if (!t) return;

      // Edits: allow older dates
      t.title = clampStr(input.title);
      t.kind = input.kind || "task";
      t.priority = Number(input.priority ?? 0);
      t.repeat = input.repeat ?? "none";
      t.repeatUntil = input.repeatUntil || null;
      t.note = clampStr(input.note);
      t.assignees = Array.isArray(input.assignees) ? input.assignees.slice() : [];

      t.timeStart = input.timeStart || null;
      t.timeEnd = input.timeEnd || null;

      t.isBacklog = !!input.isBacklog;
      if (t.isBacklog) {
        t.start = null;
        t.end = null;
        t.timeStart = null;
        t.timeEnd = null;
        if (t.status !== "done") t.status = "backlog";
      } else {
        t.start = input.start;
        t.end = input.end || input.start;
        if (t.status === "backlog") t.status = "planned";
      }

      normalizeTask(t);
    } else {
      const t = normalizeTask({
        id: uid(),
        title: clampStr(input.title),
        kind: input.kind || "task",
        assignees: input.assignees.slice(),
        isBacklog: !!input.isBacklog,
        start: input.isBacklog ? null : input.start,
        end: input.isBacklog ? null : (input.end || input.start),
        timeStart: input.timeStart || null,
        timeEnd: input.timeEnd || null,
        repeat: input.repeat ?? "none",
        repeatUntil: input.repeatUntil || null,
        priority: Number(input.priority ?? 0),
        note: clampStr(input.note),
        status: input.isBacklog ? "backlog" : "planned",
        createdAt: new Date().toISOString()
      });
      state.tasks.unshift(t);
    }

    // Remove orphan tasks (no assignees)
    state.tasks = state.tasks.filter(t => (t.assignees || []).length > 0);

    saveState();
    renderAll();
  }

  function deleteTask(taskId) {
    const t = state.tasks.find(x => x.id === taskId);
    if (!t) return;

    const who = (t.assignees || []).map(personNameById).join(", ");
    const suffix = (t.assignees || []).length > 1 ? `\n\nHinweis: Die Aufgabe wird bei allen zugewiesenen Personen entfernt (${who}).` : "";

    const ok = confirm(`Aufgabe „${t.title}“ löschen?${suffix}`);
    if (!ok) return;

    state.tasks = state.tasks.filter(x => x.id !== taskId);
    saveState();
    renderAll();
  }

  function markDone(t) {
    if (t.repeat && t.repeat !== "none" && !t.isBacklog) {
      const advanced = advanceRepeatingTask(t);
      if (advanced) {
        toast("Wiederholung: nächste Instanz geplant");
        saveState();
        renderAll();
        return;
      }
      // End reached: stop repeating and mark as done normally
      t.repeat = "none";
      t.repeatUntil = null;
    }

    t.status = "done";
    t.doneAt = new Date().toISOString();
    toast("Erledigt ✅");
    saveState();
    renderAll();
  }

  // ---------- Export / Import ----------

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 800);
  }

  function exportBackup() {
    const date = isoToday();
    downloadJSON(state, `BWK-Aufgabenplanung_v${APP.version}_${date}.json`);
    toast("Backup exportiert");
  }

  function downloadText(text, filename, mime = "text/plain") {
    const bom = (mime === "text/csv") ? "\ufeff" : "";
    const blob = new Blob([bom, text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 250);
  }

  function csvEscape(v) {
    const s = String(v ?? "");
    if (/[\n\r",;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function fileSlug(s) {
    return clampStr(s)
      .toLowerCase()
      .replace(/[^a-z0-9äöüß]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "person";
  }

  function exportOverviewCSV() {
    const ap = activePerson();
    if (!ap) {
      toast("Keine Person ausgewählt");
      return;
    }

    const q = $("#searchInput").value;
    const tasks = tasksForPerson(ap.id).filter(t => filterMatch(t, q)).slice();
    tasks.sort(taskSort);

    const header = [
      "Personen",
      "Typ",
      "Status",
      "Priorität",
      "Start",
      "Ende",
      "Uhrzeit_von",
      "Uhrzeit_bis",
      "Wiederholung",
      "Titel",
      "Notiz"
    ];

    const lines = [header.map(csvEscape).join(";")];
    for (const t of tasks) {
      const persons = expandedAssigneeNames(t.assignees).join(", ");
      lines.push([
        persons,
        taskKindText(t),
        statusText(t.status),
        priorityText(t.priority ?? 0),
        t.start || "",
        t.end || "",
        t.timeStart || "",
        t.timeEnd || "",
        repeatText(t.repeat),
        t.title || "",
        t.note || ""
      ].map(csvEscape).join(";"));
    }

    const date = isoToday();
    downloadText(lines.join("\n"), `BWK-Aufgabenplanung_Uebersicht_${fileSlug(ap.name)}_${date}.csv`, "text/csv");
    toast("Übersicht exportiert");
  }

  const importDialog = $("#importDialog");

  function openImportChoice(imported) {
    pendingImport = imported;
    safeShowModal(importDialog);
  }

  function normalizeIncomingToV2(obj) {
    if (!obj) return null;
    if (obj.version === 2 && Array.isArray(obj.people) && Array.isArray(obj.tasks)) {
      const s = obj;
      s.ui ??= defaultStateV2().ui;
      s.ui.theme ??= "system";
      s.ui.accent ??= "blue";
      s.people = s.people.map(p => normalizePerson(p));
      s.tasks = s.tasks.map(t => normalizeTask(t));
      s.lastSavedAt ??= null;
      return s;
    }
    if (obj.version === 1 && Array.isArray(obj.people)) {
      return migrateV1ToV2(obj);
    }
    return null;
  }

  function applyImport(mode) {
    const importedRaw = pendingImport;
    pendingImport = null;
    safeCloseModal(importDialog);

    const incoming = normalizeIncomingToV2(importedRaw);
    if (!incoming) {
      toast("Import fehlgeschlagen (Format)");
      return;
    }

    if (mode === "replace") {
      state = incoming;
      ensureFirstRun();
      saveState(false);
      renderAll();
      toast("Import: ersetzt");
      return;
    }

    // merge: people by id/name, tasks by id with collision-safe behaviour
    const byId = new Map(state.people.map(p => [p.id, p]));
    const byName = new Map(state.people.map(p => [p.name.toLowerCase(), p]));

    for (const pIn of incoming.people) {
      const nameKey = (pIn.name || "").toLowerCase();
      let target = (pIn.id && byId.get(pIn.id)) || (nameKey && byName.get(nameKey));

      if (!target) {
        const pNew = normalizePerson({ id: pIn.id || uid(), name: pIn.name, createdAt: pIn.createdAt });
        state.people.push(pNew);
        byId.set(pNew.id, pNew);
        byName.set((pNew.name || "").toLowerCase(), pNew);
      }
    }

    const existingTaskIds = new Set(state.tasks.map(t => t.id));

    for (const tInRaw of incoming.tasks) {
      const tIn = normalizeTask({ ...tInRaw });

      // ensure assignees exist in current people set
      tIn.assignees = (tIn.assignees || []).filter(pid => state.people.some(p => p.id === pid));
      if (tIn.assignees.length === 0) continue;

      if (existingTaskIds.has(tIn.id)) {
        // collision: do not overwrite. create a new id.
        tIn.id = uid();
      }

      existingTaskIds.add(tIn.id);
      state.tasks.push(tIn);
    }

    // UI sanity
    state.ui ??= defaultStateV2().ui;
    ensureFirstRun();
    saveState(false);
    renderAll();
    toast("Import: zusammengeführt");
  }

  // ---------- Dialog helpers ----------

  function safeShowModal(dlg) {
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "open");
  }

  function safeCloseModal(dlg) {
    if (typeof dlg.close === "function") dlg.close();
    else dlg.removeAttribute("open");
  }

  function closeSidebarOnMobile() {
    if (window.matchMedia("(max-width: 760px)").matches) {
      state.ui.sidebarOpen = false;
      $("#sidebar").classList.remove("open");
      saveState();
    }
  }

  // ---------- Events ----------

  $("#btnToggleSidebar").addEventListener("click", () => {
    if (window.matchMedia("(max-width: 760px)").matches) {
      state.ui.sidebarOpen = !state.ui.sidebarOpen;
      $("#sidebar").classList.toggle("open", state.ui.sidebarOpen);
    } else {
      state.ui.sidebarCollapsed = !state.ui.sidebarCollapsed;
      document.body.classList.toggle("sidebar-collapsed", state.ui.sidebarCollapsed);
    }
    saveState();
  });

  $("#btnAddPerson").addEventListener("click", () => openPersonDialog());

  $("#personForm").addEventListener("submit", (e) => e.preventDefault());

  $("#personForm").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target?.id === "personName") {
      e.preventDefault();
      $("#personSubmit").click();
    }
  });

  $("#personType").addEventListener("change", () => {
    updateGroupMembersVisibility();
  });

  $("#personSubmit").addEventListener("click", () => {
    const name = $("#personName").value;
    const type = $("#personType").value;
    const role = $("#personRole").value;

    const members = [...document.querySelectorAll("#groupMembers input[type=checkbox]:checked")]
      .map(cb => cb.value);

    const editId = $("#personEditId").value || null;
    upsertPerson({ name, type, role, members }, editId);
    safeCloseModal(personDialog);
    $("#btnToggleSidebar").disabled = (state.people.length === 0);
  });

  $("#personCancel").addEventListener("click", () => safeCloseModal(personDialog));

  $("#btnAddTask").addEventListener("click", () => {
    if (state.people.length === 0) {
      toast("Bitte erst eine Person hinzufügen");
      openPersonDialog();
      return;
    }
    openTaskDialog();
  });

  $("#taskCancel").addEventListener("click", () => safeCloseModal(taskDialog));

  $("#btnToday").addEventListener("click", () => {
    const today = isoToday();
    state.ui.selectedDay = today;
    state.ui.month = today.slice(0, 7);
    saveState();
    renderAll();
    toast("Heute ausgewählt");
  });

  $("#btnReload").addEventListener("click", () => location.reload());

  const helpDialog = $("#helpDialog");
  $("#btnHelp").addEventListener("click", () => safeShowModal(helpDialog));
  const settingsDialog = $("#settingsDialog");
  $("#btnSettings").addEventListener("click", () => {
    $("#setTheme").value = state.ui.theme || "system";
    $("#setAccent").value = state.ui.accent || "blue";
    safeShowModal(settingsDialog);
  });
  $("#settingsClose").addEventListener("click", () => safeCloseModal(settingsDialog));
  $("#settingsSave").addEventListener("click", () => {
    state.ui.theme = $("#setTheme").value;
    state.ui.accent = $("#setAccent").value;
    applyUiTheme();
    saveState();
    safeCloseModal(settingsDialog);
  });

  $("#helpClose").addEventListener("click", () => safeCloseModal(helpDialog));

  $("#btnPrint").addEventListener("click", () => window.print());

  $("#btnExportOverview").addEventListener("click", () => exportOverviewCSV());

  // Expand/collapse all right-side sections (details)
  const toggleAllBtn = document.getElementById("btnToggleAllSections");
  if (toggleAllBtn) {
    const sectionEls = () => [...document.querySelectorAll(".lists-card details.section")];
    const updateToggleAll = () => {
      const els = sectionEls();
      const allOpen = (els.length > 0) && els.every(d => d.open);
      toggleAllBtn.textContent = allOpen ? "−" : "＋";
      const label = allOpen ? "Alle Abschnitte einklappen" : "Alle Abschnitte ausklappen";
      toggleAllBtn.title = label;
      toggleAllBtn.setAttribute("aria-label", label);
    };

    toggleAllBtn.addEventListener("click", () => {
      const els = sectionEls();
      const allOpen = (els.length > 0) && els.every(d => d.open);
      els.forEach(d => { d.open = !allOpen; });
      updateToggleAll();
    });

    // Keep the button state in sync when the user toggles a single section
    sectionEls().forEach(d => d.addEventListener("toggle", updateToggleAll));
    updateToggleAll();
  }

  $("#taskIsBacklog").addEventListener("change", () => {
    // If backlog is enabled, force kind to task (appointments/milestones need a date)
    if ($("#taskIsBacklog").checked) {
      $("#taskKind").value = "task";
      $("#taskTimeStart").value = "";
      $("#taskTimeEnd").value = "";
    }
    syncKindInputs();
    syncDateInputs();
    syncRepeatInputs();
    updateTaskHint();
  });

  $("#taskKind").addEventListener("change", () => {
    syncKindInputs();
    updateTaskHint();
  });

  $("#taskStart").addEventListener("change", () => {
    const s = $("#taskStart").value;
    if ($("#taskEnd").value && $("#taskEnd").value < s) $("#taskEnd").value = s;
    if ($("#taskKind").value !== "task") $("#taskEnd").value = s;
    syncRepeatInputs();
    updateTaskHint();
  });

  $("#taskEnd").addEventListener("change", updateTaskHint);
  $("#taskRepeat").addEventListener("change", () => { syncRepeatInputs(); updateTaskHint(); });

  $("#taskDeleteBtn").addEventListener("click", () => {
    const id = $("#taskEditId").value;
    if (!id) return;
    safeCloseModal(taskDialog);
    deleteTask(id);
  });

  $("#taskSubmit").addEventListener("click", () => {
    const editId = $("#taskEditId").value || null;
    const validation = validateTaskInput(!!editId);
    if (!validation.ok) {
      updateTaskHint(validation.msg);
      toast(validation.msg);
      return;
    }

    upsertTask(validation.task, editId);
    safeCloseModal(taskDialog);
    toast(editId ? "Gespeichert" : "Hinzugefügt");
  });

  $("#btnPrevMonth").addEventListener("click", () => {
    const [yStr, mStr] = state.ui.month.split("-");
    let y = Number(yStr), m = Number(mStr);
    m -= 1;
    if (m <= 0) {
      m = 12;
      y -= 1;
    }
    state.ui.month = `${y}-${String(m).padStart(2, "0")}`;
    state.ui.selectedDay = clampDayToMonthISO(state.ui.selectedDay, state.ui.month);
    saveState();
    renderAll();
  });

  $("#btnNextMonth").addEventListener("click", () => {
    const [yStr, mStr] = state.ui.month.split("-");
    let y = Number(yStr), m = Number(mStr);
    m += 1;
    if (m >= 13) {
      m = 1;
      y += 1;
    }
    state.ui.month = `${y}-${String(m).padStart(2, "0")}`;
    state.ui.selectedDay = clampDayToMonthISO(state.ui.selectedDay, state.ui.month);
    saveState();
    renderAll();
  });

  // Quick jump: month / KW
  const jumpMonthEl = $("#jumpMonth");
  if (jumpMonthEl) {
    jumpMonthEl.addEventListener("change", () => {
      const v = String(jumpMonthEl.value || "").trim();
      if (!/^\d{4}-\d{2}$/.test(v)) return;
      state.ui.month = v;
      state.ui.selectedDay = clampDayToMonthISO(state.ui.selectedDay, v);
      saveState();
      renderAll();
    });
  }

  const jumpWeekEl = $("#jumpWeek");
  if (jumpWeekEl) {
    jumpWeekEl.addEventListener("change", () => {
      const iso = isoFromWeekInput(jumpWeekEl.value);
      if (!iso) return;
      state.ui.selectedDay = iso;
      state.ui.month = iso.slice(0, 7);
      saveState();
      renderAll();
    });
  }

  $("#btnSaveNow").addEventListener("click", () => {
    saveState(false);
    toast("Lokal gespeichert (Browser)");
  });

  $("#btnExport").addEventListener("click", exportBackup);

  $("#btnImport").addEventListener("click", () => $("#importFile").click());

  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const imported = safeParse(text);
      openImportChoice(imported);
    } catch {
      toast("Import fehlgeschlagen");
    }
  });

  $("#importCancel").addEventListener("click", () => {
    pendingImport = null;
    safeCloseModal(importDialog);
  });
  $("#importMerge").addEventListener("click", () => applyImport("merge"));
  $("#importReplace").addEventListener("click", () => applyImport("replace"));

  $("#searchInput").addEventListener("input", () => {
    renderSidebar();
    renderCalendar();
    renderLists();
    renderAnalytics();
    updatePrintMeta();
  });

  window.addEventListener("resize", () => {
    // keep analytics crisp when layout changes
    renderAnalytics();
  });

  function updatePrintMeta() {
    const ap = activePerson();
    const q = $("#searchInput").value;
    const selWi = getISOWeekInfo(parseISODate(state.ui.selectedDay));
    const d = new Date(state.ui.selectedDay);
    const dayLabel = d.toLocaleDateString("de-DE", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const filter = q ? ` · Filter: „${q}“` : "";
    $("#printMeta").textContent = ap ? `${ap.name} · ${dayLabel}${filter}` : dayLabel;
  }

  function renderAnalytics() {
    const ap = activePerson();
    const q = $("#searchInput").value;
    const selWi = getISOWeekInfo(parseISODate(state.ui.selectedDay));
    const canvas = $("#chartWorkload");
    const statusBar = $("#statusBar");
    const legend = $("#statusLegend");

    if (!ap || !canvas || !statusBar || !legend) return;

    // Status counts
    const buckets = countBuckets(ap.id, q);
    const total = buckets.inprogress + buckets.planned + buckets.backlog + buckets.done;
    $("#countOverview").textContent = total;

    // Build statusbar
    statusBar.innerHTML = "";
    legend.innerHTML = "";

    const colors = {
      inprogress: getComputedStyle(document.documentElement).getPropertyValue("--p2").trim(),
      planned: getComputedStyle(document.documentElement).getPropertyValue("--p1").trim(),
      backlog: getComputedStyle(document.documentElement).getPropertyValue("--p0").trim(),
      done: getComputedStyle(document.documentElement).getPropertyValue("--ok").trim()
    };

    const items = [
      { key: "inprogress", label: "In Arbeit", val: buckets.inprogress },
      { key: "planned", label: "Geplant", val: buckets.planned },
      { key: "backlog", label: "Backlog", val: buckets.backlog },
      { key: "done", label: "Erledigt", val: buckets.done }
    ];

    const denom = Math.max(1, total);
    for (const it of items) {
      const seg = document.createElement("div");
      seg.className = "statusseg";
      seg.style.flex = String(it.val);
      seg.style.background = colors[it.key];
      statusBar.appendChild(seg);

      const lab = document.createElement("div");
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = colors[it.key];
      lab.appendChild(dot);
      const txt = document.createElement("span");
      txt.textContent = `${it.label}: ${it.val}`;
      lab.appendChild(txt);
      legend.appendChild(lab);
    }

    // Workload next 14 days (from today)
    const startISO = isoToday();
    const days = [];
    for (let i = 0; i < 14; i++) {
      const iso = addDaysISO(startISO, i);
      const list = tasksForDay(ap.id, iso, q);
      days.push({ iso, count: list.length });
    }

    drawWorkloadChart(canvas, days);
  }

  function drawWorkloadChart(canvas, days) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cssW = Math.max(320, canvas.clientWidth || 680);
    const cssH = Math.max(140, canvas.clientHeight || 160);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cs = getComputedStyle(document.documentElement);
    const colBar = cs.getPropertyValue("--p1").trim() || "#7aa";
    const colGrid = cs.getPropertyValue("--soft2").trim() || "rgba(0,0,0,.12)";
    const colText = cs.getPropertyValue("--muted").trim() || "rgba(0,0,0,.6)";

    ctx.clearRect(0, 0, cssW, cssH);

    const pad = 10;
    const bottom = cssH - 26;
    const top = 12;
    const left = 6;
    const right = 6;
    const w = cssW - left - right;
    const h = bottom - top;

    const max = Math.max(1, ...days.map(d => d.count));

    // grid lines
    ctx.strokeStyle = colGrid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = top + (h * i / 3);
      ctx.beginPath();
      ctx.moveTo(left + pad, y);
      ctx.lineTo(cssW - right - pad, y);
      ctx.stroke();
    }

    const barW = w / days.length;
    ctx.fillStyle = colBar;
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      const bh = (d.count / max) * (h - 8);
      const x = left + i * barW + 4;
      const y = bottom - bh;
      const bw = Math.max(6, barW - 8);
      const r = 6;
      roundRect(ctx, x, y, bw, bh, r);
      ctx.fill();
    }

    // labels (weekday)
    ctx.fillStyle = colText;
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    for (let i = 0; i < days.length; i++) {
      if (i % 2 === 1) continue; // keep it compact
      const d = parseISODate(days[i].iso);
      const wd = d.toLocaleDateString("de-DE", { weekday: "short" });
      const x = left + i * barW + 6;
      ctx.fillText(wd, x, cssH - 8);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // ---------- Boot ----------

  // Normalize loaded data
  state.people = state.people.map(p => normalizePerson(p));
  state.tasks = state.tasks.map(t => normalizeTask(t));
  state.ui ??= defaultStateV2().ui;

  // remove tasks with no assignees or unknown people
  const peopleIds = new Set(state.people.map(p => p.id));
  state.tasks = state.tasks
    .map(t => ({ ...t, assignees: (t.assignees || []).filter(a => peopleIds.has(a)) }))
    .filter(t => (t.assignees || []).length > 0);

  ensureFirstRun();

  // Keep sidebar state consistent
  document.body.classList.toggle("sidebar-collapsed", !!state.ui.sidebarCollapsed);
  $("#sidebar").classList.toggle("open", !!state.ui.sidebarOpen);

  renderAll();
})();
