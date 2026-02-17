// script.js
(() => {
  const STORAGE_KEY = "bwk_aufgabenplanung_v1";

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

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

  function isoToday() {
    const d = new Date();
    d.setHours(0,0,0,0);
    return d.toISOString().slice(0,10);
  }

  function parseISODate(iso) {
    // iso: YYYY-MM-DD
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }

  function fmtMonthLabel(year, monthIndex0) {
    const d = new Date(year, monthIndex0, 1);
    return d.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  }

  function clampStr(s) {
    return String(s ?? "").trim();
  }

  function taskRangeText(t) {
    if (t.isBacklog) return "Backlog";
    if (!t.start || !t.end) return "—";
    if (t.start === t.end) return t.start;
    return `${t.start} → ${t.end}`;
  }

  function repeatText(t) {
    switch (t.repeat) {
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

  function isDateInRange(dayISO, startISO, endISO) {
    return dayISO >= startISO && dayISO <= endISO;
  }

  function addDaysISO(iso, days) {
    const d = parseISODate(iso);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0,10);
  }

  function addMonthsISO(iso, months) {
    const d = parseISODate(iso);
    const day = d.getDate();
    d.setMonth(d.getMonth() + months);

    // "Monatsende"-Kante glätten (z.B. 31. -> nächster Monat ohne 31)
    // Trick: falls wir "rutschen", zurück auf letzten Tag des Zielmonats.
    if (d.getDate() !== day) {
      d.setDate(0);
    }
    return d.toISOString().slice(0,10);
  }

  function nextRepeatStart(iso, repeat) {
    if (repeat === "daily") return addDaysISO(iso, 1);
    if (repeat === "weekly") return addDaysISO(iso, 7);
    if (repeat === "monthly") return addMonthsISO(iso, 1);
    return iso;
  }

  function advanceRepeatingTask(t) {
    // Verschiebt Start/Ende gleich weit weiter
    if (t.isBacklog || t.repeat === "none") return;

    const start = t.start;
    const end = t.end ?? t.start;

    // Dauer berechnen (inkl. Starttag)
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

  function defaultState() {
    const today = isoToday();
    const ym = today.slice(0,7);
    return {
      version: 1,
      people: [],
      ui: {
        activePersonId: null,
        month: ym,            // YYYY-MM
        selectedDay: today,   // YYYY-MM-DD
        sidebarOpen: false
      },
      lastSavedAt: null
    };
  }

  function safeParse(json) {
    try { return JSON.parse(json); } catch { return null; }
  }

  function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();

    const parsed = safeParse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.people)) {
      return defaultState();
    }

    // Minimal defensive fixes:
    parsed.ui ??= defaultState().ui;
    parsed.ui.selectedDay ??= isoToday();
    parsed.ui.month ??= isoToday().slice(0,7);
    parsed.lastSavedAt ??= null;

    return parsed;
  }

  let state = loadState();
  let pendingImport = null;
  let saveTimer = null;

  function saveState(debounced = true) {
    if (!debounced) {
      state.lastSavedAt = new Date().toISOString();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      updateSaveInfo();
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      state.lastSavedAt = new Date().toISOString();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      updateSaveInfo();
    }, 120);
  }

  function updateSaveInfo() {
    const el = $("#saveInfo");
    if (!state.lastSavedAt) {
      el.textContent = "Noch nicht gespeichert";
      return;
    }
    const d = new Date(state.lastSavedAt);
    el.textContent = `Zuletzt gespeichert: ${d.toLocaleString("de-DE")}`;
  }

  function activePerson() {
    return state.people.find(p => p.id === state.ui.activePersonId) || null;
  }

  function ensureFirstRun() {
    if (state.people.length === 0) {
      // First-run: direkt Person anlegen lassen
      openPersonDialog();
      $("#btnToggleSidebar").disabled = true;
    } else {
      $("#btnToggleSidebar").disabled = false;
      if (!state.ui.activePersonId || !activePerson()) {
        state.ui.activePersonId = state.people[0].id;
      }
    }
  }

  // ---------- Rendering ----------

  function renderSidebar() {
    const list = $("#personList");
    list.innerHTML = "";

    state.people.forEach(p => {
      const isActive = p.id === state.ui.activePersonId;

      const counts = countBuckets(p, $("#searchInput").value);
      const meta = `🟠 ${counts.inprogress}  |  🗓 ${counts.planned}  |  📦 ${counts.backlog}`;

      const item = document.createElement("div");
      item.className = "person-item" + (isActive ? " active" : "");
      item.dataset.personId = p.id;

      const left = document.createElement("div");
      left.style.minWidth = "0";

      const name = document.createElement("div");
      name.className = "person-name";
      name.textContent = p.name;

      const m = document.createElement("div");
      m.className = "person-meta";
      m.textContent = meta;

      left.appendChild(name);
      left.appendChild(m);

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
    });

    const ap = activePerson();
    $("#activePersonChip").textContent = ap ? ap.name : "—";
  }

  function renderWeekdays() {
    const row = $("#weekdayRow");
    const labels = ["Mo","Di","Mi","Do","Fr","Sa","So"];
    row.innerHTML = "";
    labels.forEach(l => {
      const d = document.createElement("div");
      d.textContent = l;
      row.appendChild(d);
    });
  }

  function renderCalendar() {
    const grid = $("#calendarGrid");
    grid.innerHTML = "";

    const [yStr, mStr] = state.ui.month.split("-");
    const y = Number(yStr);
    const m0 = Number(mStr) - 1;

    $("#calendarMonthLabel").textContent = fmtMonthLabel(y, m0);

    const firstOfMonth = new Date(y, m0, 1);
    const lastOfMonth = new Date(y, m0 + 1, 0);

    // Wochenstart Montag: JS getDay() => So=0 ... Sa=6
    const weekdayMonBased = (d) => (d.getDay() + 6) % 7; // Mo=0 ... So=6

    const startOffset = weekdayMonBased(firstOfMonth);
    const startDate = new Date(y, m0, 1 - startOffset);

    const totalCells = 42; // 6 Wochen
    const today = isoToday();
    const ap = activePerson();

    for (let i = 0; i < totalCells; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const iso = d.toISOString().slice(0,10);
      const inMonth = (d.getMonth() === m0);

      const cell = document.createElement("div");
      cell.className = "day" + (inMonth ? "" : " muted");
      cell.tabIndex = 0;

      if (iso === today) cell.classList.add("today");
      if (iso === state.ui.selectedDay) cell.classList.add("selected");

      const num = document.createElement("div");
      num.className = "daynum";
      num.textContent = String(d.getDate());
      cell.appendChild(num);

      // Badge: Anzahl Aufgaben an diesem Tag (ohne erledigte)
      if (ap) {
        const c = tasksForDay(ap, iso, $("#searchInput").value).length;
        if (c > 0) {
          const badge = document.createElement("div");
          badge.className = "badge";
          badge.textContent = c > 99 ? "99+" : String(c);
          cell.appendChild(badge);
        }
      }

      const pick = () => {
        state.ui.selectedDay = iso;
        // month ggf. mitziehen, wenn user in grauen Zellen klickt
        state.ui.month = iso.slice(0,7);
        saveState();
        renderAll();
      };

      cell.addEventListener("click", pick);
      cell.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick();
        }
      });

      grid.appendChild(cell);
    }

    $("#selectedDayLabel").textContent =
      `Ausgewählt: ${new Date(state.ui.selectedDay).toLocaleDateString("de-DE", { weekday: "long", year:"numeric", month:"long", day:"numeric" })}`;
  }

  function normalizeTask(t) {
    t.id ??= uid();
    t.title = clampStr(t.title);
    t.note = clampStr(t.note);
    t.priority = Number(t.priority ?? 0);
    t.repeat ??= "none";
    t.status ??= t.isBacklog ? "backlog" : "planned";
    t.createdAt ??= new Date().toISOString();
    return t;
  }

  function filterMatch(t, q) {
    const s = clampStr(q).toLowerCase();
    if (!s) return true;
    const hay = `${t.title} ${t.note ?? ""}`.toLowerCase();
    return hay.includes(s);
  }

  function taskSort(a, b) {
    // Priorität desc, dann früheres Ende/Start, dann Titel
    const p = (b.priority ?? 0) - (a.priority ?? 0);
    if (p !== 0) return p;

    const aKey = a.isBacklog ? "9999-12-31" : (a.end || a.start || "9999-12-31");
    const bKey = b.isBacklog ? "9999-12-31" : (b.end || b.start || "9999-12-31");
    if (aKey !== bKey) return aKey.localeCompare(bKey);

    return (a.title || "").localeCompare(b.title || "");
  }

  function tasksForDay(person, dayISO, q) {
    const list = [];
    for (const t of (person.tasks || [])) {
      if (t.status === "done") continue;
      if (t.isBacklog) continue;
      if (!filterMatch(t, q)) continue;

      const start = t.start;
      const end = t.end || t.start;
      if (start && end && isDateInRange(dayISO, start, end)) list.push(t);
    }
    return list.sort(taskSort);
  }

  function countBuckets(person, q) {
    const out = { inprogress: 0, planned: 0, backlog: 0, done: 0 };
    for (const t of (person.tasks || [])) {
      if (!filterMatch(t, q)) continue;
      if (t.status === "inprogress") out.inprogress++;
      else if (t.status === "planned") out.planned++;
      else if (t.status === "backlog") out.backlog++;
      else if (t.status === "done") out.done++;
    }
    return out;
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

    // Tagesliste
    const todays = tasksForDay(ap, state.ui.selectedDay, q);
    if (todays.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tiny";
      empty.textContent = "Keine Aufgaben für diesen Tag.";
      $("#dayTasks").appendChild(empty);
    } else {
      todays.forEach(t => $("#dayTasks").appendChild(taskRow(ap, t)));
    }

    // Buckets
    const inprogress = [];
    const planned = [];
    const backlog = [];
    const done = [];

    for (const raw of (ap.tasks || [])) {
      const t = raw; // already normalized
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

    renderBucket("#listInProgress", ap, inprogress, "Nichts in Arbeit.");
    renderBucket("#listPlanned", ap, planned, "Keine geplanten Aufgaben.");
    renderBucket("#listBacklog", ap, backlog, "Backlog ist leer.");
    renderBucket("#listDone", ap, done, "Noch nichts erledigt.");
  }

  function renderBucket(sel, person, arr, emptyText) {
    const el = $(sel);
    if (arr.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tiny";
      empty.textContent = emptyText;
      el.appendChild(empty);
      return;
    }
    arr.forEach(t => el.appendChild(taskRow(person, t)));
  }

  function taskRow(person, t) {
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
    p3.textContent = `🔁 ${repeatText(t)}`;

    sub.appendChild(p1);
    sub.appendChild(p2);
    sub.appendChild(p3);

    if (t.note) {
      const p4 = document.createElement("span");
      p4.className = "pill";
      p4.textContent = `📝 ${t.note.length > 42 ? t.note.slice(0,42) + "…" : t.note}`;
      sub.appendChild(p4);
    }

    main.appendChild(title);
    main.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "task-actions";

    const edit = document.createElement("button");
    edit.className = "icon-btn";
    edit.type = "button";
    edit.title = "Bearbeiten";
    edit.textContent = "✏️";
    edit.addEventListener("click", () => openTaskDialog(t));

    if (t.status === "planned") {
      const start = document.createElement("button");
      start.className = "icon-btn";
      start.type = "button";
      start.title = "In Arbeit";
      start.textContent = "▶️";
      start.addEventListener("click", () => {
        t.status = "inprogress";
        saveState();
        renderAll();
      });
      actions.appendChild(start);
    }

    if (t.status === "inprogress") {
      const pause = document.createElement("button");
      pause.className = "icon-btn";
      pause.type = "button";
      pause.title = "Zurück zu Geplant";
      pause.textContent = "⏸️";
      pause.addEventListener("click", () => {
        t.status = t.isBacklog ? "backlog" : "planned";
        saveState();
        renderAll();
      });
      actions.appendChild(pause);
    }

    if (t.status !== "done") {
      const done = document.createElement("icon-btn");
      const doneBtn = document.createElement("button");
      doneBtn.className = "icon-btn";
      doneBtn.type = "button";
      doneBtn.title = "Erledigt";
      doneBtn.textContent = "✅";
      doneBtn.addEventListener("click", () => markDone(t));
      actions.appendChild(doneBtn);
    } else {
      const restore = document.createElement("button");
      restore.className = "icon-btn";
      restore.type = "button";
      restore.title = "Wiederherstellen";
      restore.textContent = "↩️";
      restore.addEventListener("click", () => {
        t.status = t.isBacklog ? "backlog" : "planned";
        t.doneAt = null;
        saveState();
        renderAll();
      });
      actions.appendChild(restore);
    }

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
      const p = { id: uid(), name: clean, createdAt: new Date().toISOString(), tasks: [] };
      state.people.unshift(p);
      state.ui.activePersonId = p.id;
    }
    saveState();
    renderAll();
  }

  function deletePerson(id) {
    const p = state.people.find(x => x.id === id);
    if (!p) return;

    const ok = confirm(`„${p.name}“ wirklich löschen? (Alle Aufgaben dieser Person werden entfernt)`);
    if (!ok) return;

    state.people = state.people.filter(x => x.id !== id);
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

  function openTaskDialog(task = null) {
    const ap = activePerson();
    if (!ap) return;

    $("#taskEditId").value = task?.id || "";
    $("#taskDialogTitle").textContent = task ? "Aufgabe bearbeiten" : "Aufgabe hinzufügen";
    $("#taskTitle").value = task?.title || "";
    $("#taskPriority").value = String(task?.priority ?? 0);
    $("#taskRepeat").value = task?.repeat ?? "none";
    $("#taskNote").value = task?.note || "";

    const isBacklog = !!task?.isBacklog;
    $("#taskIsBacklog").checked = isBacklog;

    const today = isoToday();
    const start = task?.start || today;
    const end = task?.end || start;

    $("#taskStart").value = start;
    $("#taskEnd").value = end;

    $("#taskDeleteBtn").style.display = task ? "" : "none";

    syncDateInputs();
    updateTaskHint();
    safeShowModal(taskDialog);
    setTimeout(() => $("#taskTitle").focus(), 50);
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
      el.textContent = "Backlog: ohne Datum, jederzeit erlaubt. Du kannst später Start/Ende ergänzen.";
      return;
    }
    el.textContent = `Geplant: Startdatum beim Anlegen nicht vor ${today}. Ende muss ≥ Start sein.`;
  }

  function validateTaskInput(isEdit = false) {
    const title = clampStr($("#taskTitle").value);
    if (!title) return { ok: false, msg: "Bitte einen Namen vergeben." };

    const isBacklog = $("#taskIsBacklog").checked;
    const repeat = $("#taskRepeat").value;
    const prio = Number($("#taskPriority").value);

    if (isBacklog) {
      return { ok: true, task: { title, isBacklog: true, start: null, end: null, repeat, priority: prio, note: $("#taskNote").value } };
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
    const ap = activePerson();
    if (!ap) return;

    if (id) {
      const t = ap.tasks.find(x => x.id === id);
      if (!t) return;

      // Edit: Start darf in Vergangenheit liegen (bestehende Daten nicht blocken)
      t.title = clampStr(input.title);
      t.priority = Number(input.priority ?? 0);
      t.repeat = input.repeat ?? "none";
      t.note = clampStr(input.note);
      t.isBacklog = !!input.isBacklog;

      if (t.isBacklog) {
        t.start = null;
        t.end = null;
        t.status = "backlog";
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
        isBacklog: !!input.isBacklog,
        start: input.isBacklog ? null : input.start,
        end: input.isBacklog ? null : (input.end || input.start),
        repeat: input.repeat ?? "none",
        priority: Number(input.priority ?? 0),
        note: clampStr(input.note),
        status: input.isBacklog ? "backlog" : "planned",
        createdAt: new Date().toISOString()
      });
      ap.tasks.unshift(t);
    }

    saveState();
    renderAll();
  }

  function deleteTask(taskId) {
    const ap = activePerson();
    if (!ap) return;
    const t = ap.tasks.find(x => x.id === taskId);
    if (!t) return;

    const ok = confirm(`Aufgabe „${t.title}“ löschen?`);
    if (!ok) return;

    ap.tasks = ap.tasks.filter(x => x.id !== taskId);
    saveState();
    renderAll();
  }

  function markDone(t) {
    // Repeat: direkt weiterschieben statt "done" zu parken
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
    downloadJSON(state, `BWK-Aufgabenplanung_${date}.json`);
    toast("Backup exportiert");
  }

  const importDialog = $("#importDialog");

  function openImportChoice(imported) {
    pendingImport = imported;
    safeShowModal(importDialog);
  }

  function applyImport(mode) {
    const imported = pendingImport;
    pendingImport = null;
    safeCloseModal(importDialog);

    if (!imported || imported.version !== 1 || !Array.isArray(imported.people)) {
      toast("Import fehlgeschlagen (Format)");
      return;
    }

    if (mode === "replace") {
      state = imported;
    } else {
      // merge: Personen nach Name/ID zusammenführen, Tasks nach ID
      const byId = new Map(state.people.map(p => [p.id, p]));
      const byName = new Map(state.people.map(p => [p.name.toLowerCase(), p]));

      for (const pIn of imported.people) {
        const nameKey = (pIn.name || "").toLowerCase();
        let target = (pIn.id && byId.get(pIn.id)) || (nameKey && byName.get(nameKey));

        if (!target) {
          target = { id: pIn.id || uid(), name: pIn.name || "Unbenannt", createdAt: pIn.createdAt || new Date().toISOString(), tasks: [] };
          state.people.push(target);
          byId.set(target.id, target);
          byName.set((target.name || "").toLowerCase(), target);
        }

        const existingTaskIds = new Set((target.tasks || []).map(t => t.id));
        for (const tIn of (pIn.tasks || [])) {
          const t = normalizeTask({ ...tIn });
          if (!existingTaskIds.has(t.id)) {
            target.tasks.push(t);
            existingTaskIds.add(t.id);
          }
        }
      }
    }

    // UI sanieren
    state.ui ??= defaultState().ui;
    ensureFirstRun();
    saveState(false);
    renderAll();
    toast(mode === "replace" ? "Import: ersetzt" : "Import: zusammengeführt");
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
    state.ui.sidebarOpen = !state.ui.sidebarOpen;
    $("#sidebar").classList.toggle("open", state.ui.sidebarOpen);
    saveState();
  });

  $("#btnAddPerson").addEventListener("click", () => openPersonDialog());

  $("#personForm").addEventListener("submit", (e) => {
    e.preventDefault();
  });

  $("#personDialog").addEventListener("close", () => {
    // no-op
  });

  $("#personForm").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target?.id === "personName") {
      e.preventDefault();
      $("#personSubmit").click();
    }
  });

  $("#personSubmit").addEventListener("click", (e) => {
    const name = $("#personName").value;
    const editId = $("#personEditId").value || null;
    upsertPerson(name, editId);
    safeCloseModal(personDialog);
    $("#btnToggleSidebar").disabled = (state.people.length === 0);
  });

  $("#btnAddTask").addEventListener("click", () => openTaskDialog());
  $("#taskIsBacklog").addEventListener("change", () => { syncDateInputs(); updateTaskHint(); });

  $("#taskStart").addEventListener("change", () => {
    // Enddatum bei Bedarf nachziehen
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
    if (m <= 0) { m = 12; y -= 1; }
    state.ui.month = `${y}-${String(m).padStart(2,"0")}`;
    saveState();
    renderAll();
  });

  $("#btnNextMonth").addEventListener("click", () => {
    const [yStr, mStr] = state.ui.month.split("-");
    let y = Number(yStr), m = Number(mStr);
    m += 1;
    if (m >= 13) { m = 1; y += 1; }
    state.ui.month = `${y}-${String(m).padStart(2,"0")}`;
    saveState();
    renderAll();
  });

  $("#btnSaveNow").addEventListener("click", () => {
    saveState(false);
    toast("Lokal gespeichert");
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
  function normalizeAll() {
    for (const p of state.people) {
      p.id ??= uid();
      p.name = clampStr(p.name) || "Unbenannt";
      p.tasks ??= [];
      p.tasks = p.tasks.map(t => normalizeTask(t));
    }
  }

  normalizeAll();
  ensureFirstRun();

  // Sidebar state on mobile
  $("#sidebar").classList.toggle("open", !!state.ui.sidebarOpen);

  renderAll();
})();
