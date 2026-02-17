// script.js
(() => {
  const APP = {
    name: "BWK-Aufgabenplanung",
    version: "0.2",
    buildDate: "2026-02-17",
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

  function isoToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
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
    return d.toISOString().slice(0, 10);
  }

  function addMonthsISO(iso, months) {
    const d = parseISODate(iso);
    const day = d.getDate();
    d.setMonth(d.getMonth() + months);
    if (d.getDate() !== day) d.setDate(0);
    return d.toISOString().slice(0, 10);
  }

  function nextRepeatStart(iso, repeat) {
    if (repeat === "daily") return addDaysISO(iso, 1);
    if (repeat === "weekly") return addDaysISO(iso, 7);
    if (repeat === "monthly") return addMonthsISO(iso, 1);
    return iso;
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
        sidebarCollapsed: false
      },
      lastSavedAt: null
    };
  }

  function normalizePerson(p) {
    p.id ??= uid();
    p.name = clampStr(p.name) || "Unbenannt";
    p.createdAt ??= new Date().toISOString();
    return p;
  }

  function normalizeTask(t) {
    t.id ??= uid();
    t.title = clampStr(t.title) || "(ohne Titel)";
    t.note = clampStr(t.note);
    t.priority = Number(t.priority ?? 0);
    t.repeat ??= "none";

    t.isBacklog = !!t.isBacklog;
    if (t.isBacklog) {
      t.start = null;
      t.end = null;
      if (t.status !== "done") t.status = "backlog";
    } else {
      t.start = t.start || isoToday();
      t.end = t.end || t.start;
      t.status ??= "planned";
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

  function tasksForPerson(personId) {
    return state.tasks.filter(t => Array.isArray(t.assignees) && t.assignees.includes(personId));
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

  function advanceRepeatingTask(t) {
    if (t.isBacklog || t.repeat === "none") return;

    const start = t.start;
    const end = t.end ?? t.start;

    const ds = parseISODate(start);
    const de = parseISODate(end);
    const durDays = Math.max(0, Math.round((de - ds) / 86400000));

    const newStart = nextRepeatStart(start, t.repeat);
    const newEnd = addDaysISO(newStart, durDays);

    t.start = newStart;
    t.end = newEnd;
    t.status = "planned";
    t.doneAt = null;
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
    if (state.people.length === 0) {
      openPersonDialog();
      $("#btnToggleSidebar").disabled = true;
      return;
    }

    $("#btnToggleSidebar").disabled = false;
    if (!state.ui.activePersonId || !activePerson()) {
      state.ui.activePersonId = state.people[0].id;
    }
  }

  // ---------- Rendering ----------

  function renderSidebar() {
    const list = $("#personList");
    list.innerHTML = "";

    const q = $("#searchInput").value;

    for (const p of state.people) {
      const isActive = p.id === state.ui.activePersonId;
      const counts = countBuckets(p.id, q);

      const item = document.createElement("div");
      item.className = "person-item" + (isActive ? " active" : "");

      const left = document.createElement("div");
      left.style.minWidth = "0";

      const name = document.createElement("div");
      name.className = "person-name";
      name.textContent = p.name;

      const meta = document.createElement("div");
      meta.className = "person-meta";
      meta.textContent = `🟠 ${counts.inprogress}  |  🗓 ${counts.planned}  |  📦 ${counts.backlog}`;

      left.appendChild(name);
      left.appendChild(meta);

      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.gap = "6px";

      const edit = document.createElement("button");
      edit.className = "icon-btn";
      edit.type = "button";
      edit.title = "Umbenennen";
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

    const ap = activePerson();
    $("#activePersonChip").textContent = ap ? ap.name : "—";
  }

  function renderWeekdays() {
    const row = $("#weekdayRow");
    const labels = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
    row.innerHTML = "";
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

    const firstOfMonth = new Date(y, m0, 1);

    const weekdayMonBased = (d) => (d.getDay() + 6) % 7;
    const startOffset = weekdayMonBased(firstOfMonth);
    const startDate = new Date(y, m0, 1 - startOffset);

    const totalCells = 42;
    const today = isoToday();
    const ap = activePerson();
    const q = $("#searchInput").value;

    for (let i = 0; i < totalCells; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const inMonth = d.getMonth() === m0;

      const cell = document.createElement("div");
      cell.className = "day" + (inMonth ? "" : " muted");
      cell.tabIndex = 0;

      if (iso === today) cell.classList.add("today");
      if (iso === state.ui.selectedDay) cell.classList.add("selected");

      const num = document.createElement("div");
      num.className = "daynum";
      num.textContent = String(d.getDate());
      cell.appendChild(num);

      if (ap) {
        const c = tasksForDay(ap.id, iso, q).length;
        if (c > 0) {
          const badge = document.createElement("div");
          badge.className = "badge";
          badge.textContent = c > 99 ? "99+" : String(c);
          cell.appendChild(badge);
        }
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

      cell.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick();
        }
      });

      grid.appendChild(cell);
    }

    $("#selectedDayLabel").textContent =
      `Ausgewählt: ${new Date(state.ui.selectedDay).toLocaleDateString("de-DE", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;
  }

  function renderLists() {
    const ap = activePerson();
    const q = $("#searchInput").value;

    $("#dayTasks").innerHTML = "";
    $("#listInProgress").innerHTML = "";
    $("#listPlanned").innerHTML = "";
    $("#listBacklog").innerHTML = "";
    $("#listDone").innerHTML = "";

    if (!ap) return;

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

    const p1 = document.createElement("span");
    p1.className = "pill";
    p1.textContent = `📅 ${taskRangeText(t)}`;

    const p2 = document.createElement("span");
    p2.className = "pill";
    p2.textContent = `⚖️ ${priorityText(t.priority ?? 0)}`;

    const p3 = document.createElement("span");
    p3.className = "pill";
    p3.textContent = `🔁 ${repeatText(t.repeat)}`;

    const p4 = document.createElement("span");
    p4.className = "pill";
    p4.textContent = `🔖 ${statusText(t.status)}`;

    sub.appendChild(p1);
    sub.appendChild(p2);
    sub.appendChild(p3);
    sub.appendChild(p4);

    if (t.assignees?.length > 1) {
      const pA = document.createElement("span");
      pA.className = "pill";
      pA.textContent = `👥 ${t.assignees.length}`;
      pA.title = t.assignees.map(personNameById).join(", ");
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

    wrap.appendChild(main);
    wrap.appendChild(actions);
    return wrap;
  }

  function renderAll() {
    ensureFirstRun();
    renderSidebar();
    renderWeekdays();
    renderCalendar();
    renderLists();
    updateSaveInfo();

    // Desktop sidebar collapsed state
    document.body.classList.toggle("sidebar-collapsed", !!state.ui.sidebarCollapsed);

    // Mobile sidebar open state
    $("#sidebar").classList.toggle("open", !!state.ui.sidebarOpen);
  }

  // ---------- Person CRUD ----------

  const personDialog = $("#personDialog");

  function openPersonDialog(person = null) {
    $("#personEditId").value = person?.id || "";
    $("#personDialogTitle").textContent = person ? "Person umbenennen" : "Person hinzufügen";
    $("#personName").value = person?.name || "";
    safeShowModal(personDialog);
    setTimeout(() => $("#personName").focus(), 50);
  }

  function upsertPerson(name, id = null) {
    const clean = clampStr(name);
    if (!clean) return;

    if (id) {
      const p = state.people.find(x => x.id === id);
      if (p) p.name = clean;
    } else {
      const p = normalizePerson({ id: uid(), name: clean, createdAt: new Date().toISOString() });
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

    for (const p of state.people) {
      const label = document.createElement("label");
      label.className = "assignee-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = p.id;
      cb.checked = selectedIds.includes(p.id);

      const span = document.createElement("span");
      span.textContent = p.name;

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
    $("#taskPriority").value = String(task?.priority ?? 0);
    $("#taskRepeat").value = task?.repeat ?? "none";
    $("#taskNote").value = task?.note || "";

    let isBacklog = !!task?.isBacklog;
    if (typeof opts.forceBacklog === "boolean") isBacklog = opts.forceBacklog;
    $("#taskIsBacklog").checked = isBacklog;

    const start = task?.start || prefillDate;
    const end = task?.end || start;

    $("#taskStart").value = start;
    $("#taskEnd").value = end;

    const selectedAssignees = isEdit
      ? (Array.isArray(task.assignees) ? task.assignees.slice() : [ap.id])
      : [ap.id];

    renderAssigneePicker(selectedAssignees);

    $("#taskDeleteBtn").style.display = isEdit ? "" : "none";

    syncDateInputs();
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
    $("#taskEnd").disabled = isBacklog;
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

    const isBacklog = $("#taskIsBacklog").checked;
    const repeat = $("#taskRepeat").value;
    const prio = Number($("#taskPriority").value);

    if (isBacklog) {
      return {
        ok: true,
        task: { title, assignees, isBacklog: true, start: null, end: null, repeat, priority: prio, note: $("#taskNote").value }
      };
    }

    const start = $("#taskStart").value;
    const end = $("#taskEnd").value || start;

    if (!start) return { ok: false, msg: "Bitte ein Startdatum setzen (oder Backlog aktivieren)." };

    const today = isoToday();
    if (!isEdit && start < today) {
      return { ok: false, msg: "Startdatum liegt in der Vergangenheit. Nutze Backlog oder setze ein heutiges/futuriges Datum." };
    }

    if (end < start) return { ok: false, msg: "Enddatum muss am selben Tag oder nach dem Start liegen." };

    return {
      ok: true,
      task: {
        title,
        assignees,
        isBacklog: false,
        start,
        end,
        repeat,
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
      t.priority = Number(input.priority ?? 0);
      t.repeat = input.repeat ?? "none";
      t.note = clampStr(input.note);
      t.assignees = Array.isArray(input.assignees) ? input.assignees.slice() : [];

      t.isBacklog = !!input.isBacklog;
      if (t.isBacklog) {
        t.start = null;
        t.end = null;
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
        assignees: input.assignees.slice(),
        isBacklog: !!input.isBacklog,
        start: input.isBacklog ? null : input.start,
        end: input.isBacklog ? null : (input.end || input.start),
        repeat: input.repeat ?? "none",
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
      advanceRepeatingTask(t);
      toast("Wiederholung: nächste Instanz geplant");
      saveState();
      renderAll();
      return;
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

  $("#personSubmit").addEventListener("click", () => {
    const name = $("#personName").value;
    const editId = $("#personEditId").value || null;
    upsertPerson(name, editId);
    safeCloseModal(personDialog);
    $("#btnToggleSidebar").disabled = (state.people.length === 0);
  });

  $("#btnAddTask").addEventListener("click", () => openTaskDialog());

  $("#taskIsBacklog").addEventListener("change", () => {
    syncDateInputs();
    updateTaskHint();
  });

  $("#taskStart").addEventListener("change", () => {
    const s = $("#taskStart").value;
    if ($("#taskEnd").value && $("#taskEnd").value < s) $("#taskEnd").value = s;
    updateTaskHint();
  });

  $("#taskEnd").addEventListener("change", updateTaskHint);
  $("#taskRepeat").addEventListener("change", updateTaskHint);

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
    saveState();
    renderAll();
  });

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
  });

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
