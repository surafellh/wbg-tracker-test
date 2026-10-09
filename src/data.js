// Data layer: connects to Supabase when configured, or falls back to this browser's local storage
// (loaded with the seed data) so the app runs out of the box for trying things on localhost.
// Reads use db.collection / db.doc. Every change goes through `api`, which in Supabase mode calls the
// PIN-checked database functions from supabase/upgrade-1-safe.sql.
import { createClient } from "@supabase/supabase-js";
import { SEED_UNITS, SEED_PLANS, SEED_ACTIVITY } from "./seedData.js";
import { addisMonday, addisToday, checkUnitSave, isApproverName, DEFAULT_APPROVERS } from "./rules.js";

const URL_ = import.meta.env.VITE_SUPABASE_URL;
const KEY_ = import.meta.env.VITE_SUPABASE_ANON_KEY;
const LOCAL_APPROVER_CODE = import.meta.env.VITE_LOCAL_APPROVER_CODE || "approve";

const isSupabaseConfigured = () => !!(URL_ && KEY_ && !URL_.includes("YOUR-PROJECT-REF") && !KEY_.includes("YOUR-ANON-PUBLIC-KEY"));

// document field -> column. `ts` lists timestamp fields (normalised to ISO strings); `nullText` maps "" <-> NULL.
const COLLECTIONS = {
  units: { table: "units", map: { name: "name", type: "type", order: "sort_order", departments: "departments", people: "people" }, ts: [] },
  plans: { table: "plans", map: { week: "week", unit: "unit_id", tasks: "tasks", wins: "wins", blockers: "blockers", asks: "asks", updatedAt: "updated_at", updatedBy: "updated_by", source: "source" }, ts: ["updatedAt"] },
  activity: { table: "activity", map: { ts: "ts", by: "by_name", unit: "unit_id", week: "week", action: "action", summary: "summary", details: "details" }, ts: ["ts"], nullText: ["week"] },
  requests: { table: "change_requests", map: { createdAt: "created_at", unit: "unit_id", week: "week", planId: "plan_id", by: "requested_by", status: "status", summary: "summary", details: "details", patch: "patch", decidedBy: "decided_by", decidedAt: "decided_at", note: "decision_note" }, ts: ["createdAt", "decidedAt"] },
  history: { table: "row_history", map: { tbl: "tbl", rowId: "row_id", op: "op", old: "old_row", at: "changed_at", by: "changed_by" }, ts: ["at"] },
};
// A history row stores the database row; turn it back into a plan document.
export function planFromRow(r) {
  if (!r) return null;
  return { id: r.id, week: r.week, unit: r.unit_id ?? r.unit, tasks: r.tasks || [], wins: r.wins || "", blockers: r.blockers || "", asks: r.asks || "", updatedAt: r.updated_at ?? r.updatedAt ?? null, updatedBy: r.updated_by ?? r.updatedBy ?? "", source: r.source || "" };
}

const fail = (error) => {
  const e = Object.assign(new Error(error.message || "Request failed"), { code: error.code || "error" });
  window.dispatchEvent(new CustomEvent("wbg-data-error", { detail: e }));
  throw e;
};

export function configError() { return ""; }

export function createData() {
  return isSupabaseConfigured() ? createSupabaseData() : createLocalData();
}

