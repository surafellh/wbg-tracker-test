import "./style.css";
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import { applyPlugin } from "jspdf-autotable";
import { createData, configError, getSession, planFromRow, EVIDENCE, fileType } from "./data.js";
import { LOCKED, planOps, needsApproval, applyOps, isApproverName, addisToday, addisWeekStart, weekStartOf, weekEndOf, nextWeekOf, prevWeekOf, DEFAULT_APPROVERS } from "./rules.js";
import { unitAlerts, levelRank, BLOCKED_DAYS } from "./alerts.js";
import { renderDashboard } from "./dashboard.js";
import { createExtras } from "./extras.js";
applyPlugin(jsPDF); window.jspdf = { jsPDF }; window.XLSX = XLSX;

(() => {
  const STATUSES = ["Not started","In progress","Done","Blocked","Delayed"];
  const PRIORITIES = ["High","Medium","Low"];
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const pad = n => String(n).padStart(2,"0");
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const parse = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d); };
  const mondayOf = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const wd = (x.getDay()+6)%7; x.setDate(x.getDate()-wd); return x; };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate()+n); return iso(d); };
  const fmt = s => { if(!s) return ""; const d = parse(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  const weekLabel = w => { const a = parse(w), b = parse(weekEndOf(w)); return a.getMonth()===b.getMonth() ? `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}` : `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`; };
  const uid = () => Math.random().toString(36).slice(2,10);
  const statusClass = s => s==="Done"?"s-done":s==="In progress"?"s-prog":s==="Blocked"?"s-bad":(s==="Not started"||s==="Delayed")?"s-not":"s-none";
  const todayIso = addisToday();
  const who = t => [t.dept, t.owner].filter(Boolean).join(" · ");

  const state = {
    week: addisWeekStart(),
    tab: "dashboard",
    units: [], unitsLoaded: false,
    plans: {}, plansLoaded: false,
    editUnit: null, draft: null, dirty: false, remoteChanged: false,
    
    confirmDelete: null,
    names: {}, activity: [], actLoaded: false, actErr: "", actFilter: { unit: "", who: "", action: "" },
    imp: null, impUnit: "", impPrefill: false, impDefaultUnit: "", importing: false,
    monthBasis: "end", monthByDept: false, monthData: null, monthLoading: false, monthKey: "",
  };
  let db = null, api = null, downloads = null, myId = null, isOwner = false, session = null, dataMode = "";
  // rights: what the current person may do. Checked again by the database on every save.
  let rights = { unitOk: false, approver: false };
  state.requests = []; state.approverNames = DEFAULT_APPROVERS; state.dash = { type: "", range: 8 }; state.dashData = null; state.dashKey = "";
  state.history = null; state.lastSave = null; state.base = {}; state.unlock = new Set(); state.pinStatus = null; state.reqNotes = {};
  const auth = () => { const s = session ? session.get() : {}; return { name: (s.name || "").trim(), unit: s.unit || "", pin: s.pin || "", code: s.code || "" }; };
  const isAppr = () => !!rights.approver;
  const canEdit = u => isAppr() || (rights.unitOk && auth().unit === u);
  const myUnit = () => rights.unitOk ? auth().unit : "";
  let unsubPlans = null;
  const store = { get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }, set(k,v){ try { localStorage.setItem(k,v); } catch(e){} } };
  const savedUnit = store.get("wp-unit"); if (savedUnit) state.editUnit = savedUnit;

  function toast(msg, action){
    const t = $("#toast"); t.innerHTML = ""; t.append(document.createTextNode(msg));
    if (action) { const b = document.createElement("button"); b.className = "toast-act"; b.type = "button"; b.textContent = action.label; b.onclick = () => { t.hidden = true; action.fn(); }; t.append(b); }
    t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, action ? 9000 : 2800);
  }

  // ---------- data ----------
  const planId = (week, unit) => `${week}_${unit}`;
  function emptyPlan(unit){ return { week: state.week, unit, tasks: [], wins: "", blockers: "", asks: "", updatedAt: null, updatedBy: null }; }
  function summarize(p){
    const t = ((p && p.tasks) || []).filter(x => x.kind !== "KPI / OKR");
    const kpi = ((p && p.tasks) || []).length - t.length;
    const done = t.filter(x => x.status==="Done").length;
    const blocked = t.filter(x => x.status==="Blocked").length;
    const high = t.filter(x => x.priority==="High").length;
    const highDone = t.filter(x => x.priority==="High" && x.status==="Done").length;
    // Every task counts: Done = 100, otherwise the % entered, and no status or no % counts as 0.
    const nums = t.map(x => x.status==="Done" ? 100 : (typeof x.pct==="number" ? x.pct : 0));
    const avg = nums.length ? Math.round(nums.reduce((a,b)=>a+b,0)/nums.length) : null;
    const noStatus = t.filter(x => !x.status).length;
    const overdue = t.filter(x => x.due && x.due < todayIso && x.status!=="Done").length;
    return { total: t.length, kpi, done, blocked, high, highDone, avg, noStatus, overdue };
  }

  const ALL = "__all__";
  const clone = o => JSON.parse(JSON.stringify(o));
  const isAll = () => state.editUnit === ALL;
  const hasDraft = () => !!(state.draft || state.allDrafts);
  state.allDrafts = null; state.dirtyUnits = new Set(); state.showLists = false;

  function subscribePlans(){
    if (!db) return;
    if (unsubPlans) unsubPlans();
    state.plansLoaded = false; state.plans = {};
    render();
    unsubPlans = db.collection("plans").where("week","==",state.week).onSnapshot(snap => {
      const next = {};
      snap.docs.forEach(d => { const v = d.data(); if (v && v.unit) next[v.unit] = v; });
      state.plans = next; state.plansLoaded = true;
      if (state.editUnit && !hasDraft() && !state.dirty) loadDraft();
      if (state.draft && state.editUnit && !isAll()) {
        const remote = next[state.editUnit];
        if (state.dirty && remote && remote.updatedAt !== state.draft.updatedAt) state.remoteChanged = true;
        if (!state.dirty) loadDraft();
      } else if (state.allDrafts) {
        if (!state.dirty) loadDraft();
        else Object.keys(state.allDrafts).forEach(u => {
          const remote = next[u];
          if (!state.dirtyUnits.has(u)) { state.allDrafts[u] = clone(remote || emptyPlan(u)); state.base[u] = remote ? clone(remote) : null; }
          else if (remote && remote.updatedAt !== state.allDrafts[u].updatedAt) state.remoteChanged = true;
        });
      }
      render();
    }, err => { banner(`The plan store stopped responding (${err.code}). Reload the page to reconnect.`); });
  }

  function loadDraft(){
    state.dirty = false; state.remoteChanged = false; state.dirtyUnits = new Set();
    if (!state.editUnit) { state.draft = null; state.allDrafts = null; return; }
    if (isAll()) {
      state.draft = null;
      state.allDrafts = Object.fromEntries(sortedUnits().map(u => [u.id, clone(state.plans[u.id] || emptyPlan(u.id))]));
      state.base = Object.fromEntries(sortedUnits().map(u => [u.id, state.plans[u.id] ? clone(state.plans[u.id]) : null]));
      return;
    }
    state.allDrafts = null;
    state.draft = clone(state.plans[state.editUnit] || emptyPlan(state.editUnit));
    state.base = { [state.editUnit]: state.plans[state.editUnit] ? clone(state.plans[state.editUnit]) : null };
  }
  const planFor = u => isAll() ? state.allDrafts && state.allDrafts[u] : state.draft;

  // ---------- saving: direct changes save now, the rest goes to Group Strategy for approval ----------
  const newId = () => `${Date.now().toString(36)}${uid()}`;
  const ERR = {
    not_allowed: "Your PIN or approver code does not allow this change. Use the name button at the top to sign in again.",
    conflict: "Someone saved this plan a moment ago. Their version is now loaded underneath yours: press Save again to add your changes.",
    needs_approval: "This change needs Group Strategy approval.", not_pending: "That request was already decided.",
    too_late: "Undo is only possible for 30 minutes after your own save.", not_found: "Nothing to restore.",
    quota_exceeded: "Storage is full. Ask the Strategy Office to archive old weeks.", pin_too_short: "A PIN needs at least 4 characters.", code_too_short: "The approver code needs at least 6 characters.",
  };
  const errText = e => ERR[e && (e.error || e.code || e)] || "Could not save. Check your connection and try again.";
  function opSummary(ops){
    const add = ops.filter(o => o.op === "add").length, rem = ops.filter(o => o.op === "remove").length;
    const upd = new Set(ops.filter(o => o.op === "set").map(o => o.id)).size, txt = ops.some(o => o.op === "text");
    return [add && `${add} added`, upd && `${upd} updated`, rem && `${rem} removed`, txt && "report text edited"].filter(Boolean).join(", ");
  }
  const showF = (f, v) => f === "ev" ? `${(v || []).length} file${(v || []).length === 1 ? "" : "s"}` : f === "depUnit" ? (v ? unitName(v) : "–") : showV(v);
  function opLines(ops){
    const lines = [], byTask = new Map();
    ops.forEach(o => {
      if (o.op === "add") lines.push(`Added "${short(o.task.title)}"`);
      else if (o.op === "remove") lines.push(`Removed "${short(o.task.title)}"`);
      else if (o.op === "text") lines.push(`Edited ${({ wins: "key results", blockers: "blockers", asks: "asks" })[o.f]}`);
      else { if (!byTask.has(o.id)) byTask.set(o.id, { title: o.title, ch: [] }); byTask.get(o.id).ch.push(o.f === "title" ? `title → "${short(o.to)}"` : `${FLAB[o.f] || o.f} ${showF(o.f, o.from)} → ${showF(o.f, o.to)}`); }
    });
    byTask.forEach(t => lines.push(`Updated "${short(t.title)}": ${t.ch.join("; ")}`));
    return lines;
  }
  // saved = the plan as it was when editing started; draft = the edited copy; latest = what is in the store now
  async function persistPlan(u, week, saved, draft, opts = {}){
    draft.tasks = (draft.tasks || []).filter(t => (t.title || "").trim());
    const ops = planOps(saved, draft);
    if (!ops.length) return { nothing: true };
    const monday = thisMonday(), appr = isAppr();
    const direct = appr ? ops : ops.filter(o => !needsApproval(o, week, monday, todayIso));
    const queued = appr ? [] : ops.filter(o => needsApproval(o, week, monday, todayIso));
    const res = { saved: false, requested: 0 };
    if (direct.length) {
      const latest = opts.latest !== undefined ? opts.latest : (week === state.week ? state.plans[u] : saved);
      const plan = applyOps(latest || { week, unit: u, tasks: [], wins: "", blockers: "", asks: "" }, direct, { at: new Date().toISOString(), by: myId || "" });
      plan.week = week; plan.unit = u; plan.source = opts.source || "";
      const r = await api.savePlan(auth(), plan, latest ? latest.updatedAt : null, !!opts.force, { id: newId(), action: opts.action || "save", summary: (opts.prefix || "") + opSummary(direct), details: opLines(direct).slice(0, 40) });
      if (r.error) return { ...r };
      res.saved = true; state.lastSave = { id: planId(week, u), at: Date.now() };
    }
    if (queued.length) {
      const r = await api.requestChange(auth(), { id: newId(), unit: u, week, summary: (opts.prefix || "") + opSummary(queued), details: opLines(queued).slice(0, 60), patch: queued });
      if (r.error) return { ...res, error: r.error };
      res.requested = queued.length;
    }
    return res;
  }
  async function saveDraft(){
    if (!db || !hasDraft()) return;
    const units = isAll() ? [...state.dirtyUnits] : [state.editUnit];
    let saved = 0, requested = 0;
    for (const u of units) {
      if (!canEdit(u)) { toast(ERR.not_allowed); return; }
      const d = isAll() ? state.allDrafts[u] : state.draft;
      let r;
      try { r = await persistPlan(u, state.week, state.base[u], d); } catch (e) { r = { error: e.code || "error" }; }
      if (r.error) { if (r.error === "conflict") state.remoteChanged = true; toast(errText(r)); render(); return; }
      if (r.saved) saved++; requested += r.requested || 0;
    }
    state.dirty = false; state.remoteChanged = false; state.dirtyUnits = new Set();
    loadDraft(); render();
    const msg = [saved && (isAll() ? `Saved ${saved} plan${saved === 1 ? "" : "s"}` : "Plan saved"), requested && `${requested} change${requested === 1 ? "" : "s"} sent to Group Strategy for approval`].filter(Boolean).join(" · ") || "Nothing to save";
    toast(msg, saved && !isAll() && state.lastSave ? { label: "Undo", fn: undoLast } : null);
  }
  async function undoLast(){
    const ls = state.lastSave; if (!ls) return;
    try { const r = await api.undoLast(auth(), ls.id); toast(r.error ? errText(r) : "Last save undone"); state.lastSave = null; }
    catch (e) { toast(errText(e)); }
  }

  // ---------- Ethiopian calendar ----------
  const ETH_M = ["Meskerem","Tikimt","Hidar","Tahsas","Tir","Yekatit","Megabit","Miazia","Ginbot","Sene","Hamle","Nehase","Pagume"];
  const jdnOf = (y, m, d) => { const a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3; return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045; };
  function toEth(s){
    const [y, m, d] = s.split("-").map(Number), j = jdnOf(y, m, d) - 1723856, r = j % 1461, n = (r % 365) + 365 * Math.floor(r / 1460);
    return { y: 4 * Math.floor(j / 1461) + Math.floor(r / 365) - Math.floor(r / 1460), m: Math.floor(n / 30) + 1, d: (n % 30) + 1 };
  }
  function ethRange(a, b){ const A = toEth(a), B = toEth(b); return A.m === B.m && A.y === B.y ? `${ETH_M[A.m-1]} ${A.d}–${B.d}, ${A.y} EC` : `${ETH_M[A.m-1]} ${A.d} – ${ETH_M[B.m-1]} ${B.d}, ${B.y} EC`; }
  const ethWeekLabel = w => ethRange(w, weekEndOf(w));
  function ethMonthRange(e){
    const g = new Date(e.y + 7, 8, 11 + 30 * (e.m - 1)); let start = null;
    for (let k = -6; k <= 6 && !start; k++) { const s = iso(new Date(g.getFullYear(), g.getMonth(), g.getDate() + k)), x = toEth(s); if (x.y === e.y && x.m === e.m && x.d === 1) start = s; }
    let end = start; for (let i = 1; i < 31; i++) { const s = addDays(start, i), x = toEth(s); if (x.m === e.m && x.y === e.y) end = s; else break; }
    return { start, end };
  }
  const ethName = e => `${ETH_M[e.m - 1]} ${e.y} EC`;
  state.eth = toEth(iso(new Date())); state.monthBasis = "end";
  state.ov = { priority: "High", status: "", unit: "", q: "", all: false };
  state.expanded = new Set(); state.bf = null; state.carryInfo = null; state.carryKey = "";
  const newFilter = () => ({ unit: "", status: "", statuses: [], priority: "", kind: "", dept: "", q: "", period: "week", from: "", group: false });
  state.filter = newFilter();
  const thisMonday = () => weekStartOf(todayIso);   // start of the current week (Saturday from 10 Oct 2026)
  const nextMonday = () => nextWeekOf(thisMonday());

  // ---------- this week's update / next week's plan ----------
  function planBanner(){
    if (state.tab === "plan") {
      const on = state.week === nextMonday();
      return `<div class="banner ${on ? "info" : "warn"}"><b>${on ? "Planning" : "Viewing"} ${esc(weekLabel(state.week))} · ${esc(ethWeekLabel(state.week))}.</b> ${on ? "Enter next week's tasks here: add them by hand, bring forward unfinished work, or import an Excel plan further down." : `This is not next week. <button class="btn" id="goNext" style="margin-left:6px">Go to next week (${esc(weekLabel(nextMonday()))})</button>`}</div>`;
    }
    return `<div class="banner info">Update progress for <b>${esc(weekLabel(state.week))} · ${esc(ethWeekLabel(state.week))}</b>: status, % complete, key results, blockers and asks. New tasks for the coming week go under <b>Next week's plan</b>.</div>`;
  }
  function carryBanner(){
    const c = state.carryInfo; if (!c || c.key !== `${state.week}|${state.editUnit}` || !state.draft) return "";
    const have = new Set(state.draft.tasks.map(t => norm(t.title))); const n = c.items.filter(t => !have.has(norm(t.title))).length;
    return n ? `<div class="banner warn" style="margin:12px 16px 0">${n} unfinished task${n > 1 ? "s" : ""} from last week ${n > 1 ? "are" : "is"} not in this week yet. <button class="btn" id="bfBtn2" style="margin-left:6px">Review and bring forward</button></div>` : "";
  }
  function fetchCarry(){
    if (!((state.tab === "update" || state.tab === "plan") && db && state.editUnit && !isAll() && state.draft)) return;
    const key = `${state.week}|${state.editUnit}`; if (state.carryKey === key) return; state.carryKey = key;
    db.doc(`plans/${planId(prevWeekOf(state.week), state.editUnit)}`).get().then(s => { state.carryInfo = { key, items: s.exists ? realTasks(s.data()).filter(t => t.status !== "Done") : [] }; render(); }).catch(() => {});
  }
  async function openBf(){
    if (!db || isAll() || !state.editUnit || !state.draft) { toast("Choose one unit first"); return; }
    let prev = null;
    try { const s = await db.doc(`plans/${planId(prevWeekOf(state.week), state.editUnit)}`).get(); prev = s.exists ? s.data() : null; } catch (e) { toast("Could not read last week's plan"); return; }
    const have = new Set(state.draft.tasks.map(t => norm(t.title)));
    const items = realTasks(prev).filter(t => t.status !== "Done").map(t => ({ t, dup: have.has(norm(t.title)), checked: !have.has(norm(t.title)) && (t.status === "In progress" || t.status === "Not started" || !t.status) }));
    if (!items.length) { toast("Nothing unfinished in last week's plan"); return; }
    state.bf = { items, week: prevWeekOf(state.week) }; renderModal();
  }
  function bfCount(){ return state.bf ? state.bf.items.filter(x => x.checked && !x.dup).length : 0; }
  function renderModal(){
    const root = $("#modalRoot"), b = state.bf; if (!b) { root.innerHTML = ""; return; }
    const order = ["In progress","Not started","","Blocked","Delayed"];
    const groups = order.map(s => ({ s, list: b.items.map((x, i) => ({ ...x, i })).filter(x => (x.t.status || "") === s) })).filter(g => g.list.length);
    root.innerHTML = `<div class="overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="bfTitle">
      <div class="panel-head"><div><h2 id="bfTitle">Bring forward from last week</h2><div class="small muted">${esc(weekLabel(b.week))} → ${esc(weekLabel(state.week))}. Done tasks are not listed. Blocked and Delayed tasks start unticked: bring them only if they will still be worked on. Unticked tasks stay in last week only.</div></div></div>
      <div class="toolbar" style="padding:10px 16px"><button class="btn" id="bfAll">Select all</button><button class="btn" id="bfProg">In progress only</button><button class="btn" id="bfNone">Select none</button></div>
      <div style="padding:0 16px 8px">${groups.map(g => `<div class="small muted" style="margin:10px 0 4px;font-weight:700;text-transform:uppercase;letter-spacing:.05em">${esc(g.s || "No status")} · ${g.list.length}</div>${g.list.map(x => `<label class="bf-row ${x.dup ? "dim" : ""}"><input type="checkbox" data-bf="${x.i}" ${x.checked ? "checked" : ""} ${x.dup ? "disabled" : ""}><span><b>${esc(x.t.title)}</b>${x.dup ? ' <span class="tag">Already in this week</span>' : ""}<br><span class="small muted">${[x.t.dept, x.t.owner, typeof x.t.pct === "number" ? x.t.pct + "%" : "", x.t.due ? "due " + fmt(x.t.due) : ""].filter(Boolean).map(esc).join(" · ")}</span></span></label>`).join("")}`).join("")}</div>
      <div class="save-bar"><span class="small muted">Past due dates are cleared on the copy and kept in its notes.</span><div class="toolbar"><button class="btn" id="bfCancel">Cancel</button><button class="btn primary" id="bfGo">Bring ${bfCount()} task${bfCount() === 1 ? "" : "s"} forward</button></div></div></div></div>`;
  }
  function bfGo(){
    const b = state.bf; if (!b) return; const sel = b.items.filter(x => x.checked && !x.dup);
    sel.forEach(x => {
      const t = clone(x.t), past = t.due && t.due < todayIso;
      state.draft.tasks.push({ ...t, id: uid(), carried: true, carriedCount: (t.carriedCount || 0) + 1, prevStatus: t.status || "", prevPct: typeof t.pct === "number" ? t.pct : null, completedAt: "",
        due: past ? "" : (t.due || ""), notes: [t.notes, `Carried from ${fmt(b.week)} week${past ? ` (was due ${fmt(t.due)})` : ""}`].filter(Boolean).join(" | ") });
    });
    if (sel.length) { state.dirty = true; state.dirtyUnits.add(state.editUnit); }
    state.bf = null; renderModal(); toast(sel.length ? `${sel.length} task${sel.length > 1 ? "s" : ""} brought forward. Save to keep them.` : "No tasks selected"); render();
  }
  $("#modalRoot").addEventListener("click", e => {
    const t = e.target.closest("button"); if (!t) return;
    if (state.history) {
      if (t.id === "hClose") { state.history = null; renderHistory(); }
      else if (t.dataset.hprev) { state.history.preview = state.history.preview === t.dataset.hprev ? null : t.dataset.hprev; renderHistory(); }
      else if (t.dataset.hrestore) {
        if (state.dirty) { toast("Save or discard your changes first"); return; }
        api.restoreVersion(auth(), t.dataset.hrestore).then(r => { if (r.error) { toast(errText(r)); return; } toast("Restored. The replaced version is kept in History."); state.history = null; renderHistory(); }).catch(x => toast(errText(x)));
      }
      return;
    }
    if (!state.bf) return;
    const setAll = fn => { state.bf.items.forEach(x => { if (!x.dup) x.checked = fn(x); }); document.querySelectorAll("#modalRoot input[data-bf]").forEach(c => { const x = state.bf.items[Number(c.dataset.bf)]; c.checked = x.checked; }); const g = $("#bfGo"); if (g) g.textContent = `Bring ${bfCount()} task${bfCount() === 1 ? "" : "s"} forward`; };
    if (t.id === "bfAll") setAll(() => true); else if (t.id === "bfNone") setAll(() => false); else if (t.id === "bfProg") setAll(x => x.t.status === "In progress");
    else if (t.id === "bfCancel") { state.bf = null; renderModal(); } else if (t.id === "bfGo") bfGo();
  });
  $("#modalRoot").addEventListener("change", e => { const c = e.target; if (c.dataset.bf !== undefined && state.bf) { state.bf.items[Number(c.dataset.bf)].checked = c.checked; const g = $("#bfGo"); if (g) g.textContent = `Bring ${bfCount()} task${bfCount() === 1 ? "" : "s"} forward`; } });

  // ---------- overview: task detail ----------
  function renderOvTasks(){
    if (!state.units.length || !state.plansLoaded) return "";
    const o = state.ov, pool = allTasks().filter(t => t.kind !== "KPI / OKR"), q = o.q.trim().toLowerCase();
    const cnt = { high: pool.filter(t => t.priority === "High").length, done: pool.filter(t => t.status === "Done").length, ns: pool.filter(t => t.status === "Not started").length };
    const pr = { High: 0, Medium: 1, Low: 2 };
    const list = pool.filter(t => (!o.unit || t.unit === o.unit) && (!o.priority || (o.priority === "none" ? !t.priority : t.priority === o.priority)) && (!o.status || (o.status === "none" ? !t.status : t.status === o.status)) && (!q || `${t.title} ${t.dept || ""} ${t.owner || ""}`.toLowerCase().includes(q)))
      .sort((a, b) => (pr[a.priority] ?? 3) - (pr[b.priority] ?? 3) || a.unitName.localeCompare(b.unitName));
    if (state.sort.ov && state.sort.ov.k) { const sorted = sortedBy(list, "ov"); list.length = 0; list.push(...sorted); }
    const shown = o.all ? list : list.slice(0, 50);
    const rows = shown.map(readRow).join("");
    const on = (p, s) => (o.priority === p && o.status === s) ? " on" : "";
    return `<div class="panel" style="margin-top:16px">
      <div class="panel-head"><h2>Tasks in ${esc(weekLabel(state.week))}</h2>
        <div class="toolbar"><button class="btn${on("High", "")}" id="ovHigh">High priority · ${cnt.high}</button><button class="btn${on("", "Done")}" id="ovDone">Completed · ${cnt.done}</button><button class="btn${on("", "Not started")}" id="ovNS">Not started · ${cnt.ns}</button></div></div>
      <div class="toolbar" style="padding:12px 16px;border-bottom:1px solid var(--line)">
        <label class="small muted" for="ovPri">Priority</label><select id="ovPri"><option value="">All</option>${PRIORITIES.map(p => `<option ${o.priority === p ? "selected" : ""}>${p}</option>`).join("")}<option value="none" ${o.priority === "none" ? "selected" : ""}>Not set</option></select>
        <label class="small muted" for="ovSt">Status</label><select id="ovSt"><option value="">All</option>${STATUSES.map(s => `<option ${o.status === s ? "selected" : ""}>${s}</option>`).join("")}<option value="none" ${o.status === "none" ? "selected" : ""}>No status</option></select>
        <select id="ovUnit" aria-label="Unit"><option value="">All units</option>${sortedUnits().map(u => `<option value="${esc(u.id)}" ${o.unit === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
        <input type="text" id="ovQ" placeholder="Search" value="${esc(o.q)}" aria-label="Search tasks"><span class="small muted">${list.length} task${list.length === 1 ? "" : "s"}</span>
        <button class="btn ghost" id="ovOpen">Open in All tasks</button></div>
      ${list.length ? `<div class="scroll"><table><thead><tr>${readHead("ov")}</tr></thead><tbody>${rows}</tbody></table></div>${list.length > shown.length ? `<div class="toolbar" style="padding:12px 16px"><span class="small muted">Showing ${shown.length} of ${list.length}</span><button class="btn" id="ovAll">Show all</button></div>` : ""}` : `<div class="empty"><b>No tasks match</b>Change the priority or status.</div>`}</div>`;
  }

  // ---------- all tasks (with filters, month drill-down and department grouping) ----------
  function allTasks(){
    return sortedUnits().flatMap(u => (state.plans[u.id]?.tasks || []).map(t => ({ ...t, unit: u.id, unitName: u.name })));
  }
  function poolTasks(){
    if (state.filter.period === "month" && state.monthData) return (monthStats() || []).flatMap(r => r.all.map(t => ({ ...t, unit: r.u.id, unitName: r.u.name })));
    return allTasks();
  }
  function filteredTasks(){
    const f = state.filter, q = f.q.trim().toLowerCase();
    return poolTasks().filter(t => (!f.unit || t.unit === f.unit)
      && (f.statuses.length ? f.statuses.includes(t.status || "") : (!f.status || (f.status === "none" ? !t.status : t.status === f.status)))
      && (!f.priority || t.priority === f.priority) && (!f.kind || (t.kind || "Task") === f.kind) && (!f.dept || (t.dept || "") === f.dept)
      && (!q || `${t.title} ${t.dept || ""} ${t.owner} ${t.notes}`.toLowerCase().includes(q)));
  }
  const readHead = scope => `${th(scope,"unit","Unit")}${th(scope,"title","Task")}${th(scope,"dept","Department")}${th(scope,"owner","Owner (name)")}${th(scope,"due","Due")}${th(scope,"priority","Priority")}<th>Previous status</th>${th(scope,"status","Status")}${th(scope,"pct","Complete")}<th>Completed on</th><th>Depends on</th><th>Evidence</th><th>Notes</th><th>Updated by</th>`;
  const READ_COLS = 14;
  const evLinks = t => (t.ev || []).length ? (t.ev || []).map(e => `<button class="lnk ev-open" type="button" data-evp="${esc(e.path)}" data-evn="${esc(e.name)}" title="${esc(e.name)}">📎${(t.ev || []).length > 1 ? "" : " " + esc(e.name.length > 14 ? e.name.slice(0, 12) + "…" : e.name)}</button>`).join("") : '<span class="muted small">–</span>';
  function readRow(t){
    const late = t.due && t.due < todayIso && t.status !== "Done", lateDone = t.status === "Done" && t.due && t.completedAt && t.completedAt > t.due;
    return `<tr>
      <td class="small"><b>${esc(t.unitName)}</b></td>
      <td class="c-read-task" title="${esc(t.title)}${t.outcome ? "\nExpected outcome: " + esc(t.outcome) : ""}">${t.priority === "High" ? '<span class="hi-dot" title="High priority"></span>' : ""}${esc(t.title)}${t.kind === "KPI / OKR" ? ' <span class="tag">KPI / OKR</span>' : ""}${t.carried ? ` <span class="tag">carried${(t.carriedCount || 1) > 1 ? " " + t.carriedCount + " weeks" : ""}</span>` : ""}${t.outcome ? `<div class="small muted">Outcome: ${esc(t.outcome)}</div>` : ""}</td>
      <td class="small">${esc(t.dept || "")}</td><td class="small">${esc(t.owner)}</td>
      <td class="num small" style="color:${late ? "var(--bad)" : "inherit"}">${esc(fmt(t.due))}</td>
      <td class="small">${t.priority ? esc(t.priority) : '<span class="muted">–</span>'}</td>
      <td>${t.prevStatus ? `<span class="pill ${statusClass(t.prevStatus)}">${esc(t.prevStatus)}</span>` : '<span class="muted small">–</span>'}</td>
      <td><span class="pill ${statusClass(t.status)}">${esc(t.status || "No status")}</span></td>
      <td>${typeof t.pct === "number" ? `<div class="prog"><div class="bar"><i style="width:${t.pct}%"></i></div><span class="num">${t.pct}%</span></div>` : '<span class="muted small">–</span>'}</td>
      <td class="num small" ${lateDone ? 'style="color:var(--warn)" title="Finished after the due date"' : ""}>${t.completedAt ? esc(fmt(t.completedAt)) : '<span class="muted">–</span>'}</td>
      <td class="small">${t.depUnit ? `<b>${esc(unitName(t.depUnit))}</b>` : ""}${t.dep ? `${t.depUnit ? "<br>" : ""}${esc(t.dep)}` : ""}${!t.depUnit && !t.dep ? '<span class="muted">–</span>' : ""}</td>
      <td class="small" style="white-space:nowrap">${evLinks(t)}</td>
      <td class="small muted">${esc(t.notes)}</td>
      <td class="small" style="white-space:nowrap">${t.lu ? `${esc(fmt(t.lu.slice(0, 10)))} ${t.lb ? `<span class="muted" data-person="${esc(t.lb)}"></span>` : `<span class="muted">data load</span>`}` : '<span class="muted">–</span>'}</td></tr>`;
  }
  function filterChips(){
    const f = state.filter, c = [];
    if (f.period === "month") c.push(["period", `${ethName(state.eth)} · distinct tasks at latest status`]);
    if (f.unit) c.push(["unit", unitName(f.unit)]);
    if (f.statuses.length) c.push(["statuses", "Status: " + f.statuses.map(s => s || "No status").join(" / ")]);
    if (f.priority) c.push(["priority", "Priority: " + f.priority]);
    if (f.dept) c.push(["dept", "Department: " + f.dept]);
    return c;
  }
  function renderTasks(){
    const f = state.filter, month = f.period === "month";
    if (month && !state.monthData) return `<div class="panel"><div class="empty"><b>Collecting the weeks of ${esc(ETH_M[state.eth.m - 1])}…</b></div></div>`;
    const list = sortedBy(filteredTasks(), "tasks"), chips = filterChips();
    const depts = [...new Set(poolTasks().filter(t => !f.unit || t.unit === f.unit).map(t => t.dept || "").filter(Boolean))].sort();
    let body = "";
    if (f.group) {
      const byU = new Map(); list.forEach(t => { if (!byU.has(t.unit)) byU.set(t.unit, { name: t.unitName, d: new Map() }); const u = byU.get(t.unit), k = t.dept || ""; if (!u.d.has(k)) u.d.set(k, []); u.d.get(k).push(t); });
      byU.forEach((u, uid_) => {
        const n = [...u.d.values()].reduce((a, b) => a + b.length, 0);
        body += `<tr class="group-row"><td colspan="${READ_COLS}"><b>${esc(u.name)}</b> <span class="small muted">${n} task${n === 1 ? "" : "s"}</span></td></tr>`;
        const keys = [...u.d.keys()].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b)), flat = keys.length === 1 && keys[0] === "";
        keys.forEach(k => {
          const key = uid_ + "|" + k, open = flat || state.expanded.has(key), ts = u.d.get(k);
          if (!flat) body += `<tr class="clickable" data-tgl="${esc(key)}" tabindex="0"><td colspan="${READ_COLS}"><b>${open ? "▾" : "▸"} ${esc(k || "(no department)")}</b> <span class="small muted">${ts.length}</span></td></tr>`;
          if (open) body += ts.map(readRow).join("");
        });
      });
    } else body = list.map(readRow).join("");
    return `<div class="panel">
      ${f.from === "monthly" ? `<div class="toolbar" style="padding:12px 16px;border-bottom:1px solid var(--line)"><button class="btn" id="backMonthly">‹ Back to monthly report</button><span class="small muted">Showing the tasks behind the number you selected.</span></div>` : ""}
      ${chips.length ? `<div class="chipset" style="padding:12px 16px;border-bottom:1px solid var(--line)">${chips.map(([k, l]) => `<span class="chip">${esc(l)}<button data-chip="${k}" aria-label="Remove filter">×</button></span>`).join("")}</div>` : ""}
      <div class="panel-head">
        <div class="toolbar">
          <select id="fPeriod" aria-label="Period"><option value="week" ${!month ? "selected" : ""}>Week: ${esc(weekLabel(state.week))}</option><option value="month" ${month ? "selected" : ""}>Month: ${esc(ethName(state.eth))}</option></select>
          <select id="fUnit" aria-label="Filter by unit"><option value="">All units</option>${sortedUnits().map(u => `<option value="${esc(u.id)}" ${f.unit === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
          <select id="fDept" aria-label="Filter by department"><option value="">All departments</option>${depts.map(d => `<option ${f.dept === d ? "selected" : ""}>${esc(d)}</option>`).join("")}</select>
          <select id="fStatus" aria-label="Filter by status"><option value="">All statuses</option>${f.statuses.length ? `<option value="__multi__" selected>Selected statuses</option>` : ""}${STATUSES.map(s => `<option ${!f.statuses.length && f.status === s ? "selected" : ""}>${s}</option>`).join("")}<option value="none" ${!f.statuses.length && f.status === "none" ? "selected" : ""}>No status</option></select>
          <select id="fPri" aria-label="Filter by priority"><option value="">All priorities</option>${PRIORITIES.map(p => `<option ${f.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select>
          <select id="fKind" aria-label="Filter by type"><option value="">Tasks and KPI lines</option>${KINDS.map(k => `<option ${f.kind === k ? "selected" : ""}>${k}</option>`).join("")}</select>
          <input type="text" id="fQ" placeholder="Search tasks, departments or owners" value="${esc(f.q)}" aria-label="Search">
          <label class="small"><input type="checkbox" id="fGroup" ${f.group ? "checked" : ""}> Group by department</label>
        </div>
        <div class="toolbar"><span class="small muted">${list.length} tasks</span>${downloads ? `<button class="btn" id="tasksPdfBtn">PDF</button><button class="btn" id="tasksXlsxBtn">Excel</button><button class="btn" id="exportBtn">CSV</button>` : ""}</div>
      </div>
      ${list.length ? `<div class="scroll"><table><thead><tr>${readHead("tasks")}</tr></thead><tbody>${body}</tbody></table></div>` : `<div class="empty"><b>No tasks match</b>Change the filters, or pick another period.</div>`}
    </div>`;
  }

  // ---------- monthly consolidation (Ethiopian calendar) ----------
  function monthWeeks(e, basis){
    const { start, end } = ethMonthRange(e), res = []; let w = prevWeekOf(weekStartOf(start));
    for (let i = 0; i < 10; i++) { const x = toEth(basis === "end" ? weekEndOf(w) : w); if (x.y === e.y && x.m === e.m) res.push(w); w = nextWeekOf(w); if (w > addDays(end, 7)) break; }
    return res;
  }
  async function loadMonth(){
    if (!db) return;
    const key = `${state.eth.y}-${state.eth.m}${state.monthBasis}`, weeks = monthWeeks(state.eth, state.monthBasis);
    state.monthKey = key; state.monthLoading = true; state.monthData = null; render();
    const data = {};
    for (const w of weeks) {
      try { const snap = await db.collection("plans").where("week", "==", w).get(); data[w] = {}; snap.docs.forEach(d => { const v = d.data(); if (v && v.unit) data[w][v.unit] = v; }); }
      catch (e) { data[w] = {}; }
    }
    if (state.monthKey !== key) return;
    state.monthData = { weeks, data }; state.monthLoading = false; render();
  }
  function shiftMonth(d){ let m = state.eth.m + d, y = state.eth.y; if (m > 13) { m = 1; y++; } if (m < 1) { m = 13; y--; } state.eth = { y, m }; loadMonth(); }
  const progressBar = (label, pct, sub, hero) => `<div class="pbar${hero ? " hero" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct ?? 0}" aria-label="${esc(label)}"><div class="pbar-top"><b>${esc(label)}</b><span class="num">${pct === null ? "–" : pct + "%"}</span></div><div class="pbar-track"><i style="width:${pct ?? 0}%"></i></div><div class="pbar-sub small">${esc(sub || "")}</div></div>`;
  const avgOf = arr => { const n = arr.map(x => x.status === "Done" ? 100 : (typeof x.pct === "number" ? x.pct : 0)); return n.length ? Math.round(n.reduce((a, b) => a + b, 0) / n.length) : null; };
  function monthStats(){
    const md = state.monthData; if (!md) return null;
    return sortedUnits().map(u => {
      const uniq = new Map(), uniqAll = new Map(); let entries = 0, kpi = 0, reported = 0; const texts = [];
      md.weeks.forEach(w => {
        const p = md.data[w] && md.data[w][u.id]; if (!p) return;
        const rt = realTasks(p); kpi += kpiTasks(p).length; entries += rt.length;
        if (rt.length || kpiTasks(p).length || p.wins || p.blockers || p.asks) reported++;
        rt.forEach(t => uniq.set(norm(t.title) + "|" + norm(t.dept), { ...t, week: w }));
        (p.tasks || []).forEach(t => uniqAll.set((t.kind === "KPI / OKR" ? "k" : "t") + "|" + norm(t.title) + "|" + norm(t.dept), { ...t, week: w }));
        if (p.wins || p.blockers || p.asks) texts.push({ week: w, wins: p.wins || "", blockers: p.blockers || "", asks: p.asks || "", by: p.updatedBy || "" });
      });
      const tasks = [...uniq.values()];
      const mk = ts => ({ total: ts.length, done: ts.filter(t => t.status === "Done").length, prog: ts.filter(t => t.status === "In progress").length, blocked: ts.filter(t => t.status === "Blocked").length, delayed: ts.filter(t => t.status === "Delayed").length, notStarted: ts.filter(t => t.status === "Not started").length, noStatus: ts.filter(t => !t.status).length, high: ts.filter(t => t.priority === "High").length, highDone: ts.filter(t => t.priority === "High" && t.status === "Done").length, avg: avgOf(ts) });
      const byDept = {}; tasks.forEach(t => { const k = t.dept || "(no department)"; (byDept[k] = byDept[k] || []).push(t); });
      return { u, tasks, all: [...uniqAll.values()], entries, kpi, reported, texts, s: mk(tasks), dept: Object.entries(byDept).map(([d, ts]) => ({ d, s: mk(ts) })).sort((a, b) => a.d.localeCompare(b.d)) };
    });
  }
  function renderMonthly(){
    const e = state.eth, rng = ethMonthRange(e);
    const head = `<div class="panel-head"><div class="toolbar"><h2>${esc(ethName(e))}</h2><span class="muted small">${esc(fmt(rng.start))} – ${esc(fmt(rng.end))} ${parse(rng.end).getFullYear()}</span>
      <label class="small muted" for="mBasis">A week counts in the month it</label><select id="mBasis"><option value="end" ${state.monthBasis === "end" ? "selected" : ""}>ends in (last day)</option><option value="start" ${state.monthBasis === "start" ? "selected" : ""}>starts in (first day)</option></select></div>
      <div class="toolbar"><label class="small"><input type="checkbox" id="mDept" ${state.monthByDept ? "checked" : ""}> Show departments</label><button class="btn" id="mRefresh">Refresh</button>${downloads && state.monthData ? `<button class="btn primary" id="mPdf">Monthly report (PDF)</button><button class="btn" id="mXlsx">Excel</button>` : ""}</div></div>`;
    if (!db) return `<div class="panel">${head}<div class="empty"><b>No data</b>The shared store is not available in this view.</div></div>`;
    if (state.monthLoading || !state.monthData) return `<div class="panel">${head}<div class="empty"><b>Collecting the weeks of ${esc(ETH_M[e.m - 1])}…</b></div></div>`;
    const st = monthStats(), md = state.monthData;
    const tot = st.reduce((a, r) => { const s = r.s; return { uniq: a.uniq + s.total, done: a.done + s.done, prog: a.prog + s.prog, ns: a.ns + s.notStarted + s.noStatus, blk: a.blk + s.blocked + s.delayed, entries: a.entries + r.entries, rep: a.rep + (r.reported ? 1 : 0), high: a.high + s.high, highDone: a.highDone + s.highDone }; }, { uniq: 0, done: 0, prog: 0, ns: 0, blk: 0, entries: 0, rep: 0, high: 0, highDone: 0 });
    const gAvg = avgOf(st.flatMap(r => r.tasks));
    const wk = md.weeks.map(w => `${ethRange(w, weekEndOf(w)).replace(/, \d+ EC$/, "")}`).join(" · ");
    const stats = `<div class="stats">
      <div class="stat"><div class="v">${md.weeks.length}</div><div class="k">weeks: ${esc(wk) || "none"}</div></div>
      <div class="stat"><div class="v">${tot.rep} of ${st.length}</div><div class="k">units reported in the month</div></div>
      <div class="stat"><div class="v">${tot.uniq}</div><div class="k">distinct tasks (${tot.entries} weekly entries)</div></div>
      <div class="stat"><div class="v">${tot.uniq ? Math.round(tot.done / tot.uniq * 100) : 0}%</div><div class="k">done at latest status (${tot.done})</div></div>
      <div class="stat"><div class="v">${gAvg === null ? "–" : gAvg + "%"}</div><div class="k">average % complete</div></div>
      <div class="stat"><div class="v accent">${tot.highDone} of ${tot.high}</div><div class="k">High-priority done</div></div></div>`;
    const lk = (u, key, n) => n ? `<button class="lnk" data-drill="${esc(u)}|${key}" title="Show these tasks">${n}</button>` : `<span class="num muted">0</span>`;
    const line = (label, s, sub, uId, rep, kpi) => `<tr${sub ? ' class="sub"' : ""}><td>${sub ? `<span class="muted">↳ </span>${esc(label)}` : `<button class="lnk unit-name" data-drill="${esc(uId)}|all">${esc(label)}</button>${uId ? `<br><span class="tag">${esc((state.units.find(x => x.id === uId) || {}).type || "")}</span>` : ""}`}</td><td class="num">${sub ? "" : rep}</td>
      <td class="num">${sub ? s.total : lk(uId, "all", s.total)}${!sub && kpi ? `<div class="muted small">+${kpi} KPI lines</div>` : ""}</td><td class="num">${sub ? s.done : lk(uId, "done", s.done)}</td><td class="num">${sub ? s.prog : lk(uId, "prog", s.prog)}</td><td class="num">${sub ? s.notStarted + s.noStatus : lk(uId, "ns", s.notStarted + s.noStatus)}</td><td class="num" style="color:${s.blocked + s.delayed ? "var(--bad)" : "inherit"}">${sub ? s.blocked + s.delayed : lk(uId, "blk", s.blocked + s.delayed)}</td><td class="num">${sub ? `${s.highDone}/${s.high}` : (s.high ? `<button class="lnk" data-drill="${esc(uId)}|high" title="Show completed high-priority tasks">${s.highDone}/${s.high}</button>` : "0/0")}</td>
      <td>${s.avg === null ? '<span class="muted small">–</span>' : `<div class="prog"><div class="bar"><i style="width:${s.avg}%"></i></div><span class="num">${s.avg}%</span></div>`}</td></tr>`;
    const rows = st.map(r => line(r.u.name, r.s, false, r.u.id, `${r.reported} / ${md.weeks.length}`, r.kpi) + (state.monthByDept ? r.dept.filter(x => r.dept.length > 1 || x.d !== "(no department)").map(x => line(x.d, x.s, true, r.u.id)).join("") : "")).join("");
    const totS = { total: tot.uniq, done: tot.done, prog: tot.prog, notStarted: tot.ns, noStatus: 0, blocked: tot.blk, delayed: 0, high: tot.high, highDone: tot.highDone, avg: gAvg };
    const reports = st.filter(r => r.texts.length).map(r => `<details class="rep"><summary><b>${esc(r.u.name)}</b> <span class="muted small">${r.texts.length} weekly report${r.texts.length > 1 ? "s" : ""}</span></summary>${r.texts.map(t => `<div class="ask"><div class="who">${esc(weekLabel(t.week))} · ${esc(ethWeekLabel(t.week))}${t.by ? ` · <span data-person="${esc(t.by)}" data-bare></span>` : ""}</div>${t.wins ? `<p><b>Key results:</b> ${esc(t.wins)}</p>` : ""}${t.blockers ? `<p><b>Blockers:</b> ${esc(t.blockers)}</p>` : ""}${t.asks ? `<p><b>Asks:</b> ${esc(t.asks)}</p>` : ""}</div>`).join("")}</details>`).join("");
    return `${stats}<div class="panel" style="margin-bottom:16px">${head}
      <div class="scroll"><table><thead><tr><th>Unit</th><th>Weeks reported</th><th>Distinct tasks</th><th>Done</th><th>In progress</th><th>Not started / no status</th><th>Blocked / delayed</th><th>High done</th><th>Avg. complete</th></tr></thead><tbody>${rows}${line("All units", totS, false, "", `${tot.rep} / ${st.length} units`, 0)}</tbody></table></div>
      <div class="small muted" style="padding:10px 16px">Select any number to open the tasks behind it. A task that appears in several weeks counts once, at its latest status. KPI / OKR lines are listed separately and are not counted as tasks.</div></div>
    <div class="panel"><div class="panel-head"><h2>Weekly reports in the month</h2><span class="muted small">Key results, blockers and asks, in week order</span></div><div class="asks">${reports || `<div class="empty" style="padding:20px 0"><b>No weekly reports entered</b>Units add key results, blockers and asks when they update a plan.</div>`}</div></div>`;
  }
  const monthFile = () => `${ETH_M[state.eth.m - 1]} ${state.eth.y}`;
  async function exportMonthXlsx(){
    if (!libsReady("xlsx") || !state.monthData) return;
    const st = monthStats(), md = state.monthData, label = ethName(state.eth);
    const wb = XLSX.utils.book_new();
    const sumRow = (name, type, rep, s, kpi) => [name, type, rep, s.total, s.done, s.prog, s.notStarted + s.noStatus, s.blocked, s.delayed, s.high, s.highDone, s.avg === null ? "" : s.avg / 100, kpi];
    const sh = ["Unit","Type","Weeks reported","Distinct tasks","Done","In progress","Not started / no status","Blocked","Delayed","High priority","High done","Average complete","KPI / OKR lines"];
    const ws = sheetFromRows([[`Wagwago Business Group · Monthly report · ${label}`], [`Weeks: ${md.weeks.map(w => weekLabel(w) + " (" + ethWeekLabel(w) + ")").join(" · ")}`], [], sh, ...st.map(r => sumRow(r.u.name, r.u.type || "", `${r.reported} of ${md.weeks.length}`, r.s, r.kpi))], [34,18,14,13,8,12,18,9,9,12,11,15,14]); pctFormat(ws, 11, 4);
    XLSX.utils.book_append_sheet(wb, ws, "Summary");
    const dr = []; st.forEach(r => r.dept.forEach(x => dr.push(sumRow(r.u.name, x.d, "", x.s, ""))));
    const wd = sheetFromRows([["Unit","Department", ...sh.slice(2)], ...dr.map(a => [a[0], a[1], ...a.slice(2)])], [34,26,14,13,8,12,18,9,9,12,11,15,14]); pctFormat(wd, 12, 1);
    XLSX.utils.book_append_sheet(wb, wd, "By department");
    const tk = []; st.forEach(r => r.tasks.forEach(t => tk.push([r.u.name, t.dept || "", t.title || "", t.owner || "", t.due || "", t.priority || "", t.status || "No status", typeof t.pct === "number" ? t.pct / 100 : "", fmt(t.week), t.notes || ""])));
    const wt = sheetFromRows([["Unit","Department","Task / deliverable","Owner","Due","Priority","Latest status","% complete","Latest week","Notes"], ...tk], [30,22,60,22,12,10,13,11,12,50]); pctFormat(wt, 7, 1);
    XLSX.utils.book_append_sheet(wb, wt, "Distinct tasks");
    const rp = []; st.forEach(r => r.texts.forEach(t => rp.push([r.u.name, weekLabel(t.week) + " (" + ethWeekLabel(t.week) + ")", t.wins, t.blockers, t.asks])));
    XLSX.utils.book_append_sheet(wb, sheetFromRows([["Unit","Week","Key results","Blockers","Asks"], ...rp], [30,34,60,50,50]), "Weekly reports");
    await writeXlsx(wb, `Wagwago monthly report ${monthFile()}.xlsx`, "Monthly workbook saved");
  }
  async function exportMonthPdf(){
    if (!libsReady("pdf") || !state.monthData) return;
    const st = monthStats(), md = state.monthData, label = ethName(state.eth);
    const doc = newPdf(`Monthly Report · ${label}`, `Weeks: ${md.weeks.map(w => fmt(w) + " (" + ethWeekLabel(w).replace(/, \d+ EC$/, "") + ")").join(", ")}  ·  Generated ${fmt(todayIso)} ${new Date().getFullYear()}`);
    doc.autoTable({ startY: 92, margin: { left: 36, right: 36 }, head: [["Unit","Weeks reported","Distinct tasks","Done","In progress","Not started / no status","Blocked / delayed","High done","Avg. complete"]],
      body: st.map(r => [r.u.name, `${r.reported} of ${md.weeks.length}`, r.s.total, r.s.done, r.s.prog, r.s.notStarted + r.s.noStatus, r.s.blocked + r.s.delayed, `${r.s.highDone}/${r.s.high}`, r.s.avg === null ? "–" : r.s.avg + "%"]), columnStyles: { 0: { cellWidth: 150, fontStyle: "bold" } }, ...tableStyle() });
    let y0 = doc.lastAutoTable.finalY + 24; y0 = sectionTitle(doc, "Weekly reports: key results, blockers and asks", y0);
    const body = []; st.forEach(r => r.texts.forEach(t => body.push([r.u.name, fmt(t.week), t.wins || "–", t.blockers || "–", t.asks || "–"])));
    doc.autoTable({ startY: y0, margin: { left: 36, right: 36 }, head: [["Unit","Week","Key results","Blockers","Asks"]], body: body.length ? body : [["No weekly reports entered","","","",""]], columnStyles: { 0: { cellWidth: 110, fontStyle: "bold" }, 1: { cellWidth: 44 } }, ...tableStyle() });
    const n = doc.getNumberOfPages(), H = doc.internal.pageSize.getHeight();
    for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(...Y.muted); doc.text(`Monthly report · ${label} · Page ${i} of ${n}`, 36, H - 18); }
    await save(`Wagwago monthly report ${monthFile()}.pdf`, doc.output("arraybuffer"), "Monthly report saved. Open it to print.");
  }

  // ---------- import: what will happen to existing data ----------
  async function computeImpact(){
    const imp = state.imp; if (!imp || !imp.rows || !db) return;
    const groups = new Map(); imp.rows.filter(r => !r.err.length).forEach(r => { const k = r.week + "|" + r.unit.id; if (!groups.has(k)) groups.set(k, { week: r.week, unit: r.unit, rows: [] }); groups.get(k).rows.push(r); });
    let upd = 0, add = 0, keep = 0, rem = 0;
    for (const g of groups.values()) {
      let existing = []; try { const s = await db.doc(`plans/${planId(g.week, g.unit.id)}`).get(); existing = s.exists ? (s.data().tasks || []) : []; } catch (e) {}
      const keys = new Set(existing.map(t => norm(t.title))), seen = new Set();
      g.rows.forEach(r => { const k = norm(r.row.title); if (keys.has(k)) { upd++; seen.add(k); } else add++; });
      keep += existing.filter(t => !seen.has(norm(t.title))).length; rem += existing.length;
    }
    if (state.imp === imp) { imp.impact = { upd, add, keep, rem, n: imp.rows.filter(r => !r.err.length).length }; render(); }
  }

  // ---------- rendering ----------
  let bannerMsg = "";
  function banner(m){ bannerMsg = m; render(); }

  function unitName(id){ const u = state.units.find(x => x.id===id); return u ? u.name : id; }
  function sortedUnits(){ return [...state.units].sort((a,b) => (a.type||"").localeCompare(b.type||"") || (a.order??99)-(b.order??99) || a.name.localeCompare(b.name)); }

  function renderHero(){
    $("#weekLabel").textContent = weekLabel(state.week);
    const units = state.units.length;
    const submitted = state.units.filter(u => (state.plans[u.id]?.tasks||[]).length).length;
    const all = Object.values(state.plans).flatMap(p => realTasks(p));
    const done = all.filter(t => t.status==="Done").length;
    $("#heroChips").innerHTML = state.plansLoaded && units ? `
      <span class="hero-chip"><b>${submitted}/${units}</b> units submitted</span>
      <span class="hero-chip"><b>${all.length}</b> tasks planned</span>
      <span class="hero-chip"><b>${done}</b> done</span>` : "";
    const hp = $("#heroProg");
    if (hp) { const pool = Object.values(state.plans).flatMap(p => realTasks(p)); hp.hidden = !(state.plansLoaded && pool.length) || state.tab === "monthly";
      if (!hp.hidden) hp.innerHTML = progressBar(`Overall progress of the week's plan`, avgOf(pool), `${done} of ${all.length} tasks done · every task counts, no status or % counts as 0`, true); }
    const mo = state.tab === "monthly";
    $("#heroTitle").textContent = mo ? "Monthly Report" : "Weekly Activity Tracking";
    $("#heroSub").textContent = mo ? "Consolidated by Ethiopian calendar month. Select any number to see the tasks behind it." : "Each function and business unit enters and updates its plan for the week.";
    if (mo) { const r = ethMonthRange(state.eth); $("#weekLabel").textContent = ethName(state.eth); $("#weekSub").textContent = `${fmt(r.start)} – ${fmt(r.end)} ${parse(r.end).getFullYear()}`; }
    else $("#weekSub").textContent = (state.week === thisMonday() ? "This week · " : state.week === nextMonday() ? "Next week · " : "") + ethWeekLabel(state.week);
    $("#thisWeek").textContent = mo ? "This month" : "This week";
    $("#prevWeek").setAttribute("aria-label", mo ? "Previous month" : "Previous week"); $("#nextWeek").setAttribute("aria-label", mo ? "Next month" : "Next week");
    document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab===state.tab)));
    $("#unitsTabBtn").hidden = !isAppr();
    const nb = X.badgeCount(), fbb = $("#fbCount"); if (fbb) { fbb.textContent = nb; fbb.hidden = !nb; }
    const np = pendingFor().length, ab = $("#apprCount"); if (ab) { ab.textContent = np; ab.hidden = !np; } const bb = $("#bellBtn"); if (bb) bb.classList.toggle("has", !!np);
    const role = isAppr() ? "Group Strategy approver" : rights.unitOk ? unitName(auth().unit) : "view only";
    $("#whoBtn").innerHTML = myId ? `<b>${esc(myId)}</b> · ${esc(role)} · change` : "Sign in to update";
    $("#modeChip").hidden = dataMode !== "local";
  }

  function renderOverview(merged){
    if (!state.units.length) return `<div class="panel"><div class="empty"><b>No units set up yet</b>${isAppr() ? "Open the Units tab to add the functions and business units that report weekly." : "The Strategy Office has not added the reporting units yet."}</div></div>`;
    const rows = sortedUnits().map(u => ({ u, p: state.plans[u.id], s: summarize(state.plans[u.id]) }));
    const tot = rows.reduce((a,r) => ({ total: a.total+r.s.total, done: a.done+r.s.done, blocked: a.blocked+r.s.blocked, high: a.high+r.s.high, highDone: a.highDone+r.s.highDone, overdue: a.overdue+r.s.overdue }), { total:0, done:0, blocked:0, high:0, highDone:0, overdue:0 });
    const submitted = rows.filter(r => r.s.total || r.s.kpi).length;
    const groupAvg = avgOf(rows.flatMap(r => realTasks(r.p)));
    const stats = `<div class="stats">
      <div class="stat"><div class="v">${submitted} of ${rows.length}</div><div class="k">units submitted a plan</div></div>
      <div class="stat"><div class="v">${tot.total}</div><div class="k">tasks planned this week</div></div>
      <div class="stat"><div class="v">${tot.total ? Math.round(tot.done/tot.total*100) : 0}%</div><div class="k">tasks done (${tot.done})</div></div>
      <div class="stat"><div class="v">${groupAvg===null?"–":groupAvg+"%"}</div><div class="k">average % complete</div></div>
      <div class="stat"><div class="v accent">${tot.highDone} of ${tot.high}</div><div class="k">High-priority tasks done</div></div>
      <div class="stat"><div class="v accent">${tot.blocked + tot.overdue}</div><div class="k">blocked or overdue</div></div>
    </div>`;
    const tr = rows.map(({u,p,s}) => {
      const state_ = !s.total && s.kpi ? `<span class="pill s-none">KPI lines only</span>` : !s.total ? `<span class="pill s-bad">No plan</span>` : s.noStatus===s.total ? `<span class="pill s-not">No status</span>` : `<span class="pill s-done">Submitted</span>`;
      const prog = s.avg===null ? `<span class="muted small">–</span>` : `<div class="prog"><div class="bar"><i style="width:${s.avg}%"></i></div><span class="num">${s.avg}%</span></div>`;
      const upd = p && p.updatedAt ? `${fmt(p.updatedAt.slice(0,10))} ${p.updatedBy ? `<span class="muted" data-person="${esc(p.updatedBy)}"></span>` : `<span class="muted">data load</span>`}` : `<span class="muted">–</span>`;
      return `<tr class="clickable" data-open-unit="${esc(u.id)}" tabindex="0">
        <td><div class="unit-name">${esc(u.name)}</div><span class="tag">${esc(u.type||"")}</span></td>
        <td>${state_}</td>
        <td class="num">${s.total}${s.kpi ? `<div class="muted small">+${s.kpi} KPI</div>` : ""}</td>
        <td class="num">${s.done}</td>
        <td class="num">${s.high}</td>
        <td class="num" style="color:${s.blocked+s.overdue?"var(--bad)":"inherit"}">${s.blocked}${s.overdue?` / ${s.overdue}`:""}</td>
        <td>${prog}</td>
        <td class="small">${upd}</td>
      </tr>`;
    }).join("");
    const asks = rows.filter(r => r.p && (r.p.asks||r.p.blockers)).map(({u,p}) => `
      <div class="ask"><div class="who">${esc(u.name)}</div>
      ${p.blockers ? `<p><b>Blockers:</b> ${esc(p.blockers)}</p>` : ""}
      ${p.asks ? `<p><b>Asks:</b> ${esc(p.asks)}</p>` : ""}</div>`).join("");
    return `${merged ? "" : stats}
    <div class="grid2" style="${merged ? "margin-top:16px;grid-template-columns:minmax(0,1fr)" : ""}">
      <div class="panel">
        <div class="panel-head"><h2>Units this week</h2><div class="toolbar"><span class="muted small">Select a unit to open its plan</span>${downloads ? `${merged ? "" : `<button class="btn primary" id="pdfBtn">Performance report (PDF)</button>`}<button class="btn" id="xlsxAllBtn">All plans (Excel)</button>` : ""}</div></div>
        <div class="scroll"><table>
          <thead><tr><th>Unit</th><th>Plan</th><th>Tasks</th><th>Done</th><th>High</th><th>Blocked / overdue</th><th>Avg. complete</th><th>Last update</th></tr></thead>
          <tbody>${tr}</tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Blockers and asks</h2></div>
        <div class="asks">${asks || `<div class="empty" style="padding:20px 0"><b>Nothing raised yet</b>Blockers and asks that units enter with their plans appear here.</div>`}</div>
      </div>
    </div>`;
  }

  const unitOf = id => state.units.find(u => u.id === id) || {};
  function deptOptions(u, t){
    const list = [...(unitOf(u).departments || [])];
    if (t.dept && !list.includes(t.dept)) list.unshift(t.dept);
    return `<option value="">${list.length ? "Choose department" : "No department"}</option>` + list.map(d => `<option ${d===t.dept?"selected":""}>${esc(d)}</option>`).join("") + `<option value="__new__">＋ Add a department…</option>`;
  }
  // A saved task in a week that has started keeps its definition; the unit can ask to change it.
  const savedTask = (u, t) => !!((state.base[u] && state.base[u].tasks) || []).some(x => x.id === t.id);
  const isLocked = (u, t) => !isAppr() && savedTask(u, t) && state.week <= thisMonday() && !state.unlock.has(t.id);
  const pendingTask = (u, id) => pendingFor(u, state.week).some(r => (r.patch || []).some(o => o.id === id));
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  const sel = (on) => on ? "selected" : "";
  function taskRowHtml(u, t, i){
    const key = `${u}|${i}`, ed = canEdit(u), lk = isLocked(u, t), dis = ed ? "" : "disabled", ldis = (!ed || lk) ? "disabled" : "";
    const pend = pendingTask(u, t.id), carriedN = t.carriedCount || (t.carried ? 1 : 0);
    const tags = [carriedN ? `<span class="tag" title="Brought forward from an earlier week">carried${carriedN > 1 ? ` ${carriedN} weeks` : ""}</span>` : "", pend ? '<span class="pill s-not">change waiting for approval</span>' : "", lk ? '<span class="tag lock" title="Saved task: the title, outcome, type, department, due date and priority are fixed. Use Request change to ask Group Strategy.">🔒 fixed</span>' : ""].join("");
    const main = lk || !ed
      ? `<div class="task-title" title="${esc(t.title)}">${t.priority === "High" ? '<span class="hi-dot" title="High priority"></span>' : ""}${esc(t.title) || '<span class="muted">(no title)</span>'}</div>${t.outcome ? `<div class="task-out"><b>Expected outcome:</b> ${esc(t.outcome)}</div>` : ""}`
      : `<textarea class="grow title-in" rows="2" id="t-title-${t.id}" data-f="title" placeholder="Task or deliverable" aria-label="Task">${esc(t.title)}</textarea>
         <textarea class="grow out-in" rows="2" id="t-outcome-${t.id}" data-f="outcome" placeholder="Expected outcome: what will exist or change when this is done" aria-label="Expected outcome">${esc(t.outcome || "")}</textarea>`;
    const side = !ed ? "" : `${lk ? `<button class="btn small" data-unlock="${esc(t.id)}" title="Edit the fixed fields. The change goes to Group Strategy for approval.">Request change</button>` : ""}
      ${state.confirmDelete === t.id ? `<span class="confirm">${savedTask(u, t) && !isAppr() && state.week <= thisMonday() ? "Ask to remove?" : "Remove?"} <button class="btn danger" data-del-yes="${esc(key)}">Yes</button><button class="btn" data-del-no>No</button></span>` : `<button class="icon-btn" data-del="${t.id}" aria-label="Remove task" title="Remove task">×</button>`}`;
    const others = sortedUnits().filter(x => x.id !== u);
    const ev = (t.ev || []).map((e, k) => `<div class="ev"><button class="lnk ev-open" type="button" data-ev="${esc(u)}|${i}|${k}" title="${esc(e.name)} · ${fmtSize(e.size || 0)}">📎 ${esc(e.name.length > 18 ? e.name.slice(0, 15) + "…" : e.name)}</button>${ed ? `<button class="icon-btn" type="button" data-ev-del="${esc(u)}|${i}|${k}" aria-label="Remove ${esc(e.name)}">×</button>` : ""}</div>`).join("");
    const depNote = (t.depUnit || t.dep) ? `<div class="small muted dep-note">Depends on ${esc(depText(t))}</div>` : "";
    const stExtra = t.status === "Blocked" && t.blockedSince ? `<div class="small muted">since ${esc(fmt(t.blockedSince))}</div>` : "";
    const prevTxt = (t.prevStatus || typeof t.prevPct === "number") ? `<div class="small muted" title="Status at the end of last week">was: ${esc(t.prevStatus || "No status")}${typeof t.prevPct === "number" ? " " + t.prevPct + "%" : ""}</div>` : "";
    const doneTxt = isAppr() ? (t.status === "Done" ? `<label class="small muted">Completed on <input type="date" id="t-cd-${t.id}" data-f="completedAt" value="${esc(t.completedAt || "")}" aria-label="Actual completion date"></label>` : "") : (t.completedAt ? `<div class="small muted" id="t-cd-${t.id}">Done ${esc(fmt(t.completedAt))}</div>` : "");
    return `<tr class="task-row" data-u="${esc(u)}" data-i="${i}">
      <td class="c-task"><div class="task-main">${main}${tags ? `<div class="task-tags">${tags}</div>` : ""}</div></td>
      <td class="c-kind"><select id="t-kind-${t.id}" data-f="kind" aria-label="Type" ${ldis}>${KINDS.map(k => `<option ${sel(k === (t.kind || "Task"))}>${k}</option>`).join("")}</select></td>
      <td class="c-dept"><select id="t-dept-${t.id}" data-f="dept" aria-label="Department" ${ldis}>${deptOptions(u, t)}</select></td>
      <td class="c-due"><input type="date" id="t-due-${t.id}" data-f="due" value="${esc(t.due)}" aria-label="Due date" ${ldis}></td>
      <td class="c-pri"><select id="t-pri-${t.id}" data-f="priority" aria-label="Priority" ${ldis}><option value="" ${sel(!t.priority)}>Not set</option>${PRIORITIES.map(p => `<option ${sel(p === t.priority)}>${p}</option>`).join("")}</select></td>
      <td class="c-status"><select id="t-st-${t.id}" data-f="status" aria-label="Status update" ${dis}><option value="" ${sel(!t.status)}>No status</option>${STATUSES.map(x => `<option ${sel(x === t.status)}>${x}</option>`).join("")}</select>${stExtra}${prevTxt}${doneTxt}</td>
      <td class="c-pct"><input type="number" id="t-pct-${t.id}" data-f="pct" min="0" max="100" step="5" value="${t.pct ?? ""}" placeholder="%" aria-label="Percent complete" ${dis}></td>
      <td class="c-notes"><textarea class="grow" rows="3" id="t-notes-${t.id}" data-f="notes" placeholder="Note, next step or dependency" aria-label="Note" ${dis}>${esc(t.notes)}</textarea>${depNote}</td>
      <td class="c-ev"><div class="ev-col">${ev || (ed ? "" : '<span class="muted small">none</span>')}${ed ? `<label class="btn small ev-add" title="Optional. Up to ${EVIDENCE.maxFiles} files at once, ${fmtSize(EVIDENCE.maxTotal)} in total">📎 Attach<input type="file" multiple accept="${EVIDENCE.accept}" data-ev-add="${esc(u)}|${i}" hidden></label>` : ""}</div></td>
      <td class="c-owner"><input type="text" list="dl-owners-${esc(u)}" id="t-owner-${t.id}" data-f="owner" value="${esc(t.owner)}" placeholder="Name" aria-label="Owner name" ${dis}></td>
      <td class="c-act"><div class="task-side">${side}</div></td>
    </tr>`;
  }
  const editHead = () => `<colgroup><col class="k-task"><col class="k-kind"><col class="k-dept"><col class="k-due"><col class="k-pri"><col class="k-status"><col class="k-pct"><col class="k-notes"><col class="k-ev"><col class="k-owner"><col class="k-act"></colgroup><thead><tr>${th("edit","title","Task")}${th("edit","kind","Type")}${th("edit","dept","Department")}${th("edit","due","Due")}${th("edit","priority","Priority")}${th("edit","status","Status update")}${th("edit","pct","%")}${th("edit","notes","Note")}${th("edit","ev","Evidence")}${th("edit","owner","Owner (name)")}<th></th></tr></thead>`;

  // ---------- helpers for task kinds ----------
  const KINDS = ["Task","KPI / OKR"];
  const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  // ---------- sorting by column (click a column title) ----------
  state.sort = {};
  const PRI_RANK = { High: 0, Medium: 1, Low: 2 }, ST_RANK = { "Not started": 0, "In progress": 1, "Blocked": 2, "Delayed": 3, "Done": 4 };
  const sortVal = (t, k) => ({
    title: (t.title || "").toLowerCase(), kind: t.kind || "Task", dept: (t.dept || "").toLowerCase(), owner: (t.owner || "").toLowerCase(), unit: (t.unitName || "").toLowerCase(),
    due: t.due || "", priority: PRI_RANK[t.priority] ?? 9, status: ST_RANK[t.status] ?? 9, pct: typeof t.pct === "number" ? t.pct : (t.status === "Done" ? 100 : -1),
    notes: (t.notes || "").toLowerCase(), ev: (t.ev || []).length,
  })[k];
  // Returns the list's indexes in display order. Empty values always go last.
  function sortOrder(list, scope, valFn = sortVal){
    const sp = state.sort[scope], idx = list.map((_, i) => i);
    if (!sp || !sp.k) return idx;
    const empty = v => v === "" || v === 9 || v === -1;
    return idx.sort((a, b) => {
      const A = valFn(list[a], sp.k), B = valFn(list[b], sp.k), ea = empty(A), eb = empty(B);
      if (ea !== eb) return ea ? 1 : -1;
      return (A < B ? -1 : A > B ? 1 : 0) * sp.dir || a - b;
    });
  }
  const sortedBy = (list, scope) => sortOrder(list, scope).map(i => list[i]);
  const th = (scope, k, label, cls = "") => { const sp = state.sort[scope] || {}, on = sp.k === k; return `<th class="sortable ${cls}" data-sort="${scope}:${k}" tabindex="0" role="button" aria-sort="${on ? (sp.dir > 0 ? "ascending" : "descending") : "none"}" title="Sort by ${esc(label)}">${label}<span class="si">${on ? (sp.dir > 0 ? "▲" : "▼") : "↕"}</span></th>`; };
  // ---------- version 3: Business support, Feedback and Corrective actions (src/extras.js) ----------
  const X = createExtras({
    state, esc, fmt, th: (...a) => th(...a), sortOrder: (...a) => sortOrder(...a), sortedUnits: () => sortedUnits(), unitName: id => unitName(id), todayIso, toast: (...a) => toast(...a),
    errText: e => errText(e), render: () => render(), db: () => db, api: () => api, auth: () => auth(), isAppr: () => isAppr(), canEdit: u => canEdit(u), myUnit: () => myUnit(),
    downloads: () => downloads, libsReady: k => libsReady(k), sheetFromRows: (...a) => sheetFromRows(...a), writeXlsx: (...a) => writeXlsx(...a), XLSX: () => XLSX,
    newPdf: (...a) => newPdf(...a), pdfStyle: () => pdfStyle(), pdfFooter: (...a) => pdfFooter(...a), save: (...a) => save(...a), goTab: t => goTab(t), weekLabel: w => weekLabel(w),
    weekChoices: () => { const t = thisMonday(); return [nextWeekOf(t), t, prevWeekOf(t), prevWeekOf(prevWeekOf(t)), prevWeekOf(prevWeekOf(prevWeekOf(t)))]; }, thisWeek: () => thisMonday(), ALL,
  });
  const realTasks = p => ((p && p.tasks) || []).filter(t => t.kind !== "KPI / OKR");
  const kpiTasks = p => ((p && p.tasks) || []).filter(t => t.kind === "KPI / OKR");
  const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const short = s => { s = String(s || ""); return s.length > 70 ? s.slice(0, 67) + "…" : s; };
  const nameOf = id => (id ? (state.names[id] || "") : "");

  // ---------- accountability: who changed what ----------
  const FIELDS = ["title","dept","owner","due","priority","status","pct","notes","kind","outcome","depUnit","dep"];
  const FLAB = { title:"Task", dept:"Department", owner:"Owner", due:"Due", priority:"Priority", status:"Status", pct:"%", notes:"Notes", kind:"Type", outcome:"Expected outcome", prevStatus:"Previous status", prevPct:"Previous %", completedAt:"Completed on", depUnit:"Depends on", dep:"Dependency", ev:"Evidence", carried:"Carried", carriedCount:"Weeks carried", blockedSince:"Blocked since" };
  const showV = v => (v === null || v === undefined || v === "") ? "–" : String(v);
  // Requests (approvals) are shared state: everyone sees pending ones; approvers act on them.
  let unsubReq = null;
  function subscribeRequests(){
    if (!db || unsubReq) return;
    unsubReq = db.collection("requests").orderBy("createdAt","desc").limit(300).onSnapshot(snap => {
      state.requests = snap.docs.map(d => ({ id: d.id, ...d.data() })); render();
    }, () => { state.requests = []; });
  }
  const pendingFor = (u, w) => state.requests.filter(r => r.status === "pending" && (!u || r.unit === u) && (!w || r.week === w));
  let unsubAct = null;
  function subscribeActivity(){
    if (!db || unsubAct) return;
    unsubAct = db.collection("activity").orderBy("ts","desc").limit(400).onSnapshot(snap => {
      state.activity = snap.docs.map(d => { const a = { id: d.id, ...d.data() }; if (typeof a.details === "string") { try { a.details = JSON.parse(a.details); } catch (e) { a.details = [a.details]; } } if (!Array.isArray(a.details)) a.details = []; return a; }); state.actLoaded = true;
      if (state.tab === "activity") render();
    }, err => { state.actLoaded = true; state.actErr = err.code; unsubAct = null; render(); });
  }
  const ACTIONS = ["save","import","request","approval","restore","lists","unit","evidence","data-load"];
  const actionLabel = a => ({ save:"Saved plan", import:"Imported file", "data-load":"Data load", lists:"Departments / staff", unit:"Unit change", request:"Asked for approval", approval:"Approval decision", restore:"Restore / undo", evidence:"Evidence", support:"Business support", feedback:"Feedback", corrective:"Corrective action" })[a] || a;

  function renderActivity(){
    if (!db) return `<div class="panel"><div class="empty"><b>No activity to show</b>The shared store is not available in this view.</div></div>`;
    if (!state.actLoaded) return `<div class="panel"><div class="empty"><b>Loading activity…</b></div></div>`;
    if (state.actErr) return `<div class="banner warn">Could not load the activity log (${esc(state.actErr)}). Reload the page to try again.</div>`;
    const f = state.actFilter, all = state.activity;
    const people = [...new Set(all.map(a => a.by))];
    const list = all.filter(a => (!f.unit || a.unit === f.unit) && (f.who === "" || a.by === (f.who === "__sys__" ? "" : f.who)) && (!f.action || a.action === f.action));
    const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
    const by = {};
    all.filter(a => a.ts >= cutoff && a.action !== "data-load").forEach(a => { const k = a.by || ""; const r = by[k] || (by[k] = { n: 0, units: new Set(), last: "" }); r.n++; if (a.unit) r.units.add(a.unit); if (a.ts > r.last) r.last = a.ts; });
    const sumRows = Object.entries(by).sort((a, b) => b[1].n - a[1].n).map(([id, r]) => `<tr><td><b>${id ? `<span data-person="${esc(id)}" data-bare>Someone</span>` : "System"}</b></td><td class="num">${r.n}</td><td class="small">${[...r.units].map(unitName).map(esc).join(", ") || "–"}</td><td class="small">${esc(r.last.slice(0,10))} ${esc(r.last.slice(11,16))} UTC</td></tr>`).join("");
    const rows = list.map(a => `<tr>
      <td class="small num" style="white-space:nowrap">${esc((a.ts || "").slice(0,10))}<br><span class="muted">${esc((a.ts || "").slice(11,16))} UTC</span></td>
      <td>${a.by ? `<b data-person="${esc(a.by)}" data-bare>Someone</b>` : `<span class="muted">System</span>`}</td>
      <td class="small">${a.unit ? esc(unitName(a.unit)) : "–"}</td>
      <td class="small">${a.week ? esc(weekLabel(a.week)) : "–"}</td>
      <td><span class="pill s-none">${esc(actionLabel(a.action))}</span></td>
      <td class="small">${esc(a.summary)}${(a.details || []).length ? `<details><summary class="muted">${a.details.length} detail${a.details.length > 1 ? "s" : ""}</summary><ul style="margin:6px 0 0;padding-left:18px">${a.details.map(x => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}</td></tr>`).join("");
    return `<div class="banner info">Every save, import and department change is recorded with the person who made it. Task rows also show who last changed them under All tasks.</div>
    <div class="grid2" style="margin-bottom:16px">
      <div class="panel"><div class="panel-head"><h2>Who is updating</h2><span class="muted small">Last 30 days</span></div>
        ${sumRows ? `<div class="scroll"><table><thead><tr><th>Person</th><th>Updates</th><th>Units</th><th>Last active</th></tr></thead><tbody>${sumRows}</tbody></table></div>` : `<div class="empty"><b>No updates yet</b>Saves and imports appear here.</div>`}</div>
      <div class="panel"><div class="panel-head"><h2>Not updated this week</h2></div><div class="asks">${(() => { const ids = state.units.filter(u => { const p = state.plans[u.id]; return !(p && p.updatedAt && p.updatedBy); }).map(u => u.name); return ids.length ? `<p class="small muted" style="margin:6px 0">No saved update by a person for ${esc(weekLabel(state.week))}:</p><div class="chipset">${ids.map(n => `<span class="tag">${esc(n)}</span>`).join("")}</div>` : `<div class="empty" style="padding:20px 0"><b>Every unit has an update</b></div>`; })()}</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Activity log</h2><div class="toolbar">
        <select id="aUnit" aria-label="Filter by unit"><option value="">All units</option>${sortedUnits().map(u => `<option value="${esc(u.id)}" ${f.unit === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
        <select id="aWho" aria-label="Filter by person"><option value="">Everyone</option>${people.map(id => `<option value="${id || "__sys__"}" ${f.who === (id || "__sys__") ? "selected" : ""}>${id ? esc(nameOf(id) || "User " + id.slice(-4)) : "System"}</option>`).join("")}</select>
        <select id="aAct" aria-label="Filter by action"><option value="">All actions</option>${ACTIONS.map(a => `<option value="${a}" ${f.action === a ? "selected" : ""}>${actionLabel(a)}</option>`).join("")}</select>
        <span class="muted small">${list.length} entries</span>${downloads ? `<button class="btn" id="actXlsx">Excel</button>` : ""}</div></div>
      ${list.length ? `<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>Unit</th><th>Week</th><th>Action</th><th>What changed</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><b>No entries match</b>Change the filters.</div>`}
    </div>`;
  }
  async function exportActivityXlsx(){
    if (!libsReady("xlsx")) return;
    const rows = [["When (UTC)","Who","Unit","Week","Action","Summary","Details"], ...state.activity.map(a => [a.ts, a.by ? (nameOf(a.by) || a.by) : "System", a.unit ? unitName(a.unit) : "", a.week || "", actionLabel(a.action), a.summary || "", (a.details || []).join("\n")])];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, sheetFromRows(rows, [22,24,30,14,18,50,80]), "Activity");
    await writeXlsx(wb, "Wagwago weekly tracking activity log.xlsx", "Activity log saved");
  }

  // ---------- departments and staff inside a unit ----------
  async function updateUnitList(field, value, text){
    const u = state.editUnit; if (!u || isAll() || !db) return false;
    if (!canEdit(u)) { toast(ERR.not_allowed); return false; }
    try { const r = await api.saveUnit(auth(), "lists", { id: u, [field]: value }, text); if (r.error) { toast(errText(r)); return false; } return true; }
    catch (e) { toast(errText(e)); return false; }
  }
  async function addDept(){
    const el = $("#newDept"); const name = (el.value || "").trim().replace(/\s+/g, " ");
    if (!name) { toast("Type a department name first"); return; }
    const list = unitOf(state.editUnit).departments || [];
    if (list.some(x => x.toLowerCase() === name.toLowerCase())) { toast("That department already exists"); return; }
    if (await updateUnitList("departments", [...list, name], `Added department "${name}"`)) { toast("Department added"); setTimeout(() => { const n = $("#newDept"); n && n.focus(); }); }
  }
  async function removeDept(name){
    state.confirmDelete = null;
    const list = unitOf(state.editUnit).departments || [];
    if (await updateUnitList("departments", list.filter(x => x !== name), `Removed department "${name}"`)) toast("Department removed. Tasks keep their label.");
  }
  async function addPerson(){
    const name = ($("#newPerson").value || "").trim().replace(/\s+/g, " "), dept = $("#newPersonDept").value;
    if (!name) { toast("Type a name first"); return; }
    const list = unitOf(state.editUnit).people || [];
    if (list.some(p => p.name.toLowerCase() === name.toLowerCase())) { toast("That name is already in the list"); return; }
    if (await updateUnitList("people", [...list, dept ? { name, dept } : { name }], `Added staff name "${name}"${dept ? " (" + dept + ")" : ""}`)) toast("Name added");
  }
  async function removePerson(i){
    state.confirmDelete = null;
    const list = [...(unitOf(state.editUnit).people || [])]; const gone = list.splice(i, 1)[0];
    if (await updateUnitList("people", list, `Removed staff name "${gone && gone.name}"`)) toast("Name removed");
  }
  function ownerDatalist(u){
    const names = new Set((unitOf(u).people || []).map(p => p.name));
    const p = isAll() ? (state.allDrafts && state.allDrafts[u]) : state.draft;
    ((p && p.tasks) || []).forEach(t => t.owner && names.add(t.owner));
    return `<datalist id="dl-owners-${esc(u)}">${[...names].map(n => `<option value="${esc(n)}"></option>`).join("")}</datalist>`;
  }
  function renderLists(){
    const u = unitOf(state.editUnit), depts = u.departments || [], people = u.people || [];
    const cnt = d => ((state.draft && state.draft.tasks) || []).filter(t => t.dept === d).length;
    const chips = depts.map(d => state.confirmDelete === "dept:" + d
      ? `<span class="confirm">Remove ${esc(d)}? <button class="btn danger" data-dept-yes="${esc(d)}">Remove</button><button class="btn" data-del-no>Keep</button></span>`
      : `<span class="chip">${esc(d)} <span class="muted small">${cnt(d)} this week</span><button data-dept-del="${esc(d)}" aria-label="Remove ${esc(d)}">×</button></span>`).join("");
    const ppl = people.map((p, i) => state.confirmDelete === "person:" + i
      ? `<li><span class="confirm">Remove ${esc(p.name)}? <button class="btn danger" data-person-yes="${i}">Remove</button><button class="btn" data-del-no>Keep</button></span></li>`
      : `<li><span>${esc(p.name)}${p.dept ? ` <span class="tag">${esc(p.dept)}</span>` : ""}</span><button class="icon-btn" data-person-del="${i}" aria-label="Remove ${esc(p.name)}">×</button></li>`).join("");
    return `<div class="reports" style="border-bottom:1px solid var(--line)">
      <div><label for="newDept">Departments in ${esc(u.name || "")}</label>
        <div class="chipset" style="margin-bottom:10px">${chips || `<span class="muted small">No departments yet. Add the first one below.</span>`}</div>
        <div class="toolbar"><input type="text" id="newDept" placeholder="New department name" style="flex:1;min-width:160px"><button class="btn primary" id="addDeptBtn">Add department</button></div></div>
      <div><label for="newPerson">Staff names (optional, fills the owner suggestions)</label>
        <ul class="plain">${ppl || `<li class="muted small">No names yet.</li>`}</ul>
        <div class="toolbar"><input type="text" id="newPerson" placeholder="Name" style="flex:1;min-width:120px"><select id="newPersonDept" aria-label="Department of this person"><option value="">No department</option>${depts.map(d => `<option>${esc(d)}</option>`).join("")}</select><button class="btn" id="addPersonBtn">Add name</button></div></div>
      <div style="display:flex;flex-direction:column;justify-content:flex-end;gap:8px"><span class="small muted">Changes save straight away and fill the Department dropdown for every task in this unit. Import files can also create departments.</span><div class="toolbar"><button class="btn" id="listsCancel">Close</button></div></div>
    </div>`;
  }

  function alertsFor(u){
    const unit = unitOf(u); if (!unit.id) return [];
    return unitAlerts({ unit, plan: state.plans[u], nextPlan: state.week === thisMonday() ? (state.nextPlans || {})[u] || null : undefined, weekPlans: state.plans, week: state.week, thisMonday: thisMonday(), today: todayIso, requests: state.requests });
  }
  function remindersPanel(u){
    const list = alertsFor(u).sort((a, b) => levelRank[a.level] - levelRank[b.level]);
    if (!list.length) return "";
    const open = state.remOpen !== false;
    return `<details class="reminders" ${open ? "open" : ""} id="remPanel"><summary><b>Reminders for ${esc(unitName(u))}</b> <span class="small muted">${list.length} item${list.length === 1 ? "" : "s"}, checked automatically</span></summary>
      <ul>${list.map(a => `<li class="${a.level}"><span class="pill ${a.level === "bad" ? "s-bad" : a.level === "warn" ? "s-not" : "s-none"}">${a.level === "bad" ? "Act now" : a.level === "warn" ? "Soon" : "Note"}</span> <span>${esc(a.text)}${a.tasks.length ? `<span class="small muted"> ${a.tasks.slice(0, 3).map(t => `“${esc(short(t.title))}”${t.fromUnit ? ` (${esc(unitName(t.fromUnit))})` : ""}`).join(", ")}${a.tasks.length > 3 ? ` +${a.tasks.length - 3}` : ""}</span>` : ""}</span></li>`).join("")}</ul></details>`;
  }
  function requestsPanel(u){
    const list = pendingFor(u, state.week); if (!list.length) return "";
    return `<div class="banner warn" style="margin:12px 16px 0"><b>${list.length} change request${list.length === 1 ? "" : "s"} waiting for Group Strategy.</b> They are not part of the plan until approved.
      ${list.map(r => `<div class="req-mini"><span>${esc((r.details || [])[0] || r.summary)}${(r.details || []).length > 1 ? ` <span class="muted small">+${r.details.length - 1} more</span>` : ""} <span class="muted small">· ${esc(r.by)} · ${esc(fmt((r.createdAt || "").slice(0, 10)))}</span></span>${canEdit(u) ? `<button class="btn small" data-withdraw="${esc(r.id)}">Withdraw</button>` : ""}${isAppr() ? `<button class="btn small" data-goto="approvals">Review</button>` : ""}</div>`).join("")}</div>`;
  }
  function renderUpdate(){
    if (!state.units.length) return `<div class="panel"><div class="empty"><b>No units to report for</b>Units appear here once the Strategy Office adds them.</div></div>`;
    const opts = `<option value="${ALL}" ${isAll()?"selected":""}>All units</option>` + sortedUnits().map(u => `<option value="${esc(u.id)}" ${u.id===state.editUnit?"selected":""}>${esc(u.name)}${u.id === myUnit() ? " (yours)" : ""}</option>`).join("");
    const single = hasDraft() && !isAll(), ed = single && canEdit(state.editUnit);
    const past = state.week < thisMonday();
    const head = `<div class="panel-head">
      <div class="toolbar"><label for="unitPick" class="small muted">Unit</label>
        <select id="unitPick"><option value="">Choose your function or unit…</option>${opts}</select></div>
      ${single ? `<div class="toolbar">${ed ? `<button class="btn" id="listsBtn">Departments${(unitOf(state.editUnit).departments||[]).length ? ` (${unitOf(state.editUnit).departments.length})` : ""}</button><button class="btn ghost" id="carryBtn">Bring forward unfinished work…</button>` : ""}<button class="btn" id="histBtn" title="Every saved version of this plan">History</button>${downloads ? `<button class="btn" id="unitPdfBtn">Plan (PDF)</button><button class="btn" id="unitXlsxBtn">Plan (Excel)</button>` : ""}${ed ? `<button class="btn primary" id="addTask">+ Add task</button>` : ""}</div>` : ""}
      ${isAll() && downloads ? `<div class="toolbar"><button class="btn" id="pdfBtn">Performance report (PDF)</button><button class="btn" id="xlsxAllBtn">All plans (Excel)</button></div>` : ""}
    </div>`;
    if (!state.editUnit || !hasDraft()) return `<div class="panel">${head}<div class="empty"><b>Choose your unit to start</b>Pick your function or business unit. Anyone can view; to update, sign in with your name and your unit's PIN (the name button at the top). Then update status, % complete, notes and evidence as the week goes on.</div></div>`;
    const warn = state.remoteChanged ? `<div class="banner warn" style="margin:12px 16px 0">Someone else saved ${isAll() ? "one of these plans" : "this plan"} while you were editing. Saving adds your changes on top of theirs. <button class="btn" id="reloadRemote" style="margin-left:6px">Drop mine and load theirs</button></div>` : "";
    const submitLbl = past && !isAppr() ? "Submit for approval" : isAll() ? "Save all changes" : "Save plan";
    const saveBar = (meta) => `<div class="save-bar"><span class="small muted">${state.dirty ? `<b style='color:var(--accent)'>Unsaved changes${isAll() && state.dirtyUnits.size ? ` in ${state.dirtyUnits.size} unit${state.dirtyUnits.size>1?"s":""}` : ""}</b>` : meta}</span>
        <div class="toolbar"><button class="btn" id="discardBtn" ${state.dirty?"":"disabled"}>Discard changes</button><button class="btn primary" id="saveBtn" ${state.dirty?"":"disabled"}>${submitLbl}</button></div></div>`;

    if (isAll()) {
      const can = isAppr();
      const groups = sortedUnits().map(u => {
        const d = state.allDrafts[u.id] || emptyPlan(u.id);
        const s = summarize(d);
        const rows = sortOrder(d.tasks, "edit").map(i => taskRowHtml(u.id, d.tasks[i], i)).join("");
        return `<tbody><tr class="group-row"><td colspan="11"><div class="toolbar" style="justify-content:space-between">
            <div><b>${esc(u.name)}</b> <span class="tag">${esc(u.type||"")}</span> <span class="small muted">${s.total} tasks · ${s.done} done${state.dirtyUnits.has(u.id) ? " · <b style='color:var(--accent)'>edited</b>" : ""}</span></div>
            ${canEdit(u.id) ? `<button class="btn" data-add-unit="${esc(u.id)}">+ Add task</button>` : ""}</div>${ownerDatalist(u.id)}</td></tr>
          ${rows || `<tr><td colspan="11" class="small muted">No tasks entered yet.</td></tr>`}</tbody>`;
      }).join("");
      return `<div class="panel">${head}${warn}${can ? "" : `<div class="banner info" style="margin:12px 16px 0">All units is view-only, except your own unit's rows. Group Strategy approvers can edit every unit here.</div>`}
        <div class="scroll"><table class="edit-table">${editHead()}${groups}</table></div>
        <div class="banner info" style="margin:12px 16px">To edit a unit's key results, blockers and asks, or its departments and staff lists, choose that unit on its own.</div>
        ${saveBar("Showing every unit's plan for this week")}</div>`;
    }

    const d = state.draft;
    const p = state.plans[state.editUnit];
    const meta = p && p.updatedAt ? `Last saved ${fmt(p.updatedAt.slice(0,10))} ${p.updatedAt.slice(11,16)} UTC ${p.updatedBy ? `<span data-person="${esc(p.updatedBy)}"></span>` : `· ${esc(p.source || "data load")}`}` : "Not saved yet for this week";
    const u = unitOf(state.editUnit);
    const access = !ed
      ? `<div class="banner warn" style="margin:12px 16px 0"><b>View only.</b> To update ${esc(u.name || "this unit")}, sign in with your name and ${esc(u.name || "the unit")}'s PIN. <button class="btn" id="signInBtn" style="margin-left:6px">Sign in</button></div>`
      : past && !isAppr() ? `<div class="banner warn" style="margin:12px 16px 0"><b>This week has ended.</b> You can still update it, but your changes go to Group Strategy for approval and are recorded only when approved.</div>`
      : state.week <= thisMonday() && !isAppr() ? `<div class="banner info" style="margin:12px 16px 0">Saved tasks keep their title, expected outcome, type, department, due date and priority (🔒). Update status, %, notes, owner, dependencies and evidence freely. To change a fixed field or remove a task, use <b>Request change</b> or ×: Group Strategy approves it first.</div>` : "";
    const listHint = ed && !(u.departments||[]).length ? `<div class="banner info" style="margin:12px 16px 0">${esc(u.name||"This unit")} has no departments yet. Select <b>Departments</b> to add them, then pick one for each task.</div>` : "";
    const rdis = ed ? "" : "disabled";
    const us = summarize(d);
    const unitBar = us.total ? `<div style="padding:12px 16px 0">${progressBar(`${u.name || "Unit"}: progress this week`, us.avg, `${us.done} of ${us.total} tasks done${us.noStatus ? ` · ${us.noStatus} with no status yet` : ""}`)}</div>` : "";
    return `${X.banner(state.editUnit)}${remindersPanel(state.editUnit)}<div class="panel">${head}${unitBar}${state.showLists && ed ? renderLists() : ""}${access}${warn}${requestsPanel(state.editUnit)}${ed ? carryBanner() : ""}${listHint}
      ${ownerDatalist(state.editUnit)}${d.tasks.length ? `<div class="scroll edit-scroll"><table class="edit-table">${editHead()}<tbody>${sortOrder(d.tasks, "edit").map(i => taskRowHtml(state.editUnit, d.tasks[i], i)).join("")}</tbody></table></div>` : `<div class="empty"><b>No tasks yet for ${esc(unitName(state.editUnit))}</b>${ed ? "Add this week's tasks, or copy last week's unfinished ones." : "Nothing entered for this week."}</div>`}
      <div class="reports">
        <div><label for="f-wins">Key results this week</label><textarea id="f-wins" data-r="wins" placeholder="What was achieved" ${rdis}>${esc(d.wins)}</textarea></div>
        <div><label for="f-blockers">Blockers and issues</label><textarea id="f-blockers" data-r="blockers" placeholder="What is stopping progress" ${rdis}>${esc(d.blockers)}</textarea></div>
        <div><label for="f-asks">Asks to top management or other units</label><textarea id="f-asks" data-r="asks" placeholder="Decision, approval or support needed, and by when" ${rdis}>${esc(d.asks)}</textarea></div>
      </div>
      ${ed ? saveBar(meta) : `<div class="save-bar"><span class="small muted">${meta}</span></div>`}
    </div>`;
  }

  // ---------- approvals (Group Strategy) ----------
  function patchRows(r){
    return (r.patch || []).map(o => {
      if (o.op === "add") return `<tr><td><span class="pill s-done">Add</span></td><td colspan="3">${esc(o.task.title)}</td></tr>`;
      if (o.op === "remove") return `<tr><td><span class="pill s-bad">Remove</span></td><td colspan="3">${esc(o.task.title)}</td></tr>`;
      if (o.op === "text") return `<tr><td><span class="pill s-none">${esc(({ wins: "Key results", blockers: "Blockers", asks: "Asks" })[o.f])}</span></td><td></td><td class="small muted">${esc(o.from || "–")}</td><td class="small">${esc(o.to || "–")}</td></tr>`;
      return `<tr><td><span class="pill ${LOCKED.includes(o.f) ? "s-not" : "s-none"}">${esc(FLAB[o.f] || o.f)}</span></td><td class="small">${esc(short(o.title))}</td><td class="small muted">${esc(showF(o.f, o.from))}</td><td class="small"><b>${esc(showF(o.f, o.to))}</b></td></tr>`;
    }).join("");
  }
  function renderApprovals(){
    const pend = state.requests.filter(r => r.status === "pending"), done = state.requests.filter(r => r.status !== "pending").slice(0, 30);
    const intro = isAppr() ? `<div class="banner info">Changes to past weeks, to fixed task fields and task removals wait here. Approving applies the change to the plan as it is now and records it in the Activity log; rejecting leaves the plan unchanged. The unit sees your note.</div>`
      : `<div class="banner info">These changes are waiting for Group Strategy (${state.approverNames.map(esc).join(", ")}). Only approvers can accept them; sign in with the approver code to act.</div>`;
    const card = r => `<div class="panel req-card" style="margin-bottom:12px"><div class="panel-head"><div><div class="unit-name">${esc(unitName(r.unit))} · <span class="muted">week of ${esc(weekLabel(r.week))}</span></div>
        <div class="small muted">Asked by <b>${esc(r.by || "?")}</b> on ${esc(fmt((r.createdAt || "").slice(0, 10)))} ${esc((r.createdAt || "").slice(11, 16))} UTC · ${esc(r.summary)}</div></div>
        ${isAppr() ? `<div class="toolbar"><input type="text" id="note-${esc(r.id)}" data-req-note="${esc(r.id)}" value="${esc(state.reqNotes[r.id] || "")}" placeholder="Note to the unit (optional)" style="min-width:200px"><button class="btn danger" data-reject="${esc(r.id)}">Reject</button><button class="btn primary" data-approve="${esc(r.id)}">Approve</button></div>` : (canEdit(r.unit) ? `<button class="btn" data-withdraw="${esc(r.id)}">Withdraw</button>` : "")}</div>
      <div class="scroll"><table><thead><tr><th>Change</th><th>Task</th><th>Before</th><th>Proposed</th></tr></thead><tbody>${patchRows(r)}</tbody></table></div></div>`;
    const hist = done.map(r => `<tr><td class="small num">${esc((r.decidedAt || r.createdAt || "").slice(0, 10))}</td><td class="small">${esc(unitName(r.unit))}</td><td class="small">${esc(fmt(r.week))}</td><td class="small">${esc(r.summary)}<div class="muted">${esc(r.by)}</div></td><td><span class="pill ${r.status === "approved" ? "s-done" : r.status === "rejected" ? "s-bad" : "s-none"}">${esc(r.status)}</span></td><td class="small">${esc(r.decidedBy || "")}${r.note ? `<div class="muted">${esc(r.note)}</div>` : ""}</td></tr>`).join("");
    return `${intro}${pend.length ? pend.map(card).join("") : `<div class="panel" style="margin-bottom:16px"><div class="empty"><b>Nothing waiting for approval</b>Requests appear here as soon as a unit submits one.</div></div>`}
      <div class="panel"><div class="panel-head"><h2>Recent decisions</h2></div>${hist ? `<div class="scroll"><table><thead><tr><th>When</th><th>Unit</th><th>Week</th><th>Request</th><th>Result</th><th>By / note</th></tr></thead><tbody>${hist}</tbody></table></div>` : `<div class="empty"><b>No decisions yet</b></div>`}</div>`;
  }
  async function decide(id, approve){
    const r = state.requests.find(x => x.id === id); if (!r) return;
    let plan = null;
    try {
      if (approve) { const s = await db.doc(`plans/${planId(r.week, r.unit)}`).get(); const cur = s.exists ? s.data() : { tasks: [], wins: "", blockers: "", asks: "" }; plan = applyOps(cur, r.patch || [], { at: new Date().toISOString(), by: r.by || "" }); plan.week = r.week; plan.unit = r.unit; plan.source = `Approved request from ${r.by}`; }
      const res = await api.decideRequest(auth(), id, approve, state.reqNotes[id] || "", plan);
      toast(res.error ? errText(res) : approve ? "Approved and recorded" : "Rejected"); delete state.reqNotes[id];
    } catch (e) { toast(errText(e)); }
  }

  // ---------- version history and restore ----------
  async function openHistory(){
    if (!state.editUnit || isAll()) return;
    const id = planId(state.week, state.editUnit);
    state.history = { id, loading: true, list: [], preview: null }; renderHistory();
    try {
      const snap = await db.collection("history").where("rowId", "==", id).orderBy("at", "desc").limit(60).get();
      state.history.list = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(h => h.tbl === "plans");
    } catch (e) { state.history.error = true; }
    state.history.loading = false; renderHistory();
  }
  function renderHistory(){
    const root = $("#modalRoot"), h = state.history; if (!h) { if (!state.bf) root.innerHTML = ""; return; }
    const cur = state.plans[state.editUnit];
    const rows = h.list.map(v => { const p = planFromRow(v.old), s = summarize(p); return `<tr class="${h.preview === v.id ? "sel" : ""}"><td class="small num">${esc(v.at.slice(0, 10))} ${esc(v.at.slice(11, 16))} UTC</td><td class="small">${esc(p.updatedBy || p.source || "–")}</td><td class="small">${esc(v.by || "–")}</td><td class="num small">${s.total} · ${s.done} done</td><td><button class="btn small" data-hprev="${esc(v.id)}">View</button>${isAppr() ? ` <button class="btn small" data-hrestore="${esc(v.id)}">Restore</button>` : ""}</td></tr>`; }).join("");
    const pv = h.preview && h.list.find(v => v.id === h.preview), pp = pv && planFromRow(pv.old);
    root.innerHTML = `<div class="overlay"><div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="hTitle">
      <div class="panel-head"><div><h2 id="hTitle">History · ${esc(unitName(state.editUnit))} · ${esc(weekLabel(state.week))}</h2><div class="small muted">A copy is kept automatically every time this plan is changed. ${isAppr() ? "Restore puts a copy back; the current version is kept as a copy too, so a restore can be undone." : "Group Strategy approvers can restore any copy. You can undo your own save for 30 minutes from the message that appears after saving."}</div></div><button class="icon-btn" id="hClose" aria-label="Close">×</button></div>
      <div class="small" style="padding:10px 16px">Current version: ${cur && cur.updatedAt ? `saved ${esc(cur.updatedAt.slice(0, 16).replace("T", " "))} UTC by ${esc(cur.updatedBy || cur.source || "data load")}` : "not saved"}</div>
      ${h.loading ? `<div class="empty"><b>Loading history…</b></div>` : h.error ? `<div class="banner warn" style="margin:16px">History is not available yet. Run supabase/upgrade-1-safe.sql first.</div>` : rows ? `<div class="scroll"><table><thead><tr><th>Copy taken</th><th>Version saved by</th><th>Replaced by</th><th>Tasks</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><b>No earlier versions</b>Copies appear after the first change to this plan.</div>`}
      ${pp ? `<div class="panel-head" style="border-top:1px solid var(--line)"><h2>Copy from ${esc(pv.at.slice(0, 16).replace("T", " "))} UTC</h2></div><div class="scroll" style="max-height:320px;overflow:auto"><table><thead><tr><th>Task</th><th>Status</th><th>%</th><th>Notes</th></tr></thead><tbody>${pp.tasks.map(t => `<tr><td>${esc(t.title)}</td><td><span class="pill ${statusClass(t.status)}">${esc(t.status || "No status")}</span></td><td class="num small">${t.pct ?? "–"}</td><td class="small muted">${esc(t.notes)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No tasks</td></tr>`}</tbody></table></div>` : ""}
      </div></div>`;
  }

  // ---------- units, PINs and backups (approvers) ----------
  function renderUnits(){
    const ps = state.pinStatus || {};
    const rows = sortedUnits().map(u => `<tr>
      <td><input type="text" id="u-name-${esc(u.id)}" data-unit-name="${esc(u.id)}" value="${esc(u.name)}" aria-label="Unit name"></td>
      <td><select data-unit-type="${esc(u.id)}" id="u-type-${esc(u.id)}" aria-label="Unit type"><option ${u.type==="Corporate function"?"selected":""}>Corporate function</option><option ${u.type==="Business unit"?"selected":""}>Business unit</option></select></td>
      <td>${ps[u.id] ? `<span class="pill s-done">PIN set</span>` : `<span class="pill s-bad">No PIN</span>`}</td>
      <td><div class="toolbar"><input type="text" id="pin-${esc(u.id)}" placeholder="New PIN (4+ characters)" autocomplete="off" style="width:170px"><button class="btn small" data-setpin="${esc(u.id)}">Set PIN</button></div></td>
      <td>${state.confirmDelete==="unit:"+u.id ? `<span class="confirm">Remove unit? Past plans stay saved. <button class="btn danger" data-unit-del-yes="${esc(u.id)}">Remove</button><button class="btn" data-del-no>Cancel</button></span>` : `<button class="btn ghost danger" data-unit-del="${esc(u.id)}">Remove</button>`}</td></tr>`).join("");
    return `<div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h2>Reporting units and PINs</h2><span class="muted small">Approvers only. A unit can update its plan only with its PIN. PINs are stored scrambled: if one is forgotten, set a new one and tell the unit.</span></div>
      <div class="scroll"><table><thead><tr><th>Name</th><th>Type</th><th>PIN</th><th>Change PIN</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="save-bar"><div class="toolbar"><input type="text" id="newUnitName" placeholder="New unit name"><select id="newUnitType"><option>Corporate function</option><option>Business unit</option></select><button class="btn primary" id="addUnit">Add unit</button></div></div>
    </div>
    <div class="grid2 even">
      <div class="panel"><div class="panel-head"><h2>Backup and restore</h2></div>
        <div class="asks"><p class="small">Every change to a plan already keeps a copy (see <b>History</b> on each plan). For a full copy you can keep offline, download a backup file every week and store it on the shared drive.</p>
        <div class="toolbar" style="margin:10px 0"><button class="btn primary" id="backupBtn">Download full backup (JSON)</button></div>
        <p class="small"><b>Restore from a backup file</b> puts back every unit and plan in the file. Plans that change are kept in History first, so this can be undone.</p>
        <div class="toolbar"><input type="file" id="restoreFile" accept=".json,application/json"></div>
        ${state.restore ? `<div class="banner warn" style="margin:10px 0 0">${esc(state.restore.name)}: ${state.restore.units} units, ${state.restore.plans} plans, saved ${esc(state.restore.at || "?")}. <button class="btn danger" id="restoreGo" style="margin-left:6px">Restore now</button> <button class="btn" id="restoreCancel">Cancel</button></div>` : ""}</div></div>
      <div class="panel"><div class="panel-head"><h2>Approver code</h2></div>
        <div class="asks"><p class="small">Approvers are people whose name starts with or contains: ${state.approverNames.map(n => `<span class="tag">${esc(n)}</span>`).join(" ")}, and who enter this code. Change the list in Supabase (table <code>app_config</code>, key <code>approver_names</code>).</p>
        <div class="toolbar"><input type="password" id="newCode" placeholder="New approver code (6+ characters)" autocomplete="new-password"><button class="btn" id="codeBtn">Change code</button></div></div></div>
    </div>`;
  }
  async function loadPinStatus(){ if (!isAppr()) return; try { const r = await api.pinStatus(auth()); if (!r.error) { state.pinStatus = r.units || {}; if (state.tab === "units") render(); } } catch (e) {} }
  async function downloadBackup(){
    try {
      const [units, plans, activity, requests] = await Promise.all(["units", "plans", "activity", "change_requests"].map(t => api.readAll(t)));
      const conv = api.mode === "supabase";
      const b = { app: "WBG Weekly Activity Tracking", version: 2, savedAt: new Date().toISOString(), savedBy: myId,
        units: conv ? units.map(u => ({ id: u.id, name: u.name, type: u.type, order: u.sort_order, departments: u.departments, people: u.people })) : units,
        plans: conv ? plans.map(planFromRow) : plans, activity, requests };
      await save(`WBG tracker backup ${todayIso}.json`, JSON.stringify(b, null, 1), `Backup saved: ${b.units.length} units, ${b.plans.length} plans`);
    } catch (e) { toast("Could not make the backup: " + errText(e)); }
  }
  async function readRestore(file){
    try { const b = JSON.parse(await file.text()); if (!Array.isArray(b.units) || !Array.isArray(b.plans)) throw 0; state.restore = { name: file.name, data: b, units: b.units.length, plans: b.plans.length, at: (b.savedAt || "").slice(0, 16).replace("T", " ") }; }
    catch (e) { state.restore = null; toast("That is not a tracker backup file"); }
    render();
  }

  // Names are stored as typed (no account ids), so person placeholders are filled straight from the attribute.
  function fillPeople(){
    document.querySelectorAll("[data-person]").forEach(e => { const n = e.dataset.person; if (!n) return; e.textContent = /^u_[A-Za-z0-9]{22}$/.test(n) ? "Earlier user" : (e.hasAttribute("data-bare") ? n : `by ${n}`); });
  }

  function render(){
    renderHero();
    const main = $("#main");
    const active = document.activeElement && document.activeElement.id;
    let html = bannerMsg ? `<div class="banner warn">${esc(bannerMsg)}</div>` : "";
    if (!db) html += `<div class="banner warn">Not connected to the database, so plans cannot be loaded or saved.</div>`;
    if (!state.unitsLoaded || !state.plansLoaded) html += `<div class="panel"><div class="empty"><b>Loading weekly plans…</b>Fetching plans for ${esc(weekLabel(state.week))}.</div></div>`;
    else if (state.tab==="dashboard") html += renderDash() + renderOverview(true) + renderOvTasks();
        else if (state.tab==="update") html += planBanner() + renderUpdate();
    else if (state.tab==="plan") html += planBanner() + renderUpdate() + renderImport();
    else if (state.tab==="tasks") html += renderTasks();
    else if (state.tab==="follow") html += renderFollow();
    else if (state.tab==="monthly") html += renderMonthly();
    else if (state.tab==="support") html += X.renderSupport();
    else if (state.tab==="fb") html += X.renderFb();
    else if (state.tab==="activity") html += renderActivity();
    else if (state.tab==="approvals") html += renderApprovals();
    else if (state.tab==="units" && isAppr()) html += renderUnits();
    else if (state.tab==="units") html += `<div class="panel"><div class="empty"><b>Group Strategy approvers only</b>Sign in with an approver name and the approver code to manage units and PINs.</div></div>`;
    main.innerHTML = html;
    growAll();
    if (active) { const el = document.getElementById(active); if (el && el.focus) { el.focus(); if (el.setSelectionRange && el.type==="text") { const n = el.value.length; try { el.setSelectionRange(n,n); } catch(e){} } } }
    fillPeople(); fetchCarry(); fetchNext();
    if (state.tab === "dashboard") ensureDash();
  }
  function growAll(){ document.querySelectorAll("#main textarea.grow").forEach(grow); }
  function grow(el){ el.style.height = "auto"; el.style.height = Math.max(el.classList.contains("out-in") ? 50 : 62, el.scrollHeight + 2) + "px"; }
  // Next week's plans, for the "next week's plan not entered" reminder
  function fetchNext(){
    if (!db || state.tab !== "update" || state.week !== thisMonday()) return;
    const key = nextMonday(); if (state.nextKey === key) return; state.nextKey = key;
    db.collection("plans").where("week", "==", key).get().then(snap => { const m = {}; snap.docs.forEach(d => { const v = d.data(); if (v && v.unit) m[v.unit] = v; }); state.nextPlans = m; render(); }).catch(() => {});
  }

  // ---------- executive dashboard ----------
  function dashWeeks(){ const n = state.dash.range, out = []; for (let i = n - 1; i >= 0; i--) out.push(i ? (() => { let x = state.week; for (let k = 0; k < i; k++) x = prevWeekOf(x); return x; })() : state.week); return out; }
  async function ensureDash(){
    if (!db) return;
    const weeks = dashWeeks(), key = `${state.week}|${state.dash.range}`;
    if (state.dashKey === key) return; state.dashKey = key; state.dashData = null;
    try {
      const snap = await db.collection("plans").where("week", ">=", weeks[0]).where("week", "<=", state.week).get();
      const by = {}; snap.docs.forEach(d => { const v = d.data(); if (v && v.unit) (by[v.week] = by[v.week] || {})[v.unit] = v; });
      if (state.dashKey === key) { state.dashData = { weeks, by }; if (state.tab === "dashboard") render(); }
    } catch (e) { state.dashKey = ""; banner("Could not load the earlier weeks for the dashboard."); }
  }
  function renderDash(){
    if (!state.units.length) return `<div class="panel"><div class="empty"><b>No units set up yet</b></div></div>`;
    if (!state.dashData) return `<div class="panel"><div class="empty"><b>Collecting the last ${state.dash.range} weeks…</b></div></div>`;
    const by = { ...state.dashData.by, [state.week]: state.plans };
    const alerts = sortedUnits().flatMap(u => unitAlerts({ unit: u, plan: state.plans[u.id], weekPlans: state.plans, week: state.week, thisMonday: thisMonday(), today: todayIso, requests: [] })).sort((a, b) => levelRank[a.level] - levelRank[b.level]);
    const w = ($("#main").clientWidth || 1000);
    return renderDashboard({ weeks: state.dashData.weeks, byWeek: by, units: sortedUnits(), week: state.week, today: todayIso, filter: state.dash,
      alerts: alerts.filter(a => !state.dash.type || unitOf(a.unit).type === state.dash.type), pending: pendingFor().length, downloads,
      width: w > 900 ? Math.floor((w - 16) * 2 / 3) - 34 : w - 34, unitName, h: { esc, fmt, weekLabel } });
  }

  // ---------- events ----------
  function setWeek(w){
    if (state.dirty) { toast("Save or discard your changes first"); return; }
    state.week = w; state.draft = null; state.allDrafts = null; subscribePlans();
  }
  const monthTab = () => state.tab === "monthly";
  $("#prevWeek").onclick = () => monthTab() ? shiftMonth(-1) : setWeek(prevWeekOf(state.week));
  $("#nextWeek").onclick = () => monthTab() ? shiftMonth(1) : setWeek(nextWeekOf(state.week));
  $("#thisWeek").onclick = () => { if (monthTab()) { state.eth = toEth(todayIso); loadMonth(); } else setWeek(state.tab === "plan" ? nextMonday() : thisMonday()); };
  document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => { const to = b.dataset.tab; if (state.dirty && (to === "plan" || to === "update") && to !== state.tab) { const w = to === "plan" ? nextMonday() : thisMonday(); if (w !== state.week) { toast("Save or discard your changes first"); return; } }
    state.tab = to; state.confirmDelete = null;
    if (to === "plan" && state.week < nextMonday() && !state.dirty) { state.week = nextMonday(); state.draft = null; state.allDrafts = null; subscribePlans(); }
    else if (to === "update" && state.week > thisMonday() && !state.dirty) { state.week = thisMonday(); state.draft = null; state.allDrafts = null; subscribePlans(); }
    if ((state.tab==="update"||state.tab==="plan") && !hasDraft()) loadDraft(); if (state.tab==="activity") subscribeActivity(); if (state.tab==="units") loadPinStatus(); if (state.tab==="monthly" && db && !state.monthLoading && (!state.monthData || state.monthKey !== `${state.eth.y}-${state.eth.m}${state.monthBasis}`)) { render(); loadMonth(); return; } render(); });

  const main = $("#main");
  main.addEventListener("click", e => {
    const t = e.target.closest("button, tr[data-open-unit], tr[data-tgl], .hbar-row[data-open-unit]");
    if (!t) return;
    if (t.dataset.tgl) { const k = t.dataset.tgl; state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k); render(); return; }
    if (t.matches("tr[data-open-unit], .hbar-row[data-open-unit]") || (t.dataset.openUnit && t.matches("button"))) { openUnit(t.dataset.openUnit); return; }
    if (t.dataset.goto) { goTab(t.dataset.goto); return; }
    if (t.dataset.unlock) { state.unlock.add(t.dataset.unlock); render(); const el = document.getElementById("t-title-" + t.dataset.unlock); if (el) el.focus(); toast("Edit the task. Saving sends the change to Group Strategy for approval."); return; }
    if (t.dataset.withdraw) { api.withdrawRequest(auth(), t.dataset.withdraw).then(r => toast(r.error ? errText(r) : "Request withdrawn")).catch(x => toast(errText(x))); return; }
    if (t.dataset.approve) { decide(t.dataset.approve, true); return; }
    if (t.dataset.reject) { decide(t.dataset.reject, false); return; }
    if (t.dataset.ev) { openEvidence(t.dataset.ev); return; }
    if (t.dataset.evp) { api.evidenceUrl(t.dataset.evp, t.dataset.evn).then(url => { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; if (api.mode === "local") a.download = t.dataset.evn; document.body.appendChild(a); a.click(); a.remove(); }).catch(() => toast("Could not open the file")); return; }
    if (t.dataset.evDel) { const [u, i, k] = t.dataset.evDel.split("|"); const task = planFor(u).tasks[Number(i)]; task.ev = (task.ev || []).filter((_, j) => j !== Number(k)); state.dirtyUnits.add(u); state.dirty = true; render(); return; }
    if (t.dataset.setpin) { setPin(t.dataset.setpin); return; }
    if (t.id === "signInBtn") { showWho(); return; }
    if (t.id === "histBtn") { openHistory(); return; }
    if (t.id === "backupBtn") { downloadBackup(); return; }
    if (t.id === "restoreCancel") { state.restore = null; render(); return; }
    if (t.id === "restoreGo") { doRestore(); return; }
    if (t.id === "codeBtn") { changeCode(); return; }
    if (t.id==="addTask" || t.dataset.addUnit) { const u = t.dataset.addUnit || state.editUnit, d = planFor(u); const nt = { id: uid(), title:"", outcome:"", dept:"", owner:"", due:"", priority:"Medium", status:"Not started", pct:0, notes:"", kind:"Task", depUnit:"", dep:"", ev:[] }; d.tasks.push(nt); state.dirty = true; state.dirtyUnits.add(u); render(); const el = document.getElementById("t-title-"+nt.id); el && el.focus(); }
    else if (t.id==="listsBtn") { state.showLists = !state.showLists; render(); }
    else if (t.id==="listsCancel") { state.showLists = false; render(); }
    else if (t.id==="addDeptBtn") addDept();
    else if (t.id==="addPersonBtn") addPerson();
    else if (t.dataset.deptDel) { state.confirmDelete = "dept:" + t.dataset.deptDel; render(); }
    else if (t.dataset.deptYes) removeDept(t.dataset.deptYes);
    else if (t.dataset.personDel) { state.confirmDelete = "person:" + t.dataset.personDel; render(); }
    else if (t.dataset.personYes) removePerson(Number(t.dataset.personYes));
    else if (t.id==="tplBtn") downloadTemplate();
    else if (t.id==="impGo") commitImport();
    else if (t.id==="impConfirm") { state.imp.confirmed = true; state.imp.needConfirm = false; commitImport(); }
    else if (t.id==="impNoConfirm") { state.imp.needConfirm = false; render(); }
    else if (t.id==="impClear") { state.imp = null; render(); }
    else if (t.id==="actXlsx") exportActivityXlsx();
    else if (t.dataset.drill) drill(t.dataset.drill);
    else if (t.id==="goNext") setWeek(nextMonday());
    else if (t.id==="bfBtn2") openBf();
    else if (t.id==="ovHigh") { state.ov.priority = state.ov.priority==="High" && !state.ov.status ? "" : "High"; state.ov.status = ""; render(); }
    else if (t.id==="ovDone") { state.ov.status = state.ov.status==="Done" && !state.ov.priority ? "" : "Done"; state.ov.priority = ""; render(); }
    else if (t.id==="ovNS") { state.ov.status = state.ov.status==="Not started" && !state.ov.priority ? "" : "Not started"; state.ov.priority = ""; render(); }
    else if (t.id==="ovAll") { state.ov.all = true; render(); }
    else if (t.id==="ovOpen") { const o = state.ov; state.filter = { ...newFilter(), unit: o.unit, priority: o.priority==="none" ? "" : o.priority, status: o.status, q: o.q }; state.tab = "tasks"; render(); }
    else if (t.id==="backMonthly") { state.tab = "monthly"; render(); }
    else if (t.dataset.chip) { const k = t.dataset.chip, f = state.filter; if (k==="statuses") { f.statuses = []; f.status = ""; } else if (k==="period") f.period = "week"; else f[k] = ""; render(); }
    else if (t.id==="tglAll") {}
    else if (t.id==="mRefresh") loadMonth();
    else if (t.id==="mPdf") exportMonthPdf();
    else if (t.id==="mXlsx") exportMonthXlsx();
    else if (t.id==="saveBtn") saveDraft();
    else if (t.id==="discardBtn") { state.unlock = new Set(); loadDraft(); render(); toast("Changes discarded"); }
    else if (t.id==="carryBtn") openBf();
    else if (t.id==="reloadRemote") { loadDraft(); render(); }
    else if (t.dataset.del) { state.confirmDelete = t.dataset.del; render(); }
    else if (t.dataset.delYes !== undefined) { const [u, i] = t.dataset.delYes.split("|"); planFor(u).tasks.splice(Number(i),1); state.confirmDelete = null; state.dirty = true; state.dirtyUnits.add(u); render(); }
    else if (t.hasAttribute("data-del-no")) { state.confirmDelete = null; render(); }
    else if (t.id==="exportBtn") exportCsv();
    else if (t.id==="pdfBtn") exportPdf();
    else if (t.id==="xlsxAllBtn") exportXlsxAll();
    else if (t.id==="unitPdfBtn") exportUnitPdf();
    else if (t.id==="unitXlsxBtn") exportUnitXlsx();
    else if (t.id==="tasksPdfBtn") exportTasksPdf();
    else if (t.id==="tasksXlsxBtn") exportTasksXlsx();
    else if (t.dataset.copy) copyReminder(t.dataset.copy, t);
    else if (t.id==="addUnit") addUnit();
    else if (t.dataset.unitDel) { state.confirmDelete = "unit:"+t.dataset.unitDel; render(); }
    else if (t.dataset.unitDelYes) { const id = t.dataset.unitDelYes; state.confirmDelete = null; api.saveUnit(auth(), "remove", { id }, `Removed unit "${unitName(id)}"`).then(r => toast(r.error ? errText(r) : "Unit removed")).catch(x => toast(errText(x))); }
  });
  main.addEventListener("keydown", e => { const tr = e.target.closest("tr[data-open-unit]"); if (tr && (e.key==="Enter"||e.key===" ")) { e.preventDefault(); openUnit(tr.dataset.openUnit); } });
  main.addEventListener("input", e => {
    const el = e.target;
    if (el.dataset.f) {
      const tr = el.closest("tr"), u = tr.dataset.u, i = Number(tr.dataset.i), f = el.dataset.f, task = planFor(u).tasks[i];
      if (f==="dept" && el.value==="__new__") { el.value = task.dept || ""; if (isAll()) { toast("Open the unit on its own to add a department"); return; } state.showLists = true; render(); setTimeout(() => { const n = $("#newDept"); n && n.focus(); }); return; }
      state.dirtyUnits.add(u);
      if (el.classList.contains("grow")) grow(el);
      if (f==="pct") { const v = el.value==="" ? null : Math.max(0, Math.min(100, Number(el.value))); task.pct = v; if (v===100 && task.status!=="Done") { task.status = "Done"; statusSideEffects(task); markDirty(); render(); return; } }
      else { task[f] = el.value; if (f==="status") { statusSideEffects(task); markDirty(); render(); return; } }
      markDirty();
    } else if (el.dataset.r) { state.draft[el.dataset.r] = el.value; state.dirtyUnits.add(state.editUnit); markDirty(); }
    else if (el.id==="fQ") { state.filter.q = el.value; render(); }
    else if (el.id==="ovQ") { state.ov.q = el.value; render(); }
    else if (el.dataset.reqNote) { state.reqNotes[el.dataset.reqNote] = el.value; }
  });
  main.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("textarea.title-in, textarea.out-in")) e.preventDefault(); });
  main.addEventListener("toggle", e => { if (e.target.id === "remPanel") state.remOpen = e.target.open; }, true);
  // chart tooltips: any element with data-tip
  const tip = document.createElement("div"); tip.className = "viz-tip"; tip.hidden = true; document.body.appendChild(tip);
  main.addEventListener("mouseover", e => { const el = e.target.closest("[data-tip]"); if (!el) return; tip.innerHTML = el.dataset.tip; tip.hidden = false;
    const svg = el.closest("svg"); if (svg && el.dataset.x) { const xh = svg.querySelector(".xhair"); if (xh) { xh.setAttribute("x1", el.dataset.x); xh.setAttribute("x2", el.dataset.x); xh.style.display = ""; } } });
  main.addEventListener("mousemove", e => { if (tip.hidden) return; const w = tip.offsetWidth, h = tip.offsetHeight; let x = e.clientX + 14, y = e.clientY + 14; if (x + w > innerWidth - 8) x = e.clientX - w - 14; if (y + h > innerHeight - 8) y = e.clientY - h - 14; tip.style.left = x + "px"; tip.style.top = y + "px"; });
  main.addEventListener("mouseout", e => { const el = e.target.closest("[data-tip]"); if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return; tip.hidden = true; const xh = el.closest("svg")?.querySelector(".xhair"); if (xh) xh.style.display = "none"; });
  main.addEventListener("change", e => {
    const el = e.target;
    if (el.id==="unitPick") {
      if (state.dirty) { el.value = state.editUnit || ""; toast("Save or discard your changes first"); return; }
      openUnit(el.value, true);
    } else if (el.id==="fUnit") { state.filter.unit = el.value; state.filter.dept = ""; render(); }
    else if (el.id==="fDept") { state.filter.dept = el.value; render(); }
    else if (el.id==="fStatus") { if (el.value !== "__multi__") { state.filter.status = el.value; state.filter.statuses = []; } render(); }
    else if (el.id==="fGroup") { state.filter.group = el.checked; render(); }
    else if (el.id==="fPeriod") { state.filter.period = el.value; if (el.value==="month" && (!state.monthData || state.monthKey !== `${state.eth.y}-${state.eth.m}${state.monthBasis}`)) loadMonth(); else render(); }
    else if (el.id==="ovPri") { state.ov.priority = el.value; render(); }
    else if (el.id==="ovSt") { state.ov.status = el.value; render(); }
    else if (el.id==="ovUnit") { state.ov.unit = el.value; render(); }
    else if (el.id==="fPri") { state.filter.priority = el.value; render(); }
    else if (el.id==="fKind") { state.filter.kind = el.value; render(); }
    else if (el.id==="impUnit") { state.impUnit = el.value; state.impDefaultUnit = el.value ? unitName(el.value) : ""; render(); }
    else if (el.id==="impPrefill") { state.impPrefill = el.checked; }
    else if (el.id==="impFile") { if (el.files && el.files[0]) readImportFile(el.files[0]); }
    else if (el.id==="impMode") { state.imp.mode = el.value; state.imp.needConfirm = false; state.imp.confirmed = false; render(); }
    else if (el.id==="impDepts") { state.imp.newDepts = el.checked; }
    else if (el.id==="aUnit") { state.actFilter.unit = el.value; render(); }
    else if (el.id==="aWho") { state.actFilter.who = el.value; render(); }
    else if (el.id==="aAct") { state.actFilter.action = el.value; render(); }
    else if (el.id==="mBasis") { state.monthBasis = el.value; loadMonth(); }
    else if (el.id==="mDept") { state.monthByDept = el.checked; render(); }
    else if (el.dataset.unitName) { const v = el.value.trim(), id = el.dataset.unitName; if (v) api.saveUnit(auth(), "update", { id, name: v }, `Renamed unit to "${v}"`).then(r => toast(r.error ? errText(r) : "Unit renamed")); }
    else if (el.dataset.unitType) { const id = el.dataset.unitType; api.saveUnit(auth(), "update", { id, type: el.value }, `Unit type set to ${el.value}`).then(r => toast(r.error ? errText(r) : "Unit type updated")); }
    else if (el.dataset.evAdd) { if (el.files && el.files.length) addEvidence(el.dataset.evAdd, el.files); el.value = ""; }
    else if (el.id === "restoreFile") { if (el.files && el.files[0]) readRestore(el.files[0]); }
    else if (el.id === "dType") { state.dash.type = el.value; render(); }
    else if (el.id === "dRange") { state.dash.range = Number(el.value); render(); }
    else if (el.dataset.reqNote) { state.reqNotes[el.dataset.reqNote] = el.value; }
  });
  // Status drives the automatic fields: completion date, 100% on Done, and how long a task has been blocked.
  function statusSideEffects(t){
    if (t.status === "Done") { t.pct = 100; if (!t.completedAt) t.completedAt = todayIso; }
    else if (t.completedAt) t.completedAt = "";
    if (t.status === "Blocked") { if (!t.blockedSince) t.blockedSince = todayIso; } else if (t.blockedSince) t.blockedSince = "";
  }
  main.addEventListener("click", e => {
    const h = e.target.closest("th[data-sort]"); if (!h) return;
    const [scope, k] = h.dataset.sort.split(":"), cur = state.sort[scope] || {};
    state.sort[scope] = cur.k === k ? (cur.dir > 0 ? { k, dir: -1 } : { k: "", dir: 1 }) : { k, dir: 1 };
    render();
  });
  main.addEventListener("keydown", e => { const h = e.target.closest && e.target.closest("th[data-sort]"); if (h && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); h.click(); } });
  $("#bellBtn").onclick = () => goTab("approvals");
  function goTab(to){ const b = document.querySelector(`nav.tabs button[data-tab="${to}"]`); if (b) b.click(); }
  async function openEvidence(spec){
    const [u, i, k] = spec.split("|"), e = ((planFor(u) || {}).tasks || [])[Number(i)]?.ev?.[Number(k)];
    if (!e) return;
    try { const url = await api.evidenceUrl(e.path, e.name); const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; if (api.mode === "local") a.download = e.name; document.body.appendChild(a); a.click(); a.remove(); }
    catch (x) { toast("Could not open the file: " + (x.message || "not found")); }
  }
  async function addEvidence(spec, files){
    const [u, i] = spec.split("|"), task = planFor(u).tasks[Number(i)];
    if (!canEdit(u) || !task) return;
    files = [...files];
    if (files.length > EVIDENCE.maxFiles) { toast(`Attach up to ${EVIDENCE.maxFiles} files at once.`); return; }
    const total = files.reduce((a, f) => a + f.size, 0);
    if (total > EVIDENCE.maxTotal) { toast(`These files add up to ${fmtSize(total)}. The limit is ${fmtSize(EVIDENCE.maxTotal)} at once.`); return; }
    const bad = files.find(f => !fileType(f)); if (bad) { toast(`"${bad.name}" is not an allowed type. Use PDF, images, Word, Excel, PowerPoint, text or CSV.`); return; }
    toast(`Uploading ${files.length} file${files.length > 1 ? "s" : ""}…`);
    try {
      for (const f of files) {
        const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
        const path = `${state.week}/${u}/${task.id}/${uid()}-${safe}`;
        await api.uploadEvidence(f, path);
        (task.ev = task.ev || []).push({ id: uid(), name: f.name, size: f.size, type: fileType(f), path, by: myId || "", at: new Date().toISOString() });
      }
      state.dirtyUnits.add(u); state.dirty = true; render(); toast("Attached. Save the plan to keep the evidence with the task.");
    } catch (e) { render(); toast("Upload failed: " + (e.message || "check your connection")); }
  }
  async function setPin(u){
    const el = document.getElementById("pin-" + u), pin = (el && el.value || "").trim();
    if (pin.length < 4) { toast(ERR.pin_too_short); return; }
    try { const r = await api.setUnitPin(auth(), u, pin); if (r.error) { toast(errText(r)); return; } toast(`PIN set for ${unitName(u)}. Share it with the unit only.`); loadPinStatus(); }
    catch (e) { toast(errText(e)); }
  }
  async function changeCode(){
    const v = ($("#newCode").value || "").trim(); if (v.length < 6) { toast(ERR.code_too_short); return; }
    try { const r = await api.changeApproverCode(auth(), v); if (r.error) { toast(errText(r)); return; } const s = session.get(); session.set({ ...s, code: v }); toast("Approver code changed. Tell the other approver."); render(); }
    catch (e) { toast(errText(e)); }
  }
  async function doRestore(){
    const r = state.restore; if (!r) return;
    try { const res = await api.restoreBackup(auth(), r.data); toast(res.error ? errText(res) : `Restored ${res.units} units and ${res.plans} plans`); state.restore = null; state.dashKey = ""; render(); }
    catch (e) { toast(errText(e)); }
  }
  function markDirty(){
    if (!state.dirty) { state.dirty = true; const bar = document.querySelector(".save-bar span"); if (bar) bar.innerHTML = "<b style='color:var(--accent)'>Unsaved changes</b>"; ["saveBtn","discardBtn"].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = false; }); }
  }
  function openUnit(id, stay){
    if (state.dirty && id !== state.editUnit) { toast("Save or discard your changes first"); return; }
    state.editUnit = id || null; store.set("wp-unit", id || ""); state.showLists = false; state.impUnit = id && id !== ALL ? id : state.impUnit;
    loadDraft(); if (state.tab !== "plan") state.tab = "update"; render();
  }
  window.addEventListener("beforeunload", e => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });

  async function addUnit(){
    const name = $("#newUnitName").value.trim(); const type = $("#newUnitType").value;
    if (!name) { toast("Type a unit name first"); return; }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40) || uid();
    if (state.units.some(u => u.id===id)) { toast("A unit with that name already exists"); return; }
    const r = await api.saveUnit(auth(), "add", { id, name, type, order: state.units.length + 1 }, `Added unit "${name}"`);
    toast(r.error ? errText(r) : "Unit added. Set its PIN so it can update its plan."); if (!r.error) loadPinStatus();
  }

  async function exportCsv(){
    const cell = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
    const head = ["Week","Unit","Task","Department","Owner (name)","Due","Priority","Status","% complete","Notes","Expected outcome","Previous status","Completed on","Depends on (unit)","Dependency details","Evidence files"];
    const lines = [head.join(",")].concat(filteredTasks().map(t => [state.week, t.unitName, t.title, t.dept||"", t.owner, t.due, t.priority, t.status||"No status", t.pct ?? "", t.notes, t.outcome||"", t.prevStatus||"", t.completedAt||"", t.depUnit ? unitName(t.depUnit) : "", t.dep||"", (t.ev||[]).map(e => e.name).join("; ")].map(cell).join(",")));
    try { await downloads.save({ filename: `Wagwago weekly plans ${state.week}.csv`, data: "﻿" + lines.join("\n") }); toast("CSV saved"); }
    catch (e) { if (e && e.code !== "declined") toast("Could not export the file here"); }
  }


  // ---------- follow-up ----------
  function lateItems(){
    return sortedUnits().map(u => {
      const p = state.plans[u.id], t = realTasks(p);
      return {
        u, noPlan: !t.length,
        noStatus: t.filter(x => !x.status),
        overdue: t.filter(x => x.due && x.due < todayIso && x.status !== "Done"),
        blocked: t.filter(x => x.status === "Blocked"),
        stale: !!(p && p.updatedAt && (Date.now() - Date.parse(p.updatedAt)) > 3*864e5),
      };
    }).filter(r => r.noPlan || r.noStatus.length || r.overdue.length || r.blocked.length);
  }
  function followItems(){
    return sortedUnits().map(u => ({ u, alerts: alertsFor(u.id).filter(a => a.kind !== "pending").sort((a, b) => levelRank[a.level] - levelRank[b.level]) })).filter(r => r.alerts.length);
  }
  function reminderText(r){
    const lines = [`Dear ${r.u.name} team,`, "", `This is a follow-up from the Group Strategy Office on your weekly plan for ${weekLabel(state.week)}.`];
    r.alerts.forEach(a => {
      lines.push("", `- ${a.text}`);
      a.tasks.slice(0, 12).forEach(t => lines.push(`   • ${t.title}${t.fromUnit ? ` (${unitName(t.fromUnit)})` : ""}${t.due ? `, due ${fmt(t.due)}` : ""}${who(t) ? `, ${who(t)}` : ""}${typeof t.pct === "number" ? `, ${t.pct}%` : ""}`));
    });
    lines.push("", "Please update the tracker before the Friday review.", "", "Group Strategy Office");
    return lines.join("\n");
  }
  async function copyReminder(unitId, btn){
    const r = followItems().find(x => x.u.id === unitId); if (!r) return;
    const text = reminderText(r);
    try { await navigator.clipboard.writeText(text); toast("Reminder copied. Paste it into email or Telegram."); }
    catch (e) { const ta = document.getElementById("rem-"+unitId); if (ta) { ta.hidden = false; ta.select(); } toast("Select the text and copy it"); }
  }
  function renderFollow(){
    const items = followItems();
    if (!state.units.length) return `<div class="panel"><div class="empty"><b>No units set up yet</b></div></div>`;
    if (!items.length) return `<div class="panel"><div class="empty"><b>Nothing to follow up</b>Every unit has a plan with status, and no task is overdue or blocked for ${esc(weekLabel(state.week))}.</div></div>`;
    const pill = a => `<span class="pill ${a.level === "bad" ? "s-bad" : a.level === "warn" ? "s-not" : "s-none"}">${esc(a.text)}</span>`;
    const cards = items.map(r => {
      const list = []; const seen = new Set();
      r.alerts.filter(a => ["overdue","blocked_long","blocked","carried","waiting"].includes(a.kind)).forEach(a => a.tasks.forEach(t => { const k = (t.fromUnit || "") + t.id; if (!seen.has(k)) { seen.add(k); list.push({ t, a }); } }));
      return `<div class="panel" style="margin-bottom:12px">
      <div class="panel-head"><div><div class="unit-name">${esc(r.u.name)}</div><div class="follow-pills">${r.alerts.map(pill).join("")}</div></div>
        <button class="btn" data-copy="${esc(r.u.id)}">Copy reminder</button></div>
      ${list.length ? `<div class="scroll"><table><thead><tr><th>Task</th><th>Why</th><th>Department</th><th>Owner (name)</th><th>Due</th><th>Status</th><th>%</th></tr></thead><tbody>${list.slice(0, 25).map(({ t, a }) => `<tr><td title="${esc(t.title)}">${t.priority==="High"?'<span class="hi-dot"></span>':""}${esc(t.title)}${t.fromUnit ? `<div class="small muted">${esc(unitName(t.fromUnit))} is waiting${t.dep ? `: ${esc(t.dep)}` : ""}</div>` : ""}</td><td class="small">${esc(({ overdue: "Overdue", due_soon: "Due soon", blocked_long: "Blocked " + BLOCKED_DAYS + "+ days", blocked: "Blocked", carried: "Carried again", no_status: "No status", waiting: "Others waiting", dep_blocked: "Waiting on another unit" })[a.kind] || "")}</td><td class="small">${esc(t.dept || "")}</td><td class="small">${esc(t.owner)}</td><td class="num small" style="color:${t.due && t.due < todayIso ? "var(--bad)" : "inherit"}">${esc(fmt(t.due))}</td><td><span class="pill ${statusClass(t.status)}">${esc(t.status||"No status")}</span></td><td class="num small">${t.pct ?? "–"}</td></tr>`).join("")}</tbody></table></div>` : ""}
      <textarea id="rem-${esc(r.u.id)}" hidden readonly style="margin:0 16px 16px;width:calc(100% - 32px);min-height:140px">${esc(reminderText(r))}</textarea>
    </div>`; }).join("");
    return `<div class="banner info">Checked automatically for ${esc(weekLabel(state.week))}: missing plans, overdue and soon-due tasks, tasks blocked for ${BLOCKED_DAYS}+ days, work carried for 2+ weeks, and tasks other units are waiting on. Units also see their own reminders when they open their plan. To have these sent to Telegram automatically, see <b>supabase/upgrade-3-reminders.sql</b>. Copy a reminder to send it yourself.</div>${cards}`;
  }

  // ---------- PDF report ----------
  async function exportPdf(){
    if (!window.jspdf || !downloads) { toast("The report tool did not load. Reload the page and try again."); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const W = doc.internal.pageSize.getWidth(), M = 36;
    const teal = [138,100,0], hero = [245,197,24], amber = [181,86,11], ink = [42,34,8], muted = [107,95,58];
    doc.setFillColor(...hero); doc.rect(0,0,W,78,"F");
    doc.setTextColor(122,62,0); doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.text("WAGWAGO BUSINESS GROUP  ·  GROUP STRATEGY OFFICE", M, 26);
    doc.setTextColor(42,34,8); doc.setFontSize(20); doc.text(`Weekly Performance Report · ${weekLabel(state.week)}`, M, 52);
    doc.setFontSize(9); doc.setFont("helvetica","normal"); doc.setTextColor(92,74,16); doc.text(`Generated ${fmt(todayIso)} ${new Date().getFullYear()}`, M, 68);
    const rows = sortedUnits().map(u => ({ u, p: state.plans[u.id], s: summarize(state.plans[u.id]) }));
    const tot = rows.reduce((a,r) => ({ total:a.total+r.s.total, done:a.done+r.s.done, blocked:a.blocked+r.s.blocked, overdue:a.overdue+r.s.overdue, high:a.high+r.s.high, highDone:a.highDone+r.s.highDone }), { total:0, done:0, blocked:0, overdue:0, high:0, highDone:0 });
    const submitted = rows.filter(r => r.s.total).length;
    const kpis = [[`${submitted} of ${rows.length}`,"units submitted"],[String(tot.total),"tasks planned"],[`${tot.total?Math.round(tot.done/tot.total*100):0}%`,`tasks done (${tot.done})`],[`${tot.highDone} of ${tot.high}`,"High priority done"],[String(tot.blocked+tot.overdue),"blocked or overdue"]];
    const kw = (W - 2*M - 4*10)/5;
    kpis.forEach((k,i) => { const x = M + i*(kw+10); doc.setFillColor(253,240,194); doc.roundedRect(x, 92, kw, 50, 5, 5, "F"); doc.setTextColor(...(i>2?amber:teal)); doc.setFont("helvetica","bold"); doc.setFontSize(16); doc.text(k[0], x+10, 115); doc.setFont("helvetica","normal"); doc.setFontSize(8.5); doc.setTextColor(...ink); doc.text(k[1], x+10, 131); });
    doc.autoTable({
      startY: 158, margin: { left: M, right: M },
      head: [["Unit","Type","Plan","Tasks","Done","High","Blocked","Overdue","Avg. complete","Last update"]],
      body: rows.map(({u,p,s}) => [u.name, u.type||"", !s.total?"No plan":s.noStatus===s.total?"No status":"Submitted", s.total, s.done, s.high, s.blocked, s.overdue, s.avg===null?"–":s.avg+"%", p&&p.updatedAt?fmt(p.updatedAt.slice(0,10)):"–"]),
      styles: { fontSize: 8.5, cellPadding: 4, textColor: ink, lineColor: [236,227,196], lineWidth: 0.5 },
      headStyles: { fillColor: [245,197,24], textColor: [42,34,8], fontStyle: "bold" },
      alternateRowStyles: { fillColor: [253,249,236] },
      didParseCell: d => { if (d.section==="body" && d.column.index===2) { const v = d.cell.raw; d.cell.styles.textColor = v==="Submitted"?[29,127,85]:v==="No plan"?[182,58,38]:[154,106,0]; d.cell.styles.fontStyle = "bold"; } },
    });
    const late = lateItems().flatMap(r => [...r.overdue, ...r.blocked.filter(b => !r.overdue.includes(b))].map(t => [r.u.name, t.title, t.dept||"", t.owner||"", fmt(t.due), t.status||"No status", t.pct ?? "–"]));
    doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.setTextColor(...teal);
    let y = doc.lastAutoTable.finalY + 26; if (y > 520) { doc.addPage(); y = 50; }
    doc.text("Late and blocked tasks", M, y);
    doc.autoTable({ startY: y + 8, margin: { left: M, right: M },
      head: [["Unit","Task","Department","Owner (name)","Due","Status","%"]],
      body: late.length ? late : [["–","No overdue or blocked tasks this week","","","",""]],
      styles: { fontSize: 8.5, cellPadding: 4, textColor: ink, lineColor: [236,227,196], lineWidth: 0.5 },
      headStyles: { fillColor: [182,58,38], textColor: 255 }, columnStyles: { 1: { cellWidth: 260 } } });
    const noPlan = rows.filter(r => !r.s.total).map(r => r.u.name);
    const asks = rows.filter(r => r.p && (r.p.blockers || r.p.asks)).map(r => [r.u.name, r.p.blockers||"", r.p.asks||""]);
    y = doc.lastAutoTable.finalY + 26; if (y > 520) { doc.addPage(); y = 50; }
    doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.setTextColor(...teal); doc.text("Blockers and asks", M, y);
    doc.autoTable({ startY: y + 8, margin: { left: M, right: M }, head: [["Unit","Blockers","Asks"]],
      body: asks.length ? asks : [["–","None entered",""]],
      styles: { fontSize: 8.5, cellPadding: 4, textColor: ink, lineColor: [236,227,196], lineWidth: 0.5 }, headStyles: { fillColor: [245,197,24], textColor: [42,34,8] } });
    if (noPlan.length) { y = doc.lastAutoTable.finalY + 20; if (y > 540) { doc.addPage(); y = 50; } doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(182,58,38); doc.text("No plan submitted: " + noPlan.join(", "), M, y, { maxWidth: W - 2*M }); }
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(...muted); doc.text(`Group Strategy Office · Weekly Performance Report · Page ${i} of ${n}`, M, doc.internal.pageSize.getHeight() - 18); }
    try { await downloads.save({ filename: `Wagwago weekly performance ${state.week}.pdf`, data: doc.output("arraybuffer") }); toast("Report saved. Open it to print."); }
    catch (e) { if (e && e.code !== "declined") toast("Could not save the report here"); }
  }


  // ---------- more downloads ----------
  const Y = { band:[245,197,24], ink:[42,34,8], muted:[107,95,58], soft:[253,240,194], line:[236,227,196], zebra:[253,249,236], brown:[122,62,0] };
  const tableStyle = () => ({ styles: { fontSize: 8.5, cellPadding: 4, textColor: Y.ink, lineColor: Y.line, lineWidth: 0.5, overflow: "linebreak" }, headStyles: { fillColor: Y.band, textColor: Y.ink, fontStyle: "bold" }, alternateRowStyles: { fillColor: Y.zebra } });
  function newPdf(title, sub){
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const W = doc.internal.pageSize.getWidth();
    doc.setFillColor(...Y.band); doc.rect(0,0,W,74,"F");
    doc.setTextColor(...Y.brown); doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.text("WBG STRATEGY OFFICE  ·  WEEKLY ACTIVITY TRACKING", 36, 24);
    doc.setTextColor(...Y.ink); doc.setFontSize(19); doc.text(title, 36, 48);
    doc.setFont("helvetica","normal"); doc.setFontSize(9); doc.setTextColor(92,74,16); doc.text(sub, 36, 64);
    return doc;
  }
  function pdfFooter(doc, label){
    const n = doc.getNumberOfPages(), H = doc.internal.pageSize.getHeight();
    for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(...Y.muted); doc.text(`${label} · ${weekLabel(state.week)} · Page ${i} of ${n}`, 36, H - 18); }
  }
  function sectionTitle(doc, text, y){ if (y > 500) { doc.addPage(); y = 50; } doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.setTextColor(...Y.brown); doc.text(text, 36, y); return y + 8; }
  async function save(filename, data, okMsg){
    try { await downloads.save({ filename, data }); toast(okMsg); }
    catch (e) { if (e && e.code !== "declined") toast("Could not save the file here"); }
  }
  const libsReady = kind => { if (kind==="pdf" && !window.jspdf) { toast("The PDF tool did not load. Reload the page and try again."); return false; } if (kind==="xlsx" && !window.XLSX) { toast("The Excel tool did not load. Reload the page and try again."); return false; } return !!downloads; };
  const titleOut = t => (t.title || "") + (t.outcome ? `\nOutcome: ${t.outcome}` : "");
  const depText = t => [t.depUnit ? unitName(t.depUnit) : "", t.dep || ""].filter(Boolean).join(": ");
  const taskRow = (t,i) => [i+1, titleOut(t), t.dept||"", t.owner||"", fmt(t.due), t.priority||"", t.prevStatus||"", t.status||"No status", typeof t.pct==="number" ? t.pct+"%" : "", fmt(t.completedAt||""), [t.notes||"", depText(t) && "Depends on " + depText(t), (t.ev||[]).length ? `${t.ev.length} evidence file(s)` : ""].filter(Boolean).join("\n")];
  // PDF: every field of a task, in its own labelled column (landscape A4)
  const pdfHead = withUnit => [...(withUnit ? ["Unit"] : ["#"]), "Task / deliverable", "Expected outcome", "Department", "Owner (name)", "Due", "Priority", "Status (previous)", "%", "Completed", "Depends on", "Notes / next step · evidence"];
  const pdfTask = (t, i, unitName_) => [unitName_ !== undefined ? unitName_ : i + 1,
    (t.kind === "KPI / OKR" ? "[KPI / OKR] " : "") + (t.title || "") + (t.carried ? "\n(carried forward)" : ""),
    t.outcome || "", t.dept || "", t.owner || "", fmt(t.due), t.priority || "",
    (t.status || "No status") + (t.prevStatus ? `\n(was: ${t.prevStatus}${typeof t.prevPct === "number" ? " " + t.prevPct + "%" : ""})` : ""),
    typeof t.pct === "number" ? t.pct + "%" : "", fmt(t.completedAt || ""), depText(t),
    [t.notes || "", (t.ev || []).length ? "Evidence: " + t.ev.map(e => e.name).join(", ") : ""].filter(Boolean).join("\n")];
  const pdfStyle = () => { const b = tableStyle(); b.styles = { ...b.styles, fontSize: 7.5, cellPadding: 3 }; b.headStyles = { ...b.headStyles, fontSize: 7.5 }; return b; };
  const safeName = s => s.replace(/[\\/:*?"<>|]/g,"").slice(0,60);

  function currentPlan(){ return state.draft || state.plans[state.editUnit] || emptyPlan(state.editUnit); }

  async function exportUnitPdf(){
    if (!libsReady("pdf") || !state.editUnit) return;
    const p = currentPlan(), name = unitName(state.editUnit), s = summarize(p);
    const doc = newPdf(`${name} · Weekly Plan`, `Week of ${weekLabel(state.week)}${state.dirty ? "  ·  includes unsaved changes" : ""}`);
    const W = doc.internal.pageSize.getWidth();
    const kpis = [[String(s.total),"tasks"],[String(s.done),"done"],[s.avg===null?"–":s.avg+"%","average complete"],[`${s.highDone} of ${s.high}`,"High priority done"],[String(s.blocked + s.overdue),"blocked or overdue"]];
    const kw = (W - 72 - 40)/5;
    kpis.forEach((k,i) => { const x = 36 + i*(kw+10); doc.setFillColor(...Y.soft); doc.roundedRect(x, 88, kw, 46, 5, 5, "F"); doc.setTextColor(...Y.ink); doc.setFont("helvetica","bold"); doc.setFontSize(15); doc.text(k[0], x+10, 109); doc.setFont("helvetica","normal"); doc.setFontSize(8.5); doc.text(k[1], x+10, 125); });
    doc.autoTable({ startY: 148, margin: { left: 30, right: 30 }, head: [pdfHead(false)],
      body: (p.tasks||[]).length ? p.tasks.map((t,i) => pdfTask(t,i)) : [["","No tasks entered","","","","","","","","","",""]],
      columnStyles: { 0: { cellWidth: 18 }, 1: { cellWidth: 120, fontStyle: "bold" }, 2: { cellWidth: 94 }, 3: { cellWidth: 52 }, 4: { cellWidth: 54 }, 5: { cellWidth: 40 }, 6: { cellWidth: 36 }, 7: { cellWidth: 50 }, 8: { cellWidth: 26 }, 9: { cellWidth: 48 }, 10: { cellWidth: 62 } }, ...pdfStyle() });
    let y = doc.lastAutoTable.finalY + 24;
    y = sectionTitle(doc, "Key results, blockers and asks", y);
    doc.autoTable({ startY: y, margin: { left: 36, right: 36 }, head: [["Key results this week","Blockers and issues","Asks to top management or other units"]], body: [[p.wins||"–", p.blockers||"–", p.asks||"–"]], ...tableStyle() });
    y = doc.lastAutoTable.finalY + 40; if (y > 520) { doc.addPage(); y = 80; }
    doc.setDrawColor(...Y.muted); doc.setFontSize(9); doc.setTextColor(...Y.muted);
    [["Prepared by (unit head)",36],["Reviewed by (Group Strategy Office)",310],["Date",584]].forEach(([l,x]) => { doc.line(x, y, x+230, y); doc.text(l, x, y+12); });
    pdfFooter(doc, `${name} weekly plan`);
    await save(`${safeName(name)} weekly plan ${state.week}.pdf`, doc.output("arraybuffer"), "Plan saved. Open it to print.");
  }

  function sheetFromRows(rows, widths){ const ws = XLSX.utils.aoa_to_sheet(rows); ws["!cols"] = widths.map(w => ({ wch: w })); return ws; }
  const taskHead = ["#","Task / deliverable","Department","Owner (name)","Due","Priority","Status","% complete","Notes / next step","Type","Expected outcome","Previous status","Completed on","Depends on (unit)","Dependency details","Evidence files"];
  const taskWidths = [5,55,18,22,12,10,13,11,50,11,40,14,13,24,30,30];
  const xlsxTask = (t,i) => [i+1, t.title||"", t.dept||"", t.owner||"", t.due||"", t.priority||"", t.status||"No status", typeof t.pct==="number" ? t.pct/100 : "", t.notes||"", t.kind||"Task", t.outcome||"", t.prevStatus||"", t.completedAt||"", t.depUnit ? unitName(t.depUnit) : "", t.dep||"", (t.ev||[]).map(e => e.name).join(", ")];
  function pctFormat(ws, col, firstRow){ const r = XLSX.utils.decode_range(ws["!ref"]); for (let R = firstRow; R <= r.e.r; R++) { const c = ws[XLSX.utils.encode_cell({ r: R, c: col })]; if (c && typeof c.v === "number") c.z = "0%"; } }
  async function writeXlsx(wb, filename, msg){ const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" }); await save(filename, buf, msg); }

  async function exportUnitXlsx(){
    if (!libsReady("xlsx") || !state.editUnit) return;
    const p = currentPlan(), name = unitName(state.editUnit);
    const rows = [[`${name} · Weekly Plan`], [`Week of ${weekLabel(state.week)}`], [], taskHead, ...(p.tasks||[]).map(xlsxTask), [], ["Key results this week", p.wins||""], ["Blockers and issues", p.blockers||""], ["Asks", p.asks||""]];
    const ws = sheetFromRows(rows, taskWidths); pctFormat(ws, 7, 4);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Weekly plan");
    await writeXlsx(wb, `${safeName(name)} weekly plan ${state.week}.xlsx`, "Excel plan saved");
  }

  async function exportTasksPdf(){
    if (!libsReady("pdf")) return;
    const list = filteredTasks(), f = state.filter;
    const filt = [f.unit && unitName(f.unit), f.status && (f.status==="none"?"No status":f.status), f.priority, f.q && `"${f.q}"`].filter(Boolean).join(", ");
    const doc = newPdf("Weekly Tasks", `Week of ${weekLabel(state.week)}  ·  ${list.length} tasks${filt ? "  ·  Filter: " + filt : ""}`);
    doc.autoTable({ startY: 92, margin: { left: 30, right: 30 }, head: [pdfHead(true)],
      body: list.length ? list.map((t,i) => pdfTask(t, i, t.unitName)) : [["","No tasks match","","","","","","","","","",""]],
      columnStyles: { 0: { cellWidth: 62, fontStyle: "bold" }, 1: { cellWidth: 104, fontStyle: "bold" }, 2: { cellWidth: 90 }, 3: { cellWidth: 48 }, 4: { cellWidth: 50 }, 5: { cellWidth: 38 }, 6: { cellWidth: 34 }, 7: { cellWidth: 48 }, 8: { cellWidth: 24 }, 9: { cellWidth: 46 }, 10: { cellWidth: 56 } }, ...pdfStyle() });
    pdfFooter(doc, "Weekly tasks");
    await save(`Wagwago weekly tasks ${state.week}.pdf`, doc.output("arraybuffer"), "Task list saved. Open it to print.");
  }

  async function exportTasksXlsx(){
    if (!libsReady("xlsx")) return;
    const list = filteredTasks();
    const rows = [["Unit", ...taskHead.slice(1)], ...list.map((t,i) => [t.unitName, ...xlsxTask(t,i).slice(1)])];
    const ws = sheetFromRows(rows, [30, ...taskWidths.slice(1)]); pctFormat(ws, 7, 1);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Tasks");
    await writeXlsx(wb, `Wagwago weekly tasks ${state.week}.xlsx`, "Excel task list saved");
  }

  async function exportXlsxAll(){
    if (!libsReady("xlsx")) return;
    const wb = XLSX.utils.book_new();
    const units = sortedUnits();
    const sum = [["Wagwago Business Group · Weekly performance", ""], [`Week of ${weekLabel(state.week)}`], [],
      ["Unit","Type","Plan","Tasks","Done","High priority","High done","Blocked","Overdue","Average complete","Last update"],
      ...units.map(u => { const p = state.plans[u.id], s = summarize(p); return [u.name, u.type||"", !s.total?"No plan":s.noStatus===s.total?"No status":"Submitted", s.total, s.done, s.high, s.highDone, s.blocked, s.overdue, s.avg===null ? "" : s.avg/100, p && p.updatedAt ? p.updatedAt.slice(0,10) : ""]; })];
    const ws = sheetFromRows(sum, [34,18,12,8,8,13,11,9,9,16,13]); pctFormat(ws, 9, 4);
    XLSX.utils.book_append_sheet(wb, ws, "Summary");
    const all = allTasks();
    const wsAll = sheetFromRows([["Unit", ...taskHead.slice(1)], ...all.map((t,i) => [t.unitName, ...xlsxTask(t,i).slice(1)])], [30, ...taskWidths.slice(1)]); pctFormat(wsAll, 7, 1);
    XLSX.utils.book_append_sheet(wb, wsAll, "All tasks");
    const asks = units.filter(u => state.plans[u.id] && (state.plans[u.id].wins || state.plans[u.id].blockers || state.plans[u.id].asks)).map(u => { const p = state.plans[u.id]; return [u.name, p.wins||"", p.blockers||"", p.asks||""]; });
    XLSX.utils.book_append_sheet(wb, sheetFromRows([["Unit","Key results","Blockers","Asks"], ...asks], [30,50,50,50]), "Results, blockers, asks");
    const used = new Set();
    units.forEach(u => { const p = state.plans[u.id]; if (!p || !(p.tasks||[]).length) return; let n = u.name.replace(/[\\/?*\[\]:]/g,"").slice(0,31); while (used.has(n)) n = n.slice(0,29) + "_" + used.size; used.add(n);
      const w = sheetFromRows([taskHead, ...p.tasks.map(xlsxTask)], taskWidths); pctFormat(w, 7, 1); XLSX.utils.book_append_sheet(wb, w, n); });
    await writeXlsx(wb, `Wagwago weekly plans ${state.week}.xlsx`, "Excel workbook saved");
  }

  // ---------- template download and import ----------
  const TCOLS = ["Week starting","Unit","Department","Task / deliverable","Type","Owner","Due date","Priority","Status","% complete","Notes / next step","Expected outcome","Depends on (unit)","Dependency details"];
  const SCOLS = ["Week starting","Unit","Key results this week","Blockers and issues","Asks to top management or other units"];
  const TWIDTH = [14,32,22,60,11,24,12,10,13,11,50,40,26,34];
  function colKey(h){
    const k = String(h ?? "").toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim(); if (!k) return "";
    if (/outcome|expected result/.test(k)) return "outcome";
    if (/depend.*unit|depends on/.test(k)) return "depUnit";
    if (/dependenc/.test(k)) return "dep";
    if (/^prev|previous|completed on|completion date|evidence|updated by/.test(k)) return "";
    if (/^week/.test(k)) return "week";
    if (/dept|department/.test(k)) return "dept";
    if (/owner|responsible|assigned/.test(k)) return "owner";
    if (/due|deadline/.test(k)) return "due";
    if (/priorit/.test(k)) return "priority";
    if (/status/.test(k)) return "status";
    if (/complete|%|progress/.test(k)) return "pct";
    if (/note|remark|next step|comment/.test(k)) return "notes";
    if (/^(type|kind)/.test(k)) return "kind";
    if (/task|deliverable|activity|action/.test(k)) return "title";
    if (/unit|function|^bu\b|business/.test(k)) return "unit";
    return "";
  }
  function sumKey(h){
    const k = String(h ?? "").toLowerCase();
    if (/^week/.test(k)) return "week"; if (/unit|function|bu/.test(k)) return "unit";
    if (/key result|achiev|wins/.test(k)) return "wins"; if (/blocker|issue/.test(k)) return "blockers"; if (/ask/.test(k)) return "asks"; return "";
  }
  function toIso(v, yearHint){
    if (v === "" || v == null) return "";
    if (typeof v === "number") { if (v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 864e5)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`; } return null; }
    const s = String(v).trim(); let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    if ((m = s.match(/^(\d{1,2})[-\/ ]([A-Za-z]{3})[a-z]*[-\/ ,]*(\d{2,4})?$/))) { const mo = MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase()); if (mo >= 0) { const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : yearHint; return `${y}-${pad(mo+1)}-${pad(+m[1])}`; } }
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
    return null;
  }
  const STATUS_MAP = { "not started":"Not started", "in progress":"In progress", "done":"Done", "blocked":"Blocked", "delayed":"Delayed", "started":"In progress", "complete":"Done", "completed":"Done" };
  function matchUnit(v){
    const k = norm(v); if (!k) return null;
    let hit = state.units.find(u => norm(u.name) === k || norm(u.id) === k); if (hit) return hit;
    const part = state.units.filter(u => norm(u.name).includes(k) || k.includes(norm(u.name)));
    return part.length === 1 ? part[0] : null;
  }
  function parseRow(raw, map, ctx){
    const g = f => (map[f] != null ? raw[map[f]] : "");
    const r = { err: [], warn: [], row: {} };
    const title = String(g("title") ?? "").trim();
    const unitTxt = String(g("unit") ?? "").trim() || ctx.defaultUnit || "";
    if (!title && !unitTxt) return null;
    const unit = matchUnit(unitTxt);
    if (!title) r.err.push("No task title");
    if (!unitTxt) r.err.push("No unit"); else if (!unit) r.err.push(`Unit "${unitTxt}" not found`);
    r.unit = unit; r.unitTxt = unitTxt;
    const wv = g("week"); let week = state.week;
    if (wv !== "" && wv != null) { const w = toIso(wv, ctx.year); if (w) week = weekStartOf(w); else r.warn.push("Week not understood, used the selected week"); }
    r.week = week;
    const kindTxt = norm(g("kind")); const kind = /kpi|okr|indicator/.test(kindTxt) ? "KPI / OKR" : "Task";
    let status = ""; const extra = [];
    const st = String(g("status") ?? "").trim();
    if (st) { status = STATUS_MAP[st.toLowerCase()] || ""; if (!status) { status = "In progress"; extra.push("Status as submitted: " + st); r.warn.push(`Status "${st}" not recognised, set to In progress`); } }
    let pr = String(g("priority") ?? "").trim(); const priority = ["high","medium","low"].includes(pr.toLowerCase()) ? pr[0].toUpperCase() + pr.slice(1).toLowerCase() : "";
    if (pr && !priority) r.warn.push(`Priority "${pr}" not recognised, left blank`);
    let due = toIso(g("due"), ctx.year);
    if (due === null) { extra.push("Due as submitted: " + g("due")); r.warn.push(`Due date "${g("due")}" not understood, kept in notes`); due = ""; }
    let pct = null; const pv = g("pct");
    if (pv !== "" && pv != null) {
      let n = typeof pv === "number" ? pv : parseFloat(String(pv).replace("%", "").replace(",", "."));
      if (typeof pv === "number" && pv <= 1) n = pv * 100;
      if (!isFinite(n)) r.warn.push(`% complete "${pv}" not understood`); else pct = Math.max(0, Math.min(100, Math.round(n)));
    }
    if (status === "Done" && pct === null) pct = 100;
    if (pct === 100 && !status) status = "Done";
    const notes = [String(g("notes") ?? "").trim(), ...extra].filter(Boolean).join(" | ");
    const depTxt = String(g("depUnit") ?? "").trim(), depU = depTxt ? matchUnit(depTxt) : null;
    if (depTxt && !depU) r.warn.push(`Depends-on unit "${depTxt}" not found, kept in dependency details`);
    const dep = [String(g("dep") ?? "").trim(), depTxt && !depU ? depTxt : ""].filter(Boolean).join(" · ");
    r.row = { title, dept: String(g("dept") ?? "").trim(), owner: String(g("owner") ?? "").trim(), due, priority, status, pct, notes, kind, outcome: String(g("outcome") ?? "").trim(), depUnit: depU ? depU.id : "", dep };
    return r;
  }
  function findHeader(rows, keyFn, min){
    for (let i = 0; i < Math.min(rows.length, 15); i++) { const map = {}; rows[i].forEach((h, c) => { const k = keyFn(h); if (k && map[k] == null) map[k] = c; }); if (Object.keys(map).length >= min) return { i, map }; }
    return null;
  }
  async function readImportFile(file){
    if (!window.XLSX) { toast("The Excel tool did not load. Reload the page and try again."); return; }
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sn = wb.SheetNames.find(n => /weekly plan|plan/i.test(n)) || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: "" });
      const h = findHeader(rows, colKey, 3);
      if (!h || h.map.title == null) { state.imp = { error: "Could not find the task columns. Use the template from step 1 and keep its header row." }; render(); return; }
      const year = parse(state.week).getFullYear();
      const parsed = [];
      for (let i = h.i + 1; i < rows.length; i++) { const p = parseRow(rows[i], h.map, { year, defaultUnit: state.impDefaultUnit }); if (p) { p.line = i + 1; parsed.push(p); } }
      const sums = []; const ss = wb.SheetNames.find(n => /summary/i.test(n));
      if (ss) { const sr = XLSX.utils.sheet_to_json(wb.Sheets[ss], { header: 1, raw: true, defval: "" }); const sh = findHeader(sr, sumKey, 2);
        if (sh) for (let i = sh.i + 1; i < sr.length; i++) { const row = sr[i]; const u = matchUnit(row[sh.map.unit]); const txt = f => String(sh.map[f] != null ? row[sh.map[f]] ?? "" : "").trim(); if (!u || !(txt("wins") || txt("blockers") || txt("asks"))) continue;
          const wv = sh.map.week != null ? toIso(row[sh.map.week], year) : ""; sums.push({ unit: u, week: wv ? weekStartOf(wv) : state.week, wins: txt("wins"), blockers: txt("blockers"), asks: txt("asks") }); } }
      state.imp = { fileName: file.name, rows: parsed, sums, mode: state.imp && state.imp.mode || "merge", newDepts: true };
      if (!parsed.length && !sums.length) state.imp.error = "The file has no task rows."; else setTimeout(computeImpact, 0);
    } catch (e) { state.imp = { error: "Could not read this file. Save it as .xlsx or .csv and try again." }; }
    render();
  }
  function templateRows(unitId, prefill){
    const units = unitId ? state.units.filter(u => u.id === unitId) : sortedUnits(); const out = [];
    if (prefill) units.forEach(u => (state.plans[u.id]?.tasks || []).forEach(t => out.push([state.week, u.name, t.dept || "", t.title || "", t.kind || "Task", t.owner || "", t.due || "", t.priority || "", t.status || "", typeof t.pct === "number" ? t.pct / 100 : "", t.notes || "", t.outcome || "", t.depUnit ? unitName(t.depUnit) : "", t.dep || ""])));
    else if (unitId) for (let i = 0; i < 15; i++) out.push([state.week, units[0].name, "", "", "Task", "", "", "", "", "", "", "", "", ""]);
    return out;
  }
  async function downloadTemplate(){
    if (!libsReady("xlsx")) return;
    const unitId = state.impUnit || "", prefill = !!state.impPrefill;
    const wb = XLSX.utils.book_new();
    const rows = templateRows(unitId, prefill);
    const ws = sheetFromRows([TCOLS, ...rows], TWIDTH); pctFormat(ws, 9, 1);
    XLSX.utils.book_append_sheet(wb, ws, "Weekly plan");
    const su = (unitId ? state.units.filter(u => u.id === unitId) : sortedUnits()).map(u => { const p = state.plans[u.id]; return [state.week, u.name, (p && p.wins) || "", (p && p.blockers) || "", (p && p.asks) || ""]; });
    XLSX.utils.book_append_sheet(wb, sheetFromRows([SCOLS, ...su], [14,32,50,50,50]), "Summary");
    const ins = [["How to fill in this template"], [],
      ["1","One row per task. Fill the 'Weekly plan' sheet. Keep the header row exactly as it is."],
      ["2","Unit: the exact name of your function or business unit (see the list below)."],
      ["3","Department: a department inside your unit. A new name is added to the unit automatically on import."],
      ["4","Week starting: any date inside the week (for example 2026-10-05). Leave blank to use the week selected on the page."],
      ["5","Type: Task, or KPI / OKR for indicator lines."],
      ["6","Due date: write it as 2026-10-09 or 9-Oct-2026. Text such as 'Q1' is kept in the notes instead."],
      ["7","Priority: High, Medium or Low."],
      ["8","Status: Not started, In progress, Done, Blocked or Delayed."],
      ["9","% complete: 0 to 100 (50 or 50%). Done with no % counts as 100%."],
      ["10","'Summary' sheet (optional): key results, blockers and asks for the week, one row per unit."],
      ["11","On import, rows with the same task title as an existing task update it. New titles are added."],
      ["12","Expected outcome: what will exist or change when the task is done. Depends on (unit): the unit you need something from; Dependency details: what you need."],
      ["13","Once a week has started, saved tasks keep their title, outcome, type, department, due date and priority. Changes to those, and anything for a past week, are sent to Group Strategy for approval."], [],
      ["Units and their departments"], ["Unit","Type","Departments"],
      ...sortedUnits().map(u => [u.name, u.type || "", (u.departments || []).join(", ")])];
    XLSX.utils.book_append_sheet(wb, sheetFromRows(ins, [28,40,80]), "Instructions");
    const nm = unitId ? safeName(unitName(unitId)) : "all units";
    await writeXlsx(wb, `Weekly plan template ${nm} ${state.week}.xlsx`, "Template saved");
  }
  async function commitImport(){
    if (state.imp && state.imp.mode === "replace" && !state.imp.confirmed) { state.imp.needConfirm = true; render(); return; }
    const imp = state.imp; if (!imp || !db) return;
    if (state.dirty) { toast("Save or discard your open changes first"); return; }
    const good = imp.rows.filter(r => !r.err.length);
    const groups = new Map();
    const grp = (w, u) => { const k = `${w}|${u.id}`; if (!groups.has(k)) groups.set(k, { week: w, unit: u, rows: [], sum: null }); return groups.get(k); };
    good.forEach(r => grp(r.week, r.unit).rows.push(r)); imp.sums.forEach(s => { grp(s.week, s.unit).sum = s; });
    state.importing = true; render();
    let nTasks = 0, nGroups = 0, nReq = 0; const skipped = [];
    try {
      for (const g of groups.values()) {
        if (!canEdit(g.unit.id)) { skipped.push(g.unit.name); continue; }
        const snap = await db.doc(`plans/${planId(g.week, g.unit.id)}`).get();
        const latest = snap.exists ? snap.data() : null;
        const plan = latest ? clone(latest) : { week: g.week, unit: g.unit.id, tasks: [], wins: "", blockers: "", asks: "" };
        if (imp.mode === "replace" && g.rows.length) plan.tasks = [];
        plan.tasks = plan.tasks || [];
        g.rows.forEach(r => {
          const key = norm(r.row.title); const ex = plan.tasks.find(t => norm(t.title) === key);
          if (ex) { FIELDS.forEach(f => { const v = r.row[f]; if (v !== "" && v !== null && v !== undefined) ex[f] = v; }); if (r.row.status) statusSideEffects(ex); }
          else { const nt = { id: uid(), title: r.row.title, outcome: r.row.outcome, dept: r.row.dept, owner: r.row.owner, due: r.row.due, priority: r.row.priority, status: r.row.status, pct: r.row.pct, notes: r.row.notes, kind: r.row.kind, depUnit: r.row.depUnit, dep: r.row.dep, ev: [] }; if (nt.status) statusSideEffects(nt); if (r.row.pct !== null && r.row.pct !== undefined) nt.pct = r.row.pct; plan.tasks.push(nt); }
        });
        if (g.sum) { ["wins","blockers","asks"].forEach(f => { if (g.sum[f]) plan[f] = g.sum[f]; }); }
        const res = await persistPlan(g.unit.id, g.week, latest, plan, { latest, source: "Import: " + imp.fileName, action: "import", prefix: `Imported ${imp.fileName}: ` });
        if (res.error) throw Object.assign(new Error(res.error), { code: res.error });
        if (res.nothing) continue;
        if (res.saved) { nTasks += g.rows.length; nGroups++; } nReq += res.requested || 0;
        if (imp.newDepts) {
          const have = g.unit.departments || []; const add = [...new Set(g.rows.map(r => r.row.dept).filter(d => d && !have.some(h => h.toLowerCase() === d.toLowerCase())))];
          if (add.length) await api.saveUnit(auth(), "lists", { id: g.unit.id, departments: [...have, ...add] }, "Added departments from import: " + add.join(", "));
        }
      }
      toast([nGroups ? `Imported ${nTasks} rows into ${nGroups} plan${nGroups > 1 ? "s" : ""}` : "", nReq ? `${nReq} change${nReq > 1 ? "s" : ""} sent for approval` : "", skipped.length ? `Skipped (no PIN for): ${[...new Set(skipped)].join(", ")}` : ""].filter(Boolean).join(" · ") || "Nothing changed. The file matches what is saved.");
      state.imp = null;
    } catch (e) { toast(e && e.code === "conflict" ? ERR.conflict : "Import stopped part-way: " + errText(e) + " Check the plans and run it again."); }
    state.importing = false; loadDraft(); render();
  }
  function renderImport(){
    const imp = state.imp;
    const unitOpts = `<option value="">All units</option>` + sortedUnits().map(u => `<option value="${esc(u.id)}" ${state.impUnit === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("");
    let prev = "";
    if (imp && imp.error) prev = `<div class="banner warn" style="margin:16px">${esc(imp.error)}</div>`;
    else if (imp) {
      const ok = imp.rows.filter(r => !r.err.length), bad = imp.rows.length - ok.length, warn = ok.filter(r => r.warn.length).length;
      const gs = new Map(); ok.forEach(r => { const k = `${r.week}|${r.unit.id}`; gs.set(k, (gs.get(k) || 0) + 1); });
      const newD = new Set(); ok.forEach(r => { if (r.row.dept && !(r.unit.departments || []).some(d => d.toLowerCase() === r.row.dept.toLowerCase())) newD.add(`${r.unit.name}: ${r.row.dept}`); });
      const shown = imp.rows.slice(0, 150).map(r => `<tr class="${r.err.length ? "row-err" : r.warn.length ? "row-warn" : ""}"><td class="num small">${r.line}</td><td class="small">${esc(r.unit ? r.unit.name : r.unitTxt)}</td><td class="small num">${esc(fmt(r.week))}</td><td>${esc(r.row.title)}</td><td class="small">${esc(r.row.dept)}</td><td class="small">${esc(r.row.owner)}</td><td class="small num">${esc(fmt(r.row.due))}</td><td class="small">${esc(r.row.priority)}</td><td class="small">${esc(r.row.status)}</td><td class="small num">${r.row.pct ?? ""}</td><td class="small">${esc([...r.err, ...r.warn].join("; "))}</td></tr>`).join("");
      prev = `<div style="padding:16px;display:grid;gap:12px">
        <div class="toolbar"><span class="pill s-done">${ok.length} ready</span>${warn ? `<span class="pill s-not">${warn} with notices</span>` : ""}${bad ? `<span class="pill s-bad">${bad} will be skipped</span>` : ""}${imp.sums.length ? `<span class="pill s-prog">${imp.sums.length} summary row${imp.sums.length > 1 ? "s" : ""}</span>` : ""}<span class="muted small">${esc(imp.fileName)} · goes to ${gs.size} plan${gs.size === 1 ? "" : "s"}</span></div>
        ${newD.size ? `<div class="banner info" style="margin:0">New departments found: ${[...newD].map(esc).join(", ")}</div>` : ""}
        ${imp.impact ? `<div class="banner info" style="margin:0"><b>What this import will do:</b> ${imp.mode === "replace" ? `remove the ${imp.impact.rem} task${imp.impact.rem === 1 ? "" : "s"} now saved in these plan weeks and save the ${imp.impact.n} from the file.` : `update ${imp.impact.upd} existing task${imp.impact.upd === 1 ? "" : "s"} (blank cells in the file never erase saved values), add ${imp.impact.add} new, and leave ${imp.impact.keep} saved task${imp.impact.keep === 1 ? "" : "s"} untouched. Nothing is deleted.`}</div>` : ""}
        ${imp.needConfirm ? `<div class="banner warn" style="margin:0"><b>Replace will delete ${imp.impact ? imp.impact.rem : "the"} saved task(s) in these plan weeks.</b> The replaced versions are kept in History. <button class="btn danger" id="impConfirm" style="margin-left:6px">Yes, replace</button> <button class="btn" id="impNoConfirm">Cancel</button></div>` : ""}
        <div class="toolbar"><label class="small" for="impMode">If a task title already exists</label>
          <select id="impMode"><option value="merge" ${imp.mode === "merge" ? "selected" : ""}>Update it and add new ones</option><option value="replace" ${imp.mode === "replace" ? "selected" : ""}>Replace the unit's whole plan for that week</option></select>
          <label class="small"><input type="checkbox" id="impDepts" ${imp.newDepts ? "checked" : ""}> Add new departments to the unit</label></div>
        <div class="scroll" style="max-height:420px;overflow:auto"><table><thead><tr><th>Row</th><th>Unit</th><th>Week</th><th>Task</th><th>Department</th><th>Owner</th><th>Due</th><th>Priority</th><th>Status</th><th>%</th><th>Notice</th></tr></thead><tbody>${shown}</tbody></table></div>
        ${imp.rows.length > 150 ? `<div class="small muted">Showing the first 150 of ${imp.rows.length} rows. All ready rows are imported.</div>` : ""}
        <div class="toolbar"><button class="btn primary" id="impGo" ${(!ok.length && !imp.sums.length) || state.importing ? "disabled" : ""}>${state.importing ? "Importing…" : `Import ${ok.length} row${ok.length === 1 ? "" : "s"}`}</button><button class="btn" id="impClear">Cancel</button></div></div>`;
    }
    return `<div class="grid2" style="grid-template-columns:minmax(0,1fr);gap:16px">
      <div class="panel"><div class="panel-head"><h2>1 · Download the template</h2><span class="muted small">Week: ${esc(weekLabel(state.week))}</span></div>
        <div class="reports"><div><label for="impUnit">Unit</label><select id="impUnit" style="width:100%">${unitOpts}</select></div>
          <div><label for="impPrefill">Starting rows</label><label class="small" style="font-weight:500"><input type="checkbox" id="impPrefill" ${state.impPrefill ? "checked" : ""}> Include the tasks already saved for this week</label></div>
          <div style="display:flex;align-items:flex-end"><button class="btn primary" id="tplBtn" ${downloads ? "" : "disabled"}>Download template (Excel)</button></div></div>
        <div class="small muted" style="padding:0 16px 14px">Next week: move to the new week with the arrows above, then download. Pick one unit to get 15 empty rows already carrying its name and week, or tick the box to start from the current tasks and update their status.</div></div>
      <div class="panel"><div class="panel-head"><h2>2 · Import the filled file</h2></div>
        <div class="reports"><div><label for="impFile">Excel or CSV file</label><input type="file" id="impFile" accept=".xlsx,.xls,.csv" style="width:100%"></div>
          <div class="small muted" style="align-self:end">Rows with a Week starting date go to that week, so one file can carry last week's report and next week's plan. Nothing is saved until you press Import.</div></div>
        ${prev}</div></div>`;
  }

  function drill(spec){
    const [uId, kind] = spec.split("|"), f = newFilter(); f.period = "month"; f.from = "monthly"; f.unit = uId; f.group = true;
    const map = { done: ["Done"], prog: ["In progress"], ns: ["Not started", ""], blk: ["Blocked", "Delayed"] };
    if (map[kind]) f.statuses = map[kind];
    if (kind === "high") { f.priority = "High"; }
    state.filter = f; state.tab = "tasks"; state.expanded = new Set(); render();
  }

  // ---------- who is using the app: name + unit PIN, or approver code ----------
  async function checkRights(silent){
    const a = auth();
    if (!api || (!a.pin && !a.code)) { rights = { unitOk: false, approver: false }; return rights; }
    try { const r = await api.login(a); rights = { unitOk: !!r.unitOk, approver: !!r.approver }; if (!silent && r.lockedOut) toast("Too many wrong tries. Wait 15 minutes and try again."); }
    catch (e) { /* offline: keep what we had */ }
    return rights;
  }
  function showWho(){
    const root = $("#whoRoot"), s = session.get();
    const unitOpts = sortedUnits().map(u => `<option value="${esc(u.id)}" ${u.id === s.unit ? "selected" : ""}>${esc(u.name)}</option>`).join("");
    root.innerHTML = `<div class="overlay"><form class="modal" id="whoForm" style="max-width:460px" aria-labelledby="whoTitle">
      <div class="panel-head"><h2 id="whoTitle">Sign in to update</h2>${s.name ? '<button type="button" class="icon-btn" id="whoX" aria-label="Close">×</button>' : ""}</div>
      <div class="small muted" style="padding:10px 16px 0">Anyone can view. To change a plan you need your unit's PIN from Group Strategy. Your name is saved with every change.</div>
      <div class="field"><label for="whoName">Your name</label><input type="text" id="whoName" value="${esc(s.name || "")}" maxlength="60" autocomplete="name" required></div>
      <div class="field"><label for="whoUnit">Your unit</label><select id="whoUnit"><option value="">Choose your unit (or view only)</option>${unitOpts}</select></div>
      <div class="field"><label for="whoPin">Unit PIN</label><input type="password" id="whoPin" autocomplete="off" inputmode="text" value="${esc(s.pin || "")}"></div>
      <div class="field" id="apprField" ${isApproverName(s.name, state.approverNames) ? "" : "hidden"}><label for="whoCode">Group Strategy approver code</label><input type="password" id="whoCode" autocomplete="off" value="${esc(s.code || "")}"><span class="small muted">Only for approving changes and managing units. Leave empty otherwise.</span></div>
      <div class="save-bar"><span class="small" id="whoErr" style="color:var(--bad)"></span><div class="toolbar">${s.pin || s.code ? '<button type="button" class="btn" id="whoOut">Sign out</button>' : ""}<button type="button" class="btn" id="whoView">View only</button><button class="btn primary" type="submit">Sign in</button></div></div></form></div>`;
    const input = $("#whoName"); input.focus(); input.select();
    input.oninput = () => { $("#apprField").hidden = !isApproverName(input.value, state.approverNames); };
    const close = () => { root.innerHTML = ""; render(); };
    const finish = async (name, unit, pin, code) => {
      session.set({ name, unit, pin, code }); myId = name;
      await checkRights(true);
      if (state.tab === "units" && !isAppr()) state.tab = "dashboard";
      if (rights.unitOk && !state.dirty && (!state.editUnit || state.editUnit === ALL)) { state.editUnit = unit; store.set("wp-unit", unit); }
      loadDraft(); close();
      toast(isAppr() ? `Signed in as ${name}, Group Strategy approver` : rights.unitOk ? `Signed in as ${name} for ${unitName(unit)}` : `Viewing as ${name}`);
      if (isAppr()) loadPinStatus();
    };
    $("#whoView").onclick = () => { const name = input.value.trim(); if (!name) { $("#whoErr").textContent = "Enter your name."; return; } finish(name, "", "", ""); };
    const out = $("#whoOut"); if (out) out.onclick = () => finish(input.value.trim() || s.name, "", "", "");
    const x = $("#whoX"); if (x) x.onclick = () => { root.innerHTML = ""; };
    $("#whoForm").onsubmit = async e => {
      e.preventDefault();
      const name = input.value.trim(), unit = $("#whoUnit").value, pin = $("#whoPin").value.trim(), code = $("#apprField").hidden ? "" : $("#whoCode").value.trim();
      const err = m => { $("#whoErr").textContent = m; };
      if (!name) return err("Enter your name.");
      if (!code && !(unit && pin)) return err("Choose your unit and enter its PIN, or press View only.");
      err("Checking…");
      let r; try { r = await api.login({ name, unit, pin, code }); } catch (x) { return err("Could not reach the server. Check your connection."); }
      if (r.lockedOut) return err("Too many wrong tries. Wait 15 minutes.");
      if (code && !r.approver) return err("That approver code is not right.");
      if (unit && pin && !r.unitOk) return err(r.hasPin ? `That PIN is not right for ${unitName(unit)}.` : `${unitName(unit)} has no PIN yet. Ask Group Strategy to set one.`);
      finish(name, r.unitOk ? unit : "", r.unitOk ? pin : "", r.approver ? code : "");
    };
  }

  // ---------- boot ----------
  render();
  (async () => {
    const cfgErr = configError();
    if (cfgErr) { bannerMsg = cfgErr; state.unitsLoaded = state.plansLoaded = true; render(); return; }
    const data = createData(); ({ db, api, downloads } = data); dataMode = data.mode;
    session = getSession(); myId = session.get().name || "";
    $("#whoBtn").onclick = showWho;
    api.approverNames().then(n => { state.approverNames = n; }).catch(() => {});
    checkRights(true).then(() => { render(); if (isAppr()) loadPinStatus(); });
    subscribeRequests(); X.subscribe();
    if (!myId) setTimeout(() => { if (state.unitsLoaded) showWho(); else { const iv = setInterval(() => { if (state.unitsLoaded) { clearInterval(iv); showWho(); } }, 200); } }, 0);
    window.addEventListener("offline", () => banner("You are offline. Changes will not save until the connection returns."));
    window.addEventListener("online", () => { bannerMsg = ""; subscribePlans(); render(); });
    db.collection("units").onSnapshot(snap => {
      state.units = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      state.unitsLoaded = true;
      if (state.editUnit && state.editUnit !== ALL && !state.units.some(u => u.id===state.editUnit)) { state.editUnit = null; state.draft = null; }
      if (state.tab==="update" && !hasDraft()) loadDraft();
      else if (state.allDrafts) sortedUnits().forEach(u => { if (!state.allDrafts[u.id]) state.allDrafts[u.id] = clone(state.plans[u.id] || emptyPlan(u.id)); });
      render();
    }, err => banner(`Could not load units (${err.code}). Reload the page to reconnect.`));
    subscribePlans();
  })();
})();