// Evidence: allowed file types and limits (also enforced by the Storage bucket: 5 MB per file).
export const EVIDENCE = {
  maxFiles: 3, maxTotal: 5 * 1024 * 1024,
  accept: ".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx",
  types: ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/csv", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
};
const extType = (name) => ({ pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", csv: "text/csv", doc: "application/msword", docx: EVIDENCE.types[8], xls: "application/vnd.ms-excel", xlsx: EVIDENCE.types[10], ppt: "application/vnd.ms-powerpoint", pptx: EVIDENCE.types[12] })[String(name).split(".").pop().toLowerCase()] || "";
export const fileType = (f) => (EVIDENCE.types.includes(f.type) ? f.type : extType(f.name));

function planJson(p) {
  return { unit: p.unit, week: p.week, tasks: p.tasks || [], wins: p.wins || "", blockers: p.blockers || "", asks: p.asks || "", source: p.source || "" };
}

function createSupabaseData() {
  const sb = createClient(URL_, KEY_, { auth: { persistSession: false }, realtime: { params: { eventsPerSecond: 5 } } });
  const live = new Map();
  const bump = (table) => (live.get(table) || new Set()).forEach((f) => f());
  const bumpAll = () => ["plans", "units", "activity", "change_requests", "row_history"].forEach(bump);

  const fromRow = (cfg, row) => {
    const doc = {};
    for (const [k, col] of Object.entries(cfg.map)) {
      let v = row[col];
      if (v === undefined) continue;
      if (v === null && cfg.nullText && cfg.nullText.includes(k)) v = "";
      if (v && cfg.ts.includes(k)) v = new Date(v).toISOString();
      doc[k] = v;
    }
    return doc;
  };
  const snapDoc = (cfg, row) => ({ id: row.id, exists: true, data: () => JSON.parse(JSON.stringify(fromRow(cfg, row))) });
  const OPS = { "==": "eq", "!=": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };

  function query(colName, filters = [], ord = null, lim = null) {
    const cfg = COLLECTIONS[colName];
    if (!cfg) throw new Error(`Unknown collection: ${colName}`);
    const col = (f) => (f === "id" ? "id" : cfg.map[f] || f);
    const run = async () => {
      let q = sb.from(cfg.table).select("*");
      for (const [f, op, v] of filters) q = q[OPS[op]](col(f), v);
      if (ord) q = q.order(col(ord[0]), { ascending: ord[1] !== "desc" });
      if (lim) q = q.limit(lim);
      const { data, error } = await q;
      if (error) fail(error);
      const docs = (data || []).map((r) => snapDoc(cfg, r));
      return { docs, size: docs.length, empty: !docs.length };
    };
    return {
      where: (f, op, v) => query(colName, [...filters, [f, op, v]], ord, lim),
      orderBy: (f, d = "asc") => query(colName, filters, [f, d], lim),
      limit: (n) => query(colName, filters, ord, n),
      get: run,
      onSnapshot(next, onError) {
        let stopped = false, timer = null;
        const refetch = () => { if (stopped) return; clearTimeout(timer); timer = setTimeout(() => run().then((s) => !stopped && next(s)).catch((e) => !stopped && onError && onError(e)), 120); };
        run().then((s) => !stopped && next(s)).catch((e) => !stopped && onError && onError(e));
        if (!live.has(cfg.table)) live.set(cfg.table, new Set());
        live.get(cfg.table).add(refetch);
        const ch = sb.channel(`wbg-${cfg.table}-${Math.random().toString(36).slice(2)}`)
          .on("postgres_changes", { event: "*", schema: "public", table: cfg.table }, refetch)
          .subscribe();
        return () => { stopped = true; clearTimeout(timer); live.get(cfg.table).delete(refetch); sb.removeChannel(ch); };
      },
    };
  }
  function docRef(path) {
    const [colName, id] = path.split("/");
    const cfg = COLLECTIONS[colName];
    if (!cfg) throw new Error(`Unknown collection: ${colName}`);
    return {
      id, path,
      async get() {
        const { data, error } = await sb.from(cfg.table).select("*").eq("id", id).maybeSingle();
        if (error) fail(error);
        return data ? snapDoc(cfg, data) : { id, exists: false, data: () => undefined };
      },
    };
  }

  const rpc = async (fn, args) => {
    const { data, error } = await sb.rpc(fn, args);
    if (error) fail(error);
    bumpAll();
    return data || { error: "no_response" };
  };
  const api = {
    mode: "supabase",
    login: (auth) => rpc("wbg_login", { p_auth: auth }),
    savePlan: (auth, plan, base, force, activity) => rpc("wbg_save_plan", { p_auth: auth, p_plan: planJson(plan), p_base: base || null, p_force: !!force, p_activity: activity || null }),
    requestChange: (auth, req) => rpc("wbg_request_change", { p_auth: auth, p_req: req }),
    decideRequest: (auth, id, approve, note, plan) => rpc("wbg_decide_request", { p_auth: auth, p_id: id, p_approve: approve, p_note: note || "", p_plan: plan ? planJson(plan) : null }),
    withdrawRequest: (auth, id) => rpc("wbg_withdraw_request", { p_auth: auth, p_id: id }),
    restoreVersion: (auth, hid) => rpc("wbg_restore_version", { p_auth: auth, p_history_id: Number(hid) }),
    undoLast: (auth, planId) => rpc("wbg_undo_last_save", { p_auth: auth, p_plan_id: planId }),
    saveUnit: (auth, op, data, summary) => rpc("wbg_save_unit", { p_auth: auth, p_op: op, p_data: data, p_summary: summary || "" }),
    setUnitPin: (auth, unit, pin) => rpc("wbg_set_unit_pin", { p_auth: auth, p_unit: unit, p_pin: pin || "" }),
    pinStatus: (auth) => rpc("wbg_pin_status", { p_auth: auth }),
    changeApproverCode: (auth, code) => rpc("wbg_change_approver_code", { p_auth: auth, p_new: code }),
    log: (auth, entry) => rpc("wbg_log", { p_auth: auth, p_entry: entry }),
    restoreBackup: (auth, backup) => rpc("wbg_restore_backup", { p_auth: auth, p_backup: backup }),
    async approverNames() {
      const { data } = await sb.from("app_config").select("value").eq("key", "approver_names").maybeSingle();
      return (data && Array.isArray(data.value)) ? data.value : DEFAULT_APPROVERS;
    },
    async uploadEvidence(file, path) {
      const { error } = await sb.storage.from("evidence").upload(path, file, { contentType: fileType(file), upsert: false });
      if (error) fail({ code: "upload_failed", message: error.message });
      return { path };
    },
    async evidenceUrl(path, name) {
      const { data, error } = await sb.storage.from("evidence").createSignedUrl(path, 3600, { download: name || true });
      if (error) fail({ code: "not_found", message: error.message });
      return data.signedUrl;
    },
    async readAll(table) {
      const out = []; let from = 0;
      for (;;) { const { data, error } = await sb.from(table).select("*").range(from, from + 999); if (error) fail(error); out.push(...data); if (data.length < 1000) break; from += 1000; }
      return out;
    },
  };

  const db = { doc: docRef, collection: (c) => query(c) };
  return { db, api, downloads: getDownloads(), mode: "supabase" };
}

// ---------------------------------------------------------------------------
// Local mode: everything lives in this browser. Same rules as the database, for trying the app on localhost.
// ---------------------------------------------------------------------------
function createLocalData() {
  const KEYS = { units: "wbg_local_units", plans: "wbg_local_plans", activity: "wbg_local_activity", requests: "wbg_local_requests", history: "wbg_local_history" };
  const SEEDS = { units: SEED_UNITS, plans: SEED_PLANS, activity: SEED_ACTIVITY, requests: [], history: [] };
  const listeners = new Map();
  const getStore = (c) => {
    try {
      const raw = localStorage.getItem(KEYS[c]);
      if (!raw) { const seed = SEEDS[c] || []; localStorage.setItem(KEYS[c], JSON.stringify(seed)); return JSON.parse(JSON.stringify(seed)); }
      return JSON.parse(raw);
    } catch (e) { return JSON.parse(JSON.stringify(SEEDS[c] || [])); }
  };
  const setStore = (c, items) => { try { localStorage.setItem(KEYS[c], JSON.stringify(items)); } catch (e) { fail({ code: "quota_exceeded", message: "Browser storage is full" }); } notify(c); };
  const notify = (c) => (listeners.get(c) || new Set()).forEach((fn) => fn());
  const snapDoc = (item) => ({ id: item.id, exists: true, data: () => JSON.parse(JSON.stringify(item)) });
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  function query(c, filters = [], ord = null, lim = null) {
    const run = async () => {
      let items = getStore(c);
      for (const [f, op, v] of filters) items = items.filter((it) => { const x = it[f]; return op === "==" ? x === v : op === "!=" ? x !== v : op === ">" ? x > v : op === ">=" ? x >= v : op === "<" ? x < v : op === "<=" ? x <= v : true; });
      if (ord) { const [f, dir] = ord; items.sort((a, b) => { const A = a[f] ?? "", B = b[f] ?? ""; return A < B ? (dir === "desc" ? 1 : -1) : A > B ? (dir === "desc" ? -1 : 1) : 0; }); }
      if (lim) items = items.slice(0, lim);
      const docs = items.map(snapDoc);
      return { docs, size: docs.length, empty: !docs.length };
    };
    return {
      where: (f, op, v) => query(c, [...filters, [f, op, v]], ord, lim),
      orderBy: (f, d = "asc") => query(c, filters, [f, d], lim),
      limit: (n) => query(c, filters, ord, n),
      get: run,
      onSnapshot(next, onError) {
        let stopped = false;
        const refetch = () => { if (!stopped) run().then((s) => !stopped && next(s)).catch((e) => !stopped && onError && onError(e)); };
        refetch();
        if (!listeners.has(c)) listeners.set(c, new Set());
        listeners.get(c).add(refetch);
        return () => { stopped = true; listeners.get(c)?.delete(refetch); };
      },
    };
  }
  function docRef(path) {
    const [c, id] = path.split("/");
    return { id, path, async get() { const it = getStore(c).find((x) => x.id === id); return it ? snapDoc(it) : { id, exists: false, data: () => undefined }; } };
  }

  // writes, with the same automatic history the database trigger keeps
  let hid = Date.now();
  const keepHistory = (tbl, old, op, by) => {
    const h = getStore("history");
    const row = tbl === "plans" ? { id: old.id, week: old.week, unit_id: old.unit, tasks: old.tasks, wins: old.wins, blockers: old.blockers, asks: old.asks, updated_at: old.updatedAt, updated_by: old.updatedBy, source: old.source } : { id: old.id, name: old.name, type: old.type, sort_order: old.order, departments: old.departments, people: old.people };
    h.unshift({ id: String(++hid), tbl, rowId: old.id, op, old: row, at: new Date().toISOString(), by: by || null });
    setStore("history", h.slice(0, 2000));
  };
  const put = (c, rec, by) => {
    const items = getStore(c), i = items.findIndex((x) => x.id === rec.id);
    if (i >= 0) { if (c === "plans" || c === "units") keepHistory(c, items[i], "UPDATE", by); items[i] = rec; } else items.push(rec);
    setStore(c, items);
  };
  const del = (c, id) => { const items = getStore(c), i = items.findIndex((x) => x.id === id); if (i < 0) return; if (c === "plans" || c === "units") keepHistory(c, items[i], "DELETE"); items.splice(i, 1); setStore(c, items); };
  const addActivity = (by, unit, week, e) => { const a = getStore("activity"); a.push({ id: e.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8), ts: new Date().toISOString(), by: by || "", unit: unit || "", week: week || "", action: e.action || "save", summary: e.summary || "", details: e.details || [] }); setStore("activity", a); };

  const pins = () => read("wbg_local_pins") || {};
  const approverCode = () => read("wbg_local_approver_code") || LOCAL_APPROVER_CODE;
  const isAppr = (auth) => !!auth && !!auth.code && isApproverName(auth.name) && auth.code === approverCode();
  const unitOk = (auth, unit) => !!auth && auth.unit === unit && !!auth.pin && !!(auth.name || "").trim() && pins()[unit] === auth.pin;
  const ok = (x) => Promise.resolve({ ok: true, ...(x || {}) });
  const err = (e, x) => Promise.resolve({ error: e, ...(x || {}) });
  const planId = (w, u) => `${w}_${u}`;
  const savePlanRaw = (auth, plan, source) => {
    const id = planId(plan.week, plan.unit), at = new Date().toISOString();
    put("plans", { id, week: plan.week, unit: plan.unit, tasks: plan.tasks || [], wins: plan.wins || "", blockers: plan.blockers || "", asks: plan.asks || "", updatedAt: at, updatedBy: (auth.name || "").trim(), source: source ?? (plan.source || "") }, (auth.name || "").trim());
    return at;
  };

  const api = {
    mode: "local",
    login(auth) {
      const unit = auth.unit || "";
      return ok({ unitOk: unitOk(auth, unit), approver: isAppr(auth), approverName: isApproverName(auth.name), lockedOut: false, hasPin: !!pins()[unit] });
    },
    savePlan(auth, plan, base, force, activity) {
      const appr = isAppr(auth);
      if (!appr && !unitOk(auth, plan.unit)) return err("not_allowed");
      const old = getStore("plans").find((x) => x.id === planId(plan.week, plan.unit));
      if (old && base && !force && old.updatedAt !== base) return err("conflict", { updatedAt: old.updatedAt, updatedBy: old.updatedBy });
      if (!appr) { const r = checkUnitSave(old, plan, addisMonday(), addisToday()); if (r) return err("needs_approval", { reason: r }); }
      const at = savePlanRaw(auth, plan);
      if (activity) addActivity(auth.name, plan.unit, plan.week, activity);
      return ok({ updatedAt: at });
    },
    requestChange(auth, req) {
      if (!unitOk(auth, req.unit) && !isAppr(auth)) return err("not_allowed");
      const r = getStore("requests");
      r.push({ id: req.id, createdAt: new Date().toISOString(), unit: req.unit, week: req.week, planId: planId(req.week, req.unit), by: (auth.name || "").trim(), status: "pending", summary: req.summary || "", details: req.details || [], patch: req.patch || [], decidedBy: null, decidedAt: null, note: "" });
      setStore("requests", r);
      addActivity(auth.name, req.unit, req.week, { action: "request", summary: "Asked for approval: " + (req.summary || ""), details: req.details || [] });
      return ok();
    },
    decideRequest(auth, id, approve, note, plan) {
      if (!isAppr(auth)) return err("not_allowed");
      const r = getStore("requests"), q = r.find((x) => x.id === id);
      if (!q || q.status !== "pending") return err("not_pending");
      if (approve) savePlanRaw(auth, { ...plan, unit: q.unit, week: q.week }, "");
      Object.assign(q, { status: approve ? "approved" : "rejected", decidedBy: auth.name.trim(), decidedAt: new Date().toISOString(), note: note || "" });
      setStore("requests", r);
      addActivity(auth.name, q.unit, q.week, { action: "approval", summary: `${approve ? "Approved" : "Rejected"} request from ${q.by}: ${q.summary}${note ? " · Note: " + note : ""}`, details: q.details });
      return ok();
    },
    withdrawRequest(auth, id) {
      const r = getStore("requests"), q = r.find((x) => x.id === id);
      if (!q || q.status !== "pending") return err("not_pending");
      if (!unitOk(auth, q.unit) && !isAppr(auth)) return err("not_allowed");
      Object.assign(q, { status: "withdrawn", decidedBy: auth.name.trim(), decidedAt: new Date().toISOString() });
      setStore("requests", r); return ok();
    },
    restoreVersion(auth, hidv) {
      if (!isAppr(auth)) return err("not_allowed");
      const h = getStore("history").find((x) => x.id === String(hidv)); if (!h) return err("not_found");
      if (h.tbl === "plans") { const p = planFromRow(h.old); savePlanRaw(auth, p, "Restored copy from " + h.at.slice(0, 16).replace("T", " ")); addActivity(auth.name, p.unit, p.week, { action: "restore", summary: "Restored the plan to the copy saved before " + h.at.slice(0, 16).replace("T", " ") + " UTC" }); }
      else { const o = h.old; put("units", { id: o.id, name: o.name, type: o.type, order: o.sort_order, departments: o.departments || [], people: o.people || [] }); addActivity(auth.name, o.id, "", { action: "restore", summary: `Restored unit "${o.name}"` }); }
      return ok();
    },
    undoLast(auth, id) {
      const p = getStore("plans").find((x) => x.id === id); if (!p) return err("not_found");
      if (!unitOk(auth, p.unit) && !isAppr(auth)) return err("not_allowed");
      if (p.updatedBy !== (auth.name || "").trim() || Date.now() - Date.parse(p.updatedAt) > 30 * 60e3) return err("too_late");
      const h = getStore("history").find((x) => x.tbl === "plans" && x.rowId === id && x.op !== "SNAPSHOT"); if (!h) return err("not_found");
      savePlanRaw(auth, { ...planFromRow(h.old), unit: p.unit, week: p.week }, "Undo");
      addActivity(auth.name, p.unit, p.week, { action: "restore", summary: "Undid the last save" });
      return ok();
    },
    saveUnit(auth, op, data, summary) {
      const appr = isAppr(auth), units = getStore("units"), u = units.find((x) => x.id === data.id);
      if (op === "lists") { if (!appr && !unitOk(auth, data.id)) return err("not_allowed"); if (!u) return err("not_found"); put("units", { ...u, ...(data.departments ? { departments: data.departments } : {}), ...(data.people ? { people: data.people } : {}) }); }
      else if (!appr) return err("not_allowed");
      else if (op === "add") { if (!u) put("units", { id: data.id, name: data.name, type: data.type || "Business unit", order: data.order || 99, departments: [], people: [] }); }
      else if (op === "update") { if (u) put("units", { ...u, ...(data.name ? { name: data.name } : {}), ...(data.type ? { type: data.type } : {}) }); }
      else if (op === "remove") del("units", data.id);
      addActivity(auth.name, data.id, "", { action: op === "lists" ? "lists" : "unit", summary: summary || op + " unit" });
      return ok();
    },
    setUnitPin(auth, unit, pin) {
      if (!isAppr(auth)) return err("not_allowed");
      if (pin && pin.length < 4) return err("pin_too_short");
      const p = pins(); if (pin) p[unit] = pin; else delete p[unit]; write("wbg_local_pins", p);
      addActivity(auth.name, unit, "", { action: "unit", summary: pin ? "Set a new unit PIN" : "Removed the unit PIN" });
      return ok();
    },
    pinStatus(auth) { if (!isAppr(auth)) return err("not_allowed"); return ok({ units: Object.fromEntries(Object.keys(pins()).map((k) => [k, true])) }); },
    changeApproverCode(auth, code) { if (!isAppr(auth)) return err("not_allowed"); if ((code || "").length < 6) return err("code_too_short"); write("wbg_local_approver_code", code); return ok(); },
    log(auth, e) { if (!isAppr(auth) && !unitOk(auth, e.unit)) return err("not_allowed"); addActivity(auth.name, e.unit, e.week, e); return ok(); },
    restoreBackup(auth, b) {
      if (!isAppr(auth)) return err("not_allowed");
      (b.units || []).forEach((u) => put("units", { id: u.id, name: u.name, type: u.type, order: u.order, departments: u.departments || [], people: u.people || [] }));
      (b.plans || []).forEach((p) => put("plans", { ...p }, auth.name));
      addActivity(auth.name, "", "", { action: "restore", summary: `Restored from backup file: ${(b.units || []).length} units, ${(b.plans || []).length} plans` });
      return ok({ units: (b.units || []).length, plans: (b.plans || []).length });
    },
    approverNames: async () => DEFAULT_APPROVERS,
    async uploadEvidence(file, path) { await idbPut(path, file); return { path }; },
    async evidenceUrl(path) { const b = await idbGet(path); if (!b) fail({ code: "not_found", message: "File not found in this browser" }); return URL.createObjectURL(b); },
    async readAll(table) { const c = Object.entries(COLLECTIONS).find(([, v]) => v.table === table); return c ? getStore(c[0]) : []; },
  };

  const db = { doc: docRef, collection: (c) => query(c) };
  return { db, api, downloads: getDownloads(), mode: "local" };
}

// Evidence files in local mode live in this browser's IndexedDB.
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open("wbg-evidence", 1); r.onupgradeneeded = () => r.result.createObjectStore("files"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function idbPut(k, v) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction("files", "readwrite"); t.objectStore("files").put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
async function idbGet(k) { const d = await idb(); return new Promise((res, rej) => { const r = d.transaction("files").objectStore("files").get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

// Who is using the app: name + unit PIN and/or approver code, kept in this browser.
export function getSession() {
  const K = "wbg-session";
  const read = () => { try { return JSON.parse(localStorage.getItem(K) || "null") || {}; } catch (e) { return {}; } };
  let s = read();
  if (!s.name) { try { const n = localStorage.getItem("wbg-name"); if (n) s.name = n; } catch (e) {} }
  return {
    get: () => s,
    set(next) { s = { ...next }; try { localStorage.setItem(K, JSON.stringify(s)); if (s.name) localStorage.setItem("wbg-name", s.name); } catch (e) {} },
    clear() { s = { name: s.name }; try { localStorage.setItem(K, JSON.stringify(s)); } catch (e) {} },
  };
}

function getDownloads() {
  return {
    async save({ filename, data }) {
      const type = /\.xlsx$/i.test(filename) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : /\.pdf$/i.test(filename) ? "application/pdf" : /\.json$/i.test(filename) ? "application/json" : "text/csv;charset=utf-8";
      const blob = new Blob([data], { type });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    },
  };
}
