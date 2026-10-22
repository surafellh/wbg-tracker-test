// Cash flow. Two groups of screens:
//   See:   Summary (where cash stands, what is left after each step) and Report (plan against actual, by type, by bank, forecast).
//   Enter: Daily log (what cash really moved, and in which bank), Collections and payments (what is expected), Plan (monthly plan lines), Setup (types, USD rate).
// Shown to Group Finance, unit Finance departments, Group Strategy, CEO and DCEO.
import { SECTIONS, PLAN_SECTIONS, PRIORITIES, CURRENCIES, bucketCode, BUCKET_TEXT, FIN_UNITS_FALLBACK, IMPLIED_DAYS, num, sum, addDays, addMonths, monthOf, keyOf, periods, periodLabel, periodEnd, isOpenAt, etb, bankAt, bankDays, position, funding, timeline, byType, planByMonth, HORIZON, MONTHS } from "./cashcalc.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const SHORT = { "wagwago-electric": "Wagwago Trading", trucksload: "TrucksLoad", geez: "Geez", "niyat-consultancy": "Niyat", "wanza-logistics": "Wanza" };
const FULL = { "wagwago-electric": "Wagwago Trading (Electric and Corporate)" };
const PRI_RANK = { High: 0, Normal: 1, Low: 2 };
const TABS = [["summary", "Summary", "see"], ["report", "Report", "see"], ["log", "Daily log", "enter"], ["items", "Collections and payments", "enter"], ["plan", "Plan", "enter"], ["setup", "Setup", "enter"]];
const serialToIso = (v) => { if (v === "" || v == null) return ""; if (typeof v === "number") return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10); const s = String(v).trim(); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[0] : ""; };
const bucketOf = (v) => { const x = parseInt(String(v).trim(), 10); return x === 1 || x === 11 ? 1 : x === 2 || x === 22 ? 2 : x === 3 || x === 33 ? 3 : 0; };

export function createCash(c) {
  const { state, esc } = c;
  const S = (state.cf = { items: [], types: [], bank: [], log: [], plan: [], settings: {}, loaded: 0, view: "summary", asOf: c.todayIso, scope: "all", bk: { 1: true, 2: true, 3: true }, typeOn: {}, mode: "month", day: c.todayIso, range: 60, dr: {}, bd: {}, dq: { kind: "", q: "", show: 30 }, busy: false, m: null,
    lf: { kind: "", type: "", status: "open", q: "", show: 40 }, pf: { from: "", unit: "all" } });
  const A = () => c.auth() || {};
  const finDept = () => (A().departments || []).some((d) => /^fin/i.test(String(d)));
  const full = () => ["super_admin", "executive"].includes(A().role) || A().unit === "group-finance-function";
  const admin = () => A().role === "super_admin" || A().unit === "group-finance-function";
  const canSee = () => full() || (!!A().unit && finDept());
  const canWrite = (u) => admin() || (!!u && A().unit === u && finDept());
  const canWriteAny = () => admin() || (!!A().unit && finDept());
  const allUnits = () => { const bu = c.sortedUnits().filter((u) => u.type === "Business unit").map((u) => u.id); const ids = bu.length ? bu : FIN_UNITS_FALLBACK; return full() ? ids : [A().unit]; };
  const scopeUnits = () => (S.scope === "all" || !allUnits().includes(S.scope) ? allUnits() : [S.scope]);
  const writableUnits = () => allUnits().filter((u) => canWrite(u));
  const ushort = (u) => SHORT[u] || c.unitName(u);
  const uname = (u) => FULL[u] || c.unitName(u);
  const fx = () => num(S.settings.usd_etb);
  const typeByCode = (code) => S.types.find((t) => t.code === code);
  const plain = (v) => Math.round(num(v)).toLocaleString("en-US");
  const money = (v, dash) => { const x = Math.round(num(v)); return x === 0 && dash !== false ? '<span class="muted">–</span>' : `<span class="${x < 0 ? "neg" : ""}">${x < 0 ? "−" : ""}${Math.abs(x).toLocaleString("en-US")}</span>`; };
  const compact = (v) => { const x = num(v), a = Math.abs(x), s = x < 0 ? "−" : ""; return a >= 1e9 ? s + (a / 1e9).toFixed(2) + " B" : a >= 1e6 ? s + (a / 1e6).toFixed(1) + " M" : a >= 1e3 ? s + (a / 1e3).toFixed(0) + " K" : s + Math.round(a); };
  const pct = (a, b) => (num(b) > 0 ? Math.round((num(a) / num(b)) * 100) + "%" : '<span class="muted">–</span>');
  const dShort = (iso) => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
  const msg = (r) => (r && r.error ? (r.error === "exists" ? "That code already exists" : c.errText(r)) : "");

  // ---------------- data ----------------
  let subs = [];
  function subscribe() {
    if (!c.db() || subs.length || !canSee()) return;
    const on = (col, key, order, fn) => c.db().collection(col).orderBy(order).limit(10000).onSnapshot((snap) => { S[key] = fn ? fn(snap) : snap.docs.map((d) => ({ id: d.id, ...d.data() })); S.loaded++; if (state.tab === "cashflow" && !S.m && !S.busy) c.render(); }, () => { S.loaded++; });
    subs = [on("cftypes", "types", "sort"), on("cfitems", "items", "createdAt"), on("cfbank", "bank", "day"), on("cflog", "log", "day"), on("cfplan", "plan", "month"),
      on("cfsettings", "settings", "updatedAt", (snap) => Object.fromEntries(snap.docs.map((d) => [d.id, d.data().value])))];
  }
  // Run one or more saves under a lock. fn returns the last api result; the first error stops everything and is shown.
  async function run(fn, okMsg) {
    if (S.busy) return false; S.busy = true;
    try { const r = await fn(); if (r && r.error) { c.toast(msg(r)); return false; } if (okMsg) c.toast(okMsg); return r || true; }
    catch (e) { c.toast(c.errText(e)); return false; }
    finally { S.busy = false; c.render(); }
  }
  const itemRow = (it) => ({ id: it.id, unit: it.unit, kind: it.kind, party: it.party, description: it.description, ref: it.ref, typeCode: it.typeCode, bucket: it.bucket, amount: it.amount, currency: it.currency, priority: it.priority, expected: it.expected || "", status: it.status, settledOn: it.settledOn || "", note: it.note, enteredOn: it.enteredOn });
  const logRow = (l) => ({ id: l.id, unit: l.unit, day: l.day, kind: l.kind, bank: l.bank, amount: l.amount, currency: l.currency, party: l.party, description: l.description, typeCode: l.typeCode, itemId: l.itemId || "", itemCode: l.itemCode || "", note: l.note });

  // How much of each planned line has been collected or paid (from the daily log), up to a date.
  const loggedFor = (itemId, upTo, skipId) => sum(S.log.filter((l) => l.itemId === itemId && l.id !== skipId && (!upTo || l.day <= upTo)), (l) => l.amount);
  const doneOf = (it) => { const lg = S.log.filter((l) => l.itemId === it.id); return lg.length ? sum(lg, (l) => l.amount) : (it.status === "settled" ? num(it.amount) : 0); };
  // Lines as they stand on the as-of date: the amount left to collect or pay.
  function effItems(asOf) {
    return S.items.map((it) => { const done = loggedFor(it.id, asOf); return done ? { ...it, amount: Math.max(0, num(it.amount) - done) } : it; })
      .filter((it) => !(num(it.amount) <= 0 && it.status === "open"));
  }
  // Types that count in the position: the type's own setting unless this screen overrides it.
  const typesEff = () => S.types.map((t) => ({ ...t, expected: S.typeOn[t.code] === undefined ? t.expected : S.typeOn[t.code] }));
  const inScope = (units, asOf) => effItems(asOf).filter((it) => units.includes(it.unit) && S.bk[it.bucket]);
  // Money that really moved per period: the daily log where one exists for that unit and day, else the bank report's in and out.
  function actuals(units, asOf, mode) {
    const out = {}, add = (day, kind, v) => { const k = keyOf(day, mode); (out[k] = out[k] || { in: 0, out: 0 })[kind] += v; };
    const savedKey = new Set(S.bank.map((b) => b.unit + "|" + b.bank + "|" + b.day));
    for (const b of S.bank) if (units.includes(b.unit) && b.day <= asOf) { add(b.day, "in", num(b.inflow)); add(b.day, "out", num(b.outflow)); }
    for (const l of S.log) if (units.includes(l.unit) && l.day <= asOf && !savedKey.has(l.unit + "|" + (l.bank || "") + "|" + l.day)) add(l.day, l.kind, etb(l, fx()));
    return out;
  }
  // Saved bank balances, plus the days that only have a daily log: the last balance of that bank moved by the day's cash.
  function effBank() {
    const rows = [...S.bank], key = (u, b) => u + "|" + b, last = {}; const saved = new Set(S.bank.map((b) => key(b.unit, b.bank) + "|" + b.day));
    const events = new Map(); for (const l of S.log) { if (!l.bank) continue; const k = key(l.unit, l.bank) + "|" + l.day; const e = events.get(k) || { unit: l.unit, bank: l.bank, day: l.day, inn: 0, out: 0 }; e[l.kind === "in" ? "inn" : "out"] += num(l.amount); events.set(k, e); }
    const all = [...S.bank.map((b) => ({ ...b, ev: false })), ...[...events.values()].map((e) => ({ unit: e.unit, bank: e.bank, day: e.day, ev: true, e }))].sort((a, b) => a.day.localeCompare(b.day));
    for (const x of all) { const k = key(x.unit, x.bank);
      if (!x.ev) { last[k] = num(x.closing); continue; }
      if (saved.has(k + "|" + x.day)) continue;
      const open = last[k] || 0, close = open + x.e.inn - x.e.out; rows.push({ id: "log|" + k + "|" + x.day, unit: x.unit, bank: x.bank, day: x.day, opening: open, inflow: x.e.inn, outflow: x.e.out, closing: close, synthetic: true }); last[k] = close; }
    return rows;
  }
  const knownBanks = (unit) => { const all = [...new Set([...S.bank.filter((b) => b.unit === unit).map((b) => b.bank), ...S.log.filter((l) => l.unit === unit && l.bank).map((l) => l.bank)])].sort(); const named = all.filter((b) => b !== "All banks"); return named.length ? named : all; };
  // The bank a unit used last for money in or out: the default on the day sheet.
  const lastBank = (unit, kind) => { const l = S.log.filter((q) => q.unit === unit && q.bank && q.kind === kind).sort((a, b) => b.day.localeCompare(a.day))[0]; return l ? l.bank : knownBanks(unit)[0] || ""; };
  const planDate = (it, asOf) => (it.expected ? String(it.expected).slice(0, 10) : addDays(it.enteredOn && it.enteredOn > "2000" ? it.enteredOn : asOf, IMPLIED_DAYS[it.bucket] || 30));

  // ---------------- shared pieces ----------------
  const chip = (on, attrs, label, tip) => `<button type="button" class="cf-chip${on ? " on" : ""}" ${attrs} aria-pressed="${on}" ${tip ? `title="${esc(tip)}"` : ""}>${label}</button>`;
  const unitSel = (val) => `<select data-cfc="scope" aria-label="Unit">${`<option value="all">${full() ? "All business units" : "My unit"}</option>`}${allUnits().map((u) => `<option value="${esc(u)}" ${val === u ? "selected" : ""}>${esc(uname(u))}</option>`).join("")}</select>`;
  const urgencyChips = () => `<span class="cf-group" role="group" aria-label="Urgency">${[1, 2, 3].map((b) => chip(S.bk[b], `data-cf="bk" data-v="${b}"`, `${b} <span class="muted">/ ${b}${b}</span>`, BUCKET_TEXT[b])).join("")}</span>`;
  const typeToggles = () => {
    const ts = typesEff().filter((t) => t.active), n = ts.filter((t) => t.expected).length;
    return `<details class="cf-inc"><summary>Counted types <span class="muted">${n} of ${ts.length}</span></summary><div class="cf-incbox"><div class="small muted">Tick the types that are expected to be collected or paid. Untick, for example, related parties that are not expected to pay soon. Hover a type for its meaning.</div>
      <div class="cf-chips">${ts.map((t) => chip(t.expected, `data-cf="type-on" data-code="${esc(t.code)}"`, esc(t.code), (t.label && t.label !== t.code ? t.label + ". " : "") + (t.description || ""))).join("")}</div>
      ${Object.keys(S.typeOn).length ? `<button class="btn small" data-cf="type-reset">Back to the saved settings</button>` : ""}</div></details>`;
  };
  const usdWarn = () => { const n = S.items.filter((i) => i.currency === "USD" && i.status === "open").length; return n && !fx() ? `<div class="cf-note warn">${n} open item${n > 1 ? "s are" : " is"} in USD and left out of the totals until the USD rate is set in Setup.</div>` : ""; };
  const stat = (k, v, sub, cls) => `<div class="cf-stat ${cls || ""}"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
  const excelBar = () => `<span class="cf-group"><button class="btn small" data-cf="xl-down" title="A workbook with dropdowns and checks, filled with the current data">Download Excel</button><label class="btn small" title="Fill the workbook, then upload it here">Upload Excel<input type="file" id="cfUpload" accept=".xlsx,.xls" hidden></label></span>`;

  // ---------------- page shell ----------------
  function renderCash() {
    if (!canSee()) return `<div class="cf"><div class="empty"><b>Cash flow</b>Cash flow is shown to Group Finance, the Finance departments of the business units, Group Strategy and the executive.</div></div>`;
    subscribe();
    const seeTabs = TABS.filter((t) => t[2] === "see"), enterTabs = TABS.filter((t) => t[2] === "enter");
    const tab = (t) => `<button class="cf-tab${S.view === t[0] ? " on" : ""}" data-cf="view" data-v="${t[0]}">${t[1]}</button>`;
    const nav = `<div class="cf-nav"><div class="cf-tabs"><span class="cf-lab">See</span>${seeTabs.map(tab).join("")}</div><div class="cf-tabs"><span class="cf-lab">Enter</span>${enterTabs.map(tab).join("")}</div></div>`;
    const body = { summary: renderSummary, report: renderReport, log: renderLog, items: renderItems, plan: renderPlan, setup: renderSetup }[S.view]();
    return `<div class="cf">${nav}${S.loaded < 3 ? `<div class="small muted cf-pad">Loading…</div>` : ""}${body}</div>`;
  }

  // ---------------- Summary ----------------
  function renderSummary() {
    const units = scopeUnits(), asOf = S.asOf, pos = position(inScope(units, asOf), effBank(), typesEff(), asOf, units, { fx: fx() }), t = pos.total, fu = funding(pos);
    const days = bankDays(effBank(), units).filter((d) => d <= asOf), last = days[days.length - 1] || "", sel = [1, 2, 3].filter((b) => S.bk[b]);
    const lastB = sel.length ? sel[sel.length - 1] : 0, endBal = lastB ? t.b[lastB - 1] : t.bank;
    const stepHead = sel.map((b) => `<th>After ${b} − ${b}${b}</th>`).join("");
    const row = (r, tot) => `<tr class="${tot ? "tot" : ""}${r.need > 0 ? " cf-bad" : ""}"><td><b>${tot ? "Total" : esc(uname(r.unit))}</b>${!tot && !r.hasBank ? '<div class="small muted">no bank balance yet</div>' : !tot && r.bankDay && r.bankDay !== last ? `<div class="small muted">bank as of ${esc(dShort(r.bankDay))}</div>` : ""}</td>
      <td class="num">${money(r.bank)}</td>${sel.map((b) => `<td class="num"><b>${money(r.b[b - 1], false)}</b><div class="small muted">+${compact(r.c[b - 1])} · −${compact(r.p[b - 1])}</div></td>`).join("")}<td class="num">${r.need > 0 ? `<b class="neg">${plain(r.need)}</b>` : '<span class="muted">–</span>'}</td></tr>`;
    const hasData = pos.rows.some((r) => r.hasBank || r.c.some(Boolean) || r.p.some(Boolean));
    const fund = !hasData ? "" : t.need > 0
      ? `<p class="lead"><b>The group would fall to ${money(Math.min(...t.b.slice(0, Math.max(1, lastB))), false)} at its lowest.</b> That is the amount to finance from outside the group, once the units use each other's spare cash.</p>`
      : fu.short.length ? `<p class="lead"><b>The group stays positive, but ${fu.short.length} unit${fu.short.length > 1 ? "s run" : " runs"} short.</b> Units with spare cash can cover them, for example by a sister company loan.</p>`
      : `<p class="lead"><b>No deficit.</b> Every unit stays above zero in the steps shown.</p>`;
    const fundDetail = !hasData || !(fu.short.length || fu.rich.length) ? "" : `${fu.short.length ? `<div class="small">Short: ${fu.short.map((r) => `<b>${esc(ushort(r.unit))}</b> needs ${plain(r.need)}`).join(" · ")}</div>` : ""}${fu.rich.length ? `<div class="small">Spare cash: ${fu.rich.map((r) => `<b>${esc(ushort(r.unit))}</b> ${plain(r.spare)}`).join(" · ")}</div>` : ""}${fu.short.length ? `<div class="small">Covered inside the group: <b>${plain(Math.min(fu.internal, fu.spare))}</b>. Needs outside financing or later payment dates: <b class="${fu.external > 0 ? "neg" : ""}">${plain(fu.external)}</b>.</div>` : ""}`;
    return `<div class="cf-body">
      <div class="cf-filters"><label class="small muted">As of <input type="date" data-cfc="asOf" value="${esc(asOf)}"></label><button class="btn small" data-cf="today">Today</button>${allUnits().length > 1 ? unitSel(S.scope) : ""}${urgencyChips()}${typeToggles()}</div>
      ${usdWarn()}
      <div class="cf-stats">${stat("Bank balance", compact(t.bank), last ? "as of " + dShort(last) : "none entered")}${stat("To collect", compact(sum(sel, (b) => t.c[b - 1])), sel.map((b) => `${b}: ${compact(t.c[b - 1])}`).join(" · ") || "no urgency chosen", "good")}${stat("To pay", compact(sum(sel, (b) => t.p[b - 1])), sel.map((b) => `${b}${b}: ${compact(t.p[b - 1])}`).join(" · ") || "no urgency chosen", "warn")}${stat("Balance at the end", `<span class="${endBal < 0 ? "neg" : ""}">${compact(endBal)}</span>`, sel.length ? `after ${lastB} − ${lastB}${lastB}` : "bank only")}${stat("Financing needed", t.need > 0 ? `<span class="neg">${compact(t.need)}</span>` : "None", "from outside the group", t.need > 0 ? "bad" : "")}</div>
      <section class="cf-card"><h3>Position, step by step</h3><div class="small muted">The bank balance, plus what is collected, minus what is paid. <b>1 − 11</b> within a month, <b>2 − 22</b> within two months, <b>3 − 33</b> long term. Use the 1 · 2 · 3 buttons above to focus.</div>
        ${hasData ? `<div class="scroll"><table class="cf-table"><thead><tr><th>Unit</th><th>Bank</th>${stepHead}<th>Financing need</th></tr></thead><tbody>${pos.rows.map((r) => row(r)).join("")}${pos.rows.length > 1 ? row({ ...t, unit: "all" }, true) : ""}</tbody></table></div>` : `<div class="empty"><b>Nothing to show yet</b>Add bank balances and collections and payments under Enter.</div>`}
        ${t.skipped ? `<div class="small muted">Not counted (types switched off in “Counted types”): ${plain(t.skipped)}.</div>` : ""}</section>
      ${hasData ? `<section class="cf-card"><h3>Deficit and how to finance it</h3>${fund}${fundDetail}${writableUnits().length && t.need > 0 ? `<div class="toolbar"><button class="btn" data-cf="plan-fin">Add a financing line to the plan</button></div>` : ""}</section>` : ""}
      <section class="cf-card"><div class="cf-split"><h3>Bank balance by day</h3><span class="cf-group">${[30, 60, 90, 0].map((n) => chip(S.range === n, `data-cf="range" data-v="${n}"`, n ? n + " days" : "All")).join("")}</span></div>${chart(units, asOf)}</section></div>`;
  }
  let pts = [];
  function chart(units, asOf) {
    let days = bankDays(effBank(), units).filter((d) => d <= asOf); if (S.range) days = days.filter((d) => d >= addDays(asOf, -S.range));
    if (days.length < 2) { pts = []; return '<div class="small muted">Not enough days of bank balances yet.</div>'; }
    const effB = effBank(), vals = days.map((d) => sum(units, (u) => bankAt(effB, u, d).total)), max = Math.max(...vals), min = Math.min(0, ...vals), W = 760, H = 220, L = 8, R = 8, T = 12, B = 22, rng = max - min || 1;
    pts = days.map((d, i) => ({ d, v: vals[i], x: L + (i / (days.length - 1)) * (W - L - R), y: T + (1 - (vals[i] - min) / rng) * (H - T - B) }));
    const zero = T + (1 - (0 - min) / rng) * (H - T - B), grid = [0, 0.5, 1].map((f) => { const y = T + (1 - f) * (H - T - B); return `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="cf-grid"/><text x="${W - R}" y="${y - 3}" text-anchor="end" class="cf-axis">${compact(min + f * rng)}</text>`; }).join("");
    return `<div class="cf-chartwrap"><svg viewBox="0 0 ${W} ${H}" class="cf-chart" role="img" aria-label="Bank balance by day. Move over the line to see the amount.">${grid}${min < 0 ? `<line x1="${L}" x2="${W - R}" y1="${zero}" y2="${zero}" class="cf-zero"/>` : ""}
      <polyline fill="none" class="cf-line" points="${pts.map((p) => p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ")}"/>
      <text x="${L}" y="${H - 4}" class="cf-axis">${esc(dShort(pts[0].d))}</text><text x="${W - R}" y="${H - 4}" text-anchor="end" class="cf-axis">${esc(dShort(pts[pts.length - 1].d))}</text>
      <line class="cf-guide" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/><circle class="cf-dot" r="5" cx="0" cy="0" style="display:none"/></svg><div class="cf-tip" style="display:none"></div></div>`;
  }
  function hover(e) {
    const svg = e.target.closest && e.target.closest(".cf-chart"); if (!svg || !pts.length) return;
    const r = svg.getBoundingClientRect(), W = svg.viewBox.baseVal.width, x = ((e.clientX - r.left) / r.width) * W;
    let best = pts[0]; for (const p of pts) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
    const g = svg.querySelector(".cf-guide"), d = svg.querySelector(".cf-dot"), tip = svg.parentElement.querySelector(".cf-tip");
    g.setAttribute("x1", best.x); g.setAttribute("x2", best.x); g.style.display = ""; d.setAttribute("cx", best.x); d.setAttribute("cy", best.y); d.style.display = "";
    tip.innerHTML = `<b>${esc(dShort(best.d))}</b><br>${plain(best.v)}`; tip.style.display = "";
    const px = (best.x / W) * r.width; tip.style.left = Math.min(Math.max(px - 40, 0), r.width - 110) + "px"; tip.style.top = Math.max(((best.y / svg.viewBox.baseVal.height) * r.height) - 52, 0) + "px";
  }
  function unhover(e) { const w = e.target.closest && e.target.closest(".cf-chartwrap"); if (w) { w.querySelector(".cf-guide").style.display = "none"; w.querySelector(".cf-dot").style.display = "none"; w.querySelector(".cf-tip").style.display = "none"; } }

  // ---------------- Report ----------------
  function renderReport() {
    const units = scopeUnits(), asOf = S.asOf, mode = S.mode, label = mode === "day" ? "Day" : mode === "month" ? "Month" : "Quarter";
    const keys = periods(asOf, mode), cur = keyOf(asOf, mode), mb = (m, l) => chip(mode === m, `data-cf="mode" data-v="${m}"`, l);
    // planned against done, from the collections and payments lines and the daily log
    const rows = Object.fromEntries(keys.map((k) => [k, { pIn: 0, pOut: 0, dIn: 0, dOut: 0, oIn: 0, oOut: 0 }]));
    const tOn = typesEff();
    for (const it of S.items) {
      if (!units.includes(it.unit) || !S.bk[it.bucket]) continue;
      const tt = tOn.find((t) => t.code === it.typeCode); if (tt && tt.expected === false) continue;
      const v = etb(it, fx()), pk = keyOf(planDate(it, it.enteredOn || asOf), mode), pr = rows[pk]; if (pr) pr[it.kind === "in" ? "pIn" : "pOut"] += v;
      const lg = S.log.filter((l) => l.itemId === it.id);
      if (lg.length) lg.forEach((l) => { const r = rows[keyOf(l.day, mode)]; if (r && l.day <= asOf) r[l.kind === "in" ? "dIn" : "dOut"] += etb(l, fx()); });
      else if (it.status === "settled" && it.settledOn) { const r = rows[keyOf(it.settledOn, mode)]; if (r && it.settledOn <= asOf) r[it.kind === "in" ? "dIn" : "dOut"] += v; }
    }
    for (const l of S.log) if (units.includes(l.unit) && !l.itemId && l.day <= asOf) { const r = rows[keyOf(l.day, mode)]; if (r) r[l.kind === "in" ? "oIn" : "oOut"] += etb(l, fx()); }
    const past = keys.filter((k) => k < cur).slice(-3), rate = (a, b) => { const p = sum(past, (k) => rows[k][b]), d = sum(past, (k) => rows[k][a]); return p > 0 ? Math.min(1.5, d / p) : null; };
    const rIn = rate("dIn", "pIn"), rOut = rate("dOut", "pOut");
    const body = keys.map((k) => { const r = rows[k], isPast = k < cur; return `<tr class="${isPast ? "" : "fut"}${k === cur ? " cf-now" : ""}"><td><b>${esc(periodLabel(k, mode))}</b>${k === cur ? ' <span class="tag">now</span>' : ""}</td>
      <td class="num">${money(r.pIn)}</td><td class="num">${isPast || k === cur ? money(r.dIn) : '<span class="muted">–</span>'}</td><td class="num">${isPast || k === cur ? pct(r.dIn, r.pIn) : ""}</td>
      <td class="num">${money(r.pOut)}</td><td class="num">${isPast || k === cur ? money(r.dOut) : '<span class="muted">–</span>'}</td><td class="num">${isPast || k === cur ? pct(r.dOut, r.pOut) : ""}</td>
      <td class="num">${money(r.oIn - r.oOut)}</td></tr>`; }).join("");
    // forecast: expected from open lines, with the usual follow-through applied
    const tl = timeline(inScope(units, asOf), effBank(), S.plan, typesEff(), asOf, units, mode, { fx: fx() }), act = actuals(units, asOf, mode);
    let adj = tl.start; const fcRows = tl.rows.map((r) => { const a = act[r.key] || { in: 0, out: 0 }, hasAct = r.past || r.now;
      let adjIn = null, adjOut = null; if (!r.past) { adjIn = rIn === null ? r.projIn : r.projIn * rIn; adjOut = rOut === null ? r.projOut : r.projOut * rOut; adj += adjIn - adjOut; }
      return `<tr class="${r.past ? "dim" : ""}${r.now ? " cf-now" : ""}"><td><b>${esc(r.label)}</b></td><td class="num">${hasAct && (a.in || a.out) ? money(a.in) : '<span class="muted">–</span>'}</td><td class="num">${hasAct && (a.in || a.out) ? money(a.out) : '<span class="muted">–</span>'}</td>
        <td class="num">${r.past ? '<span class="muted">–</span>' : money(r.projIn)}</td><td class="num">${r.past ? '<span class="muted">–</span>' : money(r.projOut)}</td>
        <td class="num strong">${r.closing === null ? '<span class="muted">–</span>' : money(r.closing, false)}</td><td class="num">${r.past ? "" : money(adj, false)}</td></tr>`; }).join("");
    // monthly plan lines against the money that moved
    const pm = mode === "day" ? null : (() => { const m = {}; for (const pl of S.plan) { if (!units.includes(pl.unit)) continue; const k = keyOf(pl.month + "-01", mode); if (!keys.includes(k)) continue; (m[k] = m[k] || { in: 0, out: 0 })[pl.kind] += num(pl.amount); } return m; })();
    const planTbl = pm && Object.keys(pm).length ? `<section class="cf-card"><h3>Cash flow plan against actual</h3><div class="small muted">The monthly plan finance prepared, against the cash that really moved (daily log, or the bank report for earlier days).</div><div class="scroll"><table class="cf-table"><thead><tr><th>${label}</th><th>Plan in</th><th>Actual in</th><th>%</th><th>Plan out</th><th>Actual out</th><th>%</th></tr></thead><tbody>${keys.filter((k) => pm[k] || (act[k] && k <= cur)).map((k) => { const p = pm[k] || { in: 0, out: 0 }, a = act[k] || { in: 0, out: 0 }, show = k <= cur;
      return `<tr class="${k === cur ? "cf-now" : ""}"><td><b>${esc(periodLabel(k, mode))}</b></td><td class="num">${money(p.in)}</td><td class="num">${show ? money(a.in) : '<span class="muted">–</span>'}</td><td class="num">${show ? pct(a.in, p.in) : ""}</td><td class="num">${money(p.out)}</td><td class="num">${show ? money(a.out) : '<span class="muted">–</span>'}</td><td class="num">${show ? pct(a.out, p.out) : ""}</td></tr>`; }).join("")}</tbody></table></div></section>` : "";
    // by bank, for the month to date
    const from = asOf.slice(0, 8) + "01", bankRows = {}; for (const l of S.log) if (units.includes(l.unit) && l.day >= from && l.day <= asOf) { const k = l.unit + "|" + (l.bank || "No bank"); (bankRows[k] = bankRows[k] || { unit: l.unit, bank: l.bank || "No bank", in: 0, out: 0 })[l.kind] += etb(l, fx()); }
    const bkList = Object.values(bankRows).sort((a, b) => a.unit.localeCompare(b.unit) || a.bank.localeCompare(b.bank));
    return `<div class="cf-body"><div class="cf-filters"><label class="small muted">As of <input type="date" data-cfc="asOf" value="${esc(asOf)}"></label><button class="btn small" data-cf="today">Today</button>${allUnits().length > 1 ? unitSel(S.scope) : ""}${urgencyChips()}${typeToggles()}<span class="cf-group">${mb("day", "Daily")}${mb("month", "Monthly")}${mb("quarter", "Quarterly")}</span><button class="btn small" data-cf="xl-report" style="margin-left:auto">Download Excel</button></div>
      ${usdWarn()}
      <section class="cf-card"><h3>Planned against done</h3><div class="small muted">Planned: collections and payments due in the period (full amount of each line). Done: cash recorded in the daily log against those lines. “Not in plan” is cash that moved without a line.${rIn !== null || rOut !== null ? ` In the last ${past.length} period${past.length > 1 ? "s" : ""}, <b>${rIn === null ? "–" : Math.round(rIn * 100) + "%"}</b> of planned collections arrived and <b>${rOut === null ? "–" : Math.round(rOut * 100) + "%"}</b> of planned payments went out. The forecast below uses this.` : ""}</div>
        <div class="scroll"><table class="cf-table"><thead><tr><th>${label}</th><th>Collect: planned</th><th>done</th><th>%</th><th>Pay: planned</th><th>done</th><th>%</th><th>Not in plan (net)</th></tr></thead><tbody>${body}</tbody></table></div></section>
      <section class="cf-card"><h3>Forecast</h3><div class="small muted">Actual in and out for periods that have started. Expected comes from the open lines (placed on their expected date, or about 30, 60 or 120 days ahead by code). The last column applies the follow-through above to the expected amounts.</div>
        <div class="scroll"><table class="cf-table"><thead><tr><th>${label}</th><th>Actual in</th><th>Actual out</th><th>Expected in</th><th>Expected out</th><th>Balance, as expected</th><th>Balance, adjusted</th></tr></thead><tbody>${fcRows}</tbody></table></div></section>
      ${planTbl}
      <section class="cf-card"><h3>By type</h3><div class="small muted">Open lines as of ${esc(dShort(asOf))}. Click a row to see its lines.</div>${typeTable(units, "in", "Collections")}${typeTable(units, "out", "Payments")}</section>
      ${bkList.length ? `<section class="cf-card"><h3>Cash moved by bank, ${esc(dShort(from))} to ${esc(dShort(asOf))}</h3><div class="scroll"><table class="cf-table"><thead><tr><th>Unit</th><th>Bank</th><th>In</th><th>Out</th><th>Net</th></tr></thead><tbody>${bkList.map((r) => `<tr><td>${esc(ushort(r.unit))}</td><td>${esc(r.bank)}</td><td class="num">${money(r.in)}</td><td class="num">${money(r.out)}</td><td class="num">${money(r.in - r.out, false)}</td></tr>`).join("")}</tbody></table></div></section>` : ""}</div>`;
  }
  function typeTable(units, kind, title) {
    const eff = inScope(units, S.asOf), rows = byType(eff, typesEff(), S.asOf, units, kind, { fx: fx() }); if (!rows.length) return "";
    const tot = { byUnit: {}, byBucket: [0, 0, 0], total: 0, n: 0 }; rows.forEach((r) => { tot.total += r.total; tot.n += r.n; r.byBucket.forEach((v, i) => (tot.byBucket[i] += v)); Object.entries(r.byUnit).forEach(([u, v]) => (tot.byUnit[u] = (tot.byUnit[u] || 0) + v)); });
    const cell = (r) => `${units.length > 1 ? units.map((u) => `<td class="num">${money(r.byUnit[u])}</td>`).join("") : ""}${[1, 2, 3].map((b) => (S.bk[b] ? `<td class="num">${money(r.byBucket[b - 1])}</td>` : "")).join("")}<td class="num strong">${money(r.total)}</td>`;
    return `<h4>${title}</h4><div class="scroll"><table class="cf-table"><thead><tr><th>Type</th><th>Lines</th>${units.length > 1 ? units.map((u) => `<th>${esc(ushort(u))}</th>`).join("") : ""}${[1, 2, 3].map((b) => (S.bk[b] ? `<th>${kind === "in" ? b : b + "" + b}</th>` : "")).join("")}<th>Total</th></tr></thead><tbody>
      ${rows.map((r) => { const t = typeByCode(r.code); return `<tr class="clickable${r.code ? "" : " cf-bad"}" data-cf="cat-open" data-kind="${kind}" data-code="${esc(r.code || "__none")}" tabindex="0" title="${esc(t ? t.description || t.label : "Choose a type for these lines")}"><td><b>${esc(r.code || "No type")}</b>${t && t.label && t.label !== t.code ? `<div class="small muted">${esc(t.label)}</div>` : ""}</td><td class="num small">${r.n}</td>${cell(r)}</tr>`; }).join("")}
      <tr class="tot"><td><b>Total</b></td><td class="num small">${tot.n}</td>${cell(tot)}</tr></tbody></table></div>`;
  }

  // ---------------- Daily log: one sheet for the day ----------------
  // Enter the day's cash against the planned lines (amount + bank on the line itself), add anything that was not planned, check the bank closing, save.
  // "500000+250000" or "1,200,000" -> number; NaN when it is not a number or a sum of numbers
  const sumExpr = (t) => { const v = String(t ?? "").replace(/[\s,]/g, ""); if (!v) return 0; const parts = v.split("+"); let n = 0; for (const p of parts) { if (!/^\d*\.?\d+$/.test(p)) return NaN; n += Number(p); } return n; };
  const draftOf = (it) => { const d = S.dr[it.id] || {}; return { amt: d.amt ?? "", bank: d.bank ?? lastBank(it.unit, it.kind) }; };
  const draftCount = () => Object.entries(S.dr).filter(([id, d]) => num(d.amt) > 0 && S.items.some((i) => i.id === id)).length;
  function renderLog() {
    const units = scopeUnits(), day = S.day, q = S.dq.q.trim().toLowerCase(), kindF = S.dq.kind;
    const rows = S.log.filter((l) => l.day === day && units.includes(l.unit)).sort((a, b) => a.unit.localeCompare(b.unit) || b.kind.localeCompare(a.kind) || (a.bank || "").localeCompare(b.bank || ""));
    const totIn = sum(rows.filter((r) => r.kind === "in"), (r) => etb(r, fx())), totOut = sum(rows.filter((r) => r.kind === "out"), (r) => etb(r, fx()));
    const todayOf = (id) => rows.filter((l) => l.itemId === id);
    const lines = effItems(day).filter((it) => it.status === "open" && units.includes(it.unit) && canWrite(it.unit) && (!kindF || it.kind === kindF) && (!q || `${it.code} ${it.party} ${it.description} ${it.ref} ${it.typeCode}`.toLowerCase().includes(q)))
      .sort((a, b) => (todayOf(b.id).length ? 1 : 0) - (todayOf(a.id).length ? 1 : 0) || (S.dr[b.id] && num(S.dr[b.id].amt) > 0 ? 1 : 0) - (S.dr[a.id] && num(S.dr[a.id].amt) > 0 ? 1 : 0) || a.bucket - b.bucket || etb(b, fx()) - etb(a, fx()));
    const shown = lines.slice(0, S.dq.show), n = draftCount();
    const bankSel = (it, d) => { const banks = knownBanks(it.unit), cur = d.bank && !banks.includes(d.bank) ? [d.bank, ...banks] : banks; return banks.length || d.bank ? `<select class="cf-bank" data-dr="bank" data-id="${esc(it.id)}" aria-label="Bank">${cur.map((b) => `<option ${b === d.bank ? "selected" : ""}>${esc(b)}</option>`).join("")}</select>` : `<span class="small muted">add a bank below</span>`; };
    const sheet = shown.map((it) => { const d = draftOf(it), done = todayOf(it.id), over = num(d.amt) > num(it.amount) + 0.005;
      return `<tr class="${num(d.amt) > 0 ? "cf-fill" : ""}"><td><span class="tag">${esc(it.code || "")}</span></td><td><b>${esc(it.party || it.description || "")}</b>${it.party && it.description ? `<div class="small muted">${esc(it.description)}</div>` : ""}
        ${done.length ? `<div class="cf-pills">${done.map((l) => `<button type="button" class="cf-pill" data-cf="log-open" data-id="${esc(l.id)}" title="Recorded today. Click to edit">${it.kind === "in" ? "+" : "−"}${plain(l.amount)} · ${esc(l.bank || "")}</button>`).join("")}</div>` : ""}</td>
        <td class="small" title="${esc(typeHint(it.typeCode))}">${esc(it.typeCode || "No type")}</td><td><span class="pill ${it.kind === "in" ? "s-done" : "s-not"}">${it.kind === "in" ? "Collect" : "Pay"}</span> <span class="small muted">${bucketCode(it.kind, it.bucket)}</span></td>
        <td class="num">${money(it.amount, false)}${it.currency !== "ETB" ? ` <span class="tag">${esc(it.currency)}</span>` : ""}</td>
        <td class="num"><input type="number" min="0" step="any" class="cf-amt${over ? " over" : ""}" data-dr="amt" data-id="${esc(it.id)}" value="${esc(String(d.amt))}" placeholder="0" aria-label="Cash today"></td><td>${bankSel(it, d)}</td></tr>`; }).join("");
    // bank movements for the day: opening (yesterday's closing), what came in, what went out, closing. In and out are the bank's day totals.
    const eb = effBank(), bkRows = []; for (const u of units) { const banks = [...new Set([...knownBanks(u), ...rows.filter((r) => r.unit === u && r.bank).map((r) => r.bank)])]; for (const bk of banks) {
      const prev = eb.filter((b) => b.unit === u && b.bank === bk && b.day < day).sort((a, b) => b.day.localeCompare(a.day))[0], saved = S.bank.find((b) => b.unit === u && b.bank === bk && b.day === day);
      const mine = rows.filter((r) => r.unit === u && r.bank === bk), itIn = sum(mine.filter((r) => r.kind === "in"), (r) => num(r.amount)), itOut = sum(mine.filter((r) => r.kind === "out"), (r) => num(r.amount));
      const key = `${u}|${bk}|${day}`, d = S.bd[key] || {}, opening = prev ? num(prev.closing) : saved ? num(saved.opening) : num(d.open);
      const inn = d.in !== undefined ? d.in : saved ? num(saved.inflow) : itIn || "", out = d.out !== undefined ? d.out : saved ? num(saved.outflow) : itOut || "";
      const nIn = sumExpr(inn) || 0, nOut = sumExpr(out) || 0, calc = opening + nIn - nOut, close = d.close !== undefined ? d.close : saved ? num(saved.closing) : Math.round(calc * 100) / 100;
      bkRows.push({ unit: u, bank: bk, key, opening, hasPrev: !!prev, inn, out, nIn, nOut, close, calc, saved, itIn, itOut }); } }
    const bkHtml = bkRows.map((b) => { const w = canWrite(b.unit), restIn = b.nIn - b.itIn, restOut = b.nOut - b.itOut, trace = (v, rest) => (!(sumExpr(v) > 0) ? "" : `<div class="small ${rest < -0.5 ? "neg" : "muted"}">${rest < -0.5 ? "itemized " + plain(-rest) + " more than the total" : rest > 0.5 ? plain(rest) + " not itemized yet" : "all itemized"}</div>`);
      return `<tr data-bkkey="${esc(b.key)}"><td class="small">${esc(ushort(b.unit))}</td><td><b>${esc(b.bank)}</b></td>
        <td class="num">${b.hasPrev || b.saved ? plain(b.opening) : `<input type="number" step="any" class="cf-bk" data-bd="open" data-key="${esc(b.key)}" value="${esc(String(b.opening || ""))}" ${w ? "" : "disabled"} aria-label="Opening">`}</td>
        <td class="num"><input type="text" inputmode="decimal" class="cf-bk" data-bd="in" data-key="${esc(b.key)}" value="${esc(String(b.inn))}" placeholder="0" ${w ? "" : "disabled"} aria-label="Total in">${trace(b.inn, restIn)}</td>
        <td class="num"><input type="text" inputmode="decimal" class="cf-bk" data-bd="out" data-key="${esc(b.key)}" value="${esc(String(b.out))}" placeholder="0" ${w ? "" : "disabled"} aria-label="Total out">${trace(b.out, restOut)}</td>
        <td class="num"><input type="number" step="any" class="cf-bk" data-bd="close" data-key="${esc(b.key)}" value="${esc(String(b.close))}" ${w ? "" : "disabled"} aria-label="Closing balance"><div class="small cf-bkchk">${Math.abs(num(b.close) - b.calc) > 0.5 ? `<span class="neg">opening + in − out is ${plain(b.calc)}</span>` : b.saved ? '<span class="ok">saved</span>' : '<span class="muted">not saved</span>'}</div></td></tr>`; }).join("");
    const bkTot = { open: sum(bkRows, (b) => b.opening), inn: sum(bkRows, (b) => b.nIn), out: sum(bkRows, (b) => b.nOut), close: sum(bkRows, (b) => num(b.close)) };
    const other = rows.filter((l) => !l.itemId);
    const otherHtml = other.map((l) => `<tr class="clickable" data-cf="log-open" data-id="${esc(l.id)}" tabindex="0"><td class="small">${esc(ushort(l.unit))}</td><td><span class="pill ${l.kind === "in" ? "s-done" : "s-not"}">${l.kind === "in" ? "In" : "Out"}</span></td><td>${esc(l.bank || "")}</td><td><b>${esc(l.party || l.description || "")}</b>${l.party && l.description ? `<div class="small muted">${esc(l.description)}</div>` : ""}</td><td class="num">${money(l.amount, false)}</td></tr>`).join("");
    const w = writableUnits().length > 0;
    return `<div class="cf-body"><div class="cf-filters"><label class="small muted">Day <input type="date" data-cfc="day" value="${esc(day)}"></label><button class="btn small" data-cf="day-shift" data-v="-1" aria-label="Previous day">‹</button><button class="btn small" data-cf="day-shift" data-v="1" aria-label="Next day">›</button><button class="btn small" data-cf="day-today">Today</button>${allUnits().length > 1 ? unitSel(S.scope) : ""}<span style="margin-left:auto" class="cf-group">${excelBar()}</span></div>
      <section class="cf-card"><div class="cf-split"><div><h3>Bank movements, ${esc(dShort(day))}</h3><div class="small muted">Per bank: what the account held at the start, the total that came in, the total that went out, and the closing. Enter the day's totals from the bank report, now or the next morning. To add several amounts, type them with a plus, for example <b>500000+250000</b>. Opening is yesterday's closing.</div></div>${w ? `<span class="cf-group"><button class="btn" data-cf="bank-new">+ Bank account</button><button class="btn primary" data-cf="bk-save" ${bkRows.length ? "" : "disabled"}>Save day</button></span>` : ""}</div>
        ${bkRows.length ? `<div class="scroll"><table class="cf-table cf-bktable"><thead><tr><th>Unit</th><th>Bank</th><th>Opening</th><th>In</th><th>Out</th><th>Closing</th></tr></thead><tbody>${bkHtml}<tr class="tot"><td colspan="2"><b>Total</b></td><td class="num">${plain(bkTot.open)}</td><td class="num" id="cfTotIn">${plain(bkTot.inn)}</td><td class="num" id="cfTotOut">${plain(bkTot.out)}</td><td class="num" id="cfTotClose">${plain(bkTot.close)}</td></tr></tbody></table></div>` : `<div class="empty"><b>No bank accounts yet</b>${w ? `Press “+ Bank account” to add the first balance.` : ""}</div>`}</section>
      <section class="cf-card"><div class="cf-split"><div><h3>Trace the cash to collections and payments</h3><div class="small muted">The bank totals above cannot show who paid or was paid. Itemize them here: type the amount next to the line and choose the bank. Do it in as many rounds as you need; each save adds entries. Several movements on the same line: save, then enter again.</div></div>${w ? `<button class="btn primary" data-cf="dr-save" ${n ? "" : "disabled"} id="cfDrSave">${n ? `Save ${n} entr${n > 1 ? "ies" : "y"}` : "Save entries"}</button>` : ""}</div>
        <div class="cf-filters" style="margin:8px 0"><span class="cf-group">${chip(!kindF, 'data-cf="dkind" data-v=""', "All")}${chip(kindF === "in", 'data-cf="dkind" data-v="in"', "Collections")}${chip(kindF === "out", 'data-cf="dkind" data-v="out"', "Payments")}</span><input type="search" data-cfd="q" placeholder="Search party, code, type" value="${esc(S.dq.q)}" aria-label="Search"><span class="small muted">${lines.length} open line${lines.length === 1 ? "" : "s"}</span></div>
        ${shown.length ? `<div class="scroll"><table class="cf-table cf-list cf-sheet"><thead><tr><th>Code</th><th>Party</th><th>Type</th><th></th><th title="Total minus collected or paid so far">Remaining</th><th>Cash today</th><th>Bank</th></tr></thead><tbody>${sheet}</tbody></table></div>${lines.length > shown.length ? `<div class="toolbar"><button class="btn" data-cf="dmore">Show more</button></div>` : ""}` : `<div class="empty"><b>No open lines${q ? " match" : ""}</b>${q ? "Clear the search." : "Add lines under Collections and payments."}</div>`}</section>
      <section class="cf-card"><div class="cf-split"><div><h3>Other cash that moved</h3><div class="small muted">Money that was not in a planned line.</div></div>${w ? `<button class="btn" data-cf="log-new">+ Add cash movement</button>` : ""}</div>
        ${other.length ? `<div class="scroll"><table class="cf-table"><thead><tr><th>Unit</th><th></th><th>Bank</th><th>Party</th><th>Amount</th></tr></thead><tbody>${otherHtml}</tbody></table></div>` : `<div class="small muted">Nothing.</div>`}</section>
</div>`;
  }

  // ---------------- Collections and payments ----------------
  function filteredItems() {
    const f = S.lf, q = f.q.trim().toLowerCase(), units = scopeUnits();
    return S.items.filter((i) => units.includes(i.unit) && S.bk[i.bucket] && (!f.kind || i.kind === f.kind) && (f.type === "" || (f.type === "__none" ? !i.typeCode : i.typeCode === f.type)) && (f.status === "all" || i.status === f.status)
      && (!q || `${i.code} ${i.party} ${i.description} ${i.ref} ${i.typeCode} ${i.note}`.toLowerCase().includes(q)))
      .sort((a, b) => a.kind.localeCompare(b.kind) * -1 || a.bucket - b.bucket || (PRI_RANK[a.priority] ?? 1) - (PRI_RANK[b.priority] ?? 1) || etb(b, fx()) - etb(a, fx()));
  }
  const typeOptions = (kind, cur, withNew) => { const list = S.types.filter((t) => t.active && (!kind || t.kind === "both" || t.kind === kind)); if (cur && !list.some((t) => t.code === cur)) list.push({ code: cur, label: cur });
    return `<option value="">No type</option>${list.map((t) => `<option value="${esc(t.code)}" ${t.code === cur ? "selected" : ""}>${esc(t.code)}${t.label && t.label !== t.code ? " – " + esc(t.label) : ""}</option>`).join("")}${withNew && canWriteAny() ? `<option value="__new__">+ Add a new type…</option>` : ""}`; };
  function renderItems() {
    const f = S.lf, list = filteredItems(), shown = list.slice(0, f.show), noType = S.items.filter((i) => i.status === "open" && scopeUnits().includes(i.unit) && !i.typeCode).length;
    const rem = (i) => Math.max(0, num(i.amount) - doneOf(i));
    const totIn = sum(list.filter((i) => i.kind === "in" && i.status === "open"), (i) => etb({ ...i, amount: rem(i) }, fx())), totOut = sum(list.filter((i) => i.kind === "out" && i.status === "open"), (i) => etb({ ...i, amount: rem(i) }, fx()));
    const rows = shown.map((i) => { const w = canWrite(i.unit), closed = i.status !== "open", t = typeByCode(i.typeCode), done = doneOf(i), left = Math.max(0, num(i.amount) - done);
      return `<tr class="${closed ? "dim" : ""}"><td><span class="tag">${esc(i.code || "")}</span></td><td class="small">${esc(ushort(i.unit))}</td>
        <td><span class="pill ${i.kind === "in" ? "s-done" : "s-not"}">${i.kind === "in" ? "Collect" : "Pay"}</span> <b>${esc(i.party || "")}</b>${i.description ? `<div class="small muted">${esc(i.description)}</div>` : ""}${i.ref ? `<div class="small muted">Ref ${esc(i.ref)}</div>` : ""}</td>
        <td title="${esc(t ? (t.label && t.label !== t.code ? t.label + ". " : "") + (t.description || "") : "")}">${w && !closed ? `<select class="cf-sel" data-cfq="type" data-id="${esc(i.id)}" aria-label="Type">${typeOptions(i.kind, i.typeCode, true)}</select>` : esc(i.typeCode || "No type")}</td>
        <td class="small" title="${esc(BUCKET_TEXT[i.bucket])}">${bucketCode(i.kind, i.bucket)}</td><td class="num">${money(i.amount, false)}${i.currency !== "ETB" ? ` <span class="tag">${esc(i.currency)}</span>` : ""}</td>
        <td class="num">${done ? `${money(done)}<div class="small muted">${pct(done, i.amount)}</div>` : '<span class="muted">–</span>'}</td>
        <td class="num"><b>${closed ? '<span class="muted">–</span>' : money(left, false)}</b></td>
        <td>${w && !closed ? `<input type="date" class="cf-date" data-cfq="expected" data-id="${esc(i.id)}" value="${esc(i.expected || "")}" aria-label="Expected date">` : esc(dShort(i.expected))}</td>
        <td class="small cf-act">${closed ? `<span class="pill s-done">${i.status === "settled" ? (i.kind === "in" ? "Collected" : "Paid") : "Written off"}</span>` : done > 0 ? `<span class="pill s-not">Part ${i.kind === "in" ? "collected" : "paid"}</span>` : ""}${w ? `<div class="toolbar">${closed ? "" : `<button class="btn small" data-cf="rec" data-id="${esc(i.id)}">${i.kind === "in" ? "Collected" : "Paid"}</button>`}<button class="btn small ghost" data-cf="item-open" data-id="${esc(i.id)}">Edit</button></div>` : ""}</td></tr>`; }).join("");
    return `<div class="cf-body"><div class="cf-filters">${allUnits().length > 1 ? unitSel(S.scope) : ""}<span class="cf-group">${chip(!f.kind, 'data-cf="lkind" data-v=""', "All")}${chip(f.kind === "in", 'data-cf="lkind" data-v="in"', "Collections")}${chip(f.kind === "out", 'data-cf="lkind" data-v="out"', "Payments")}</span>${urgencyChips()}
        <select data-cff="type" aria-label="Type"><option value="">All types</option><option value="__none" ${f.type === "__none" ? "selected" : ""}>No type (${noType})</option>${S.types.map((t) => `<option value="${esc(t.code)}" ${f.type === t.code ? "selected" : ""}>${esc(t.code)}</option>`).join("")}</select>
        <select data-cff="status" aria-label="Status"><option value="open" ${f.status === "open" ? "selected" : ""}>Open</option><option value="settled" ${f.status === "settled" ? "selected" : ""}>Settled</option><option value="written_off" ${f.status === "written_off" ? "selected" : ""}>Written off</option><option value="all" ${f.status === "all" ? "selected" : ""}>All</option></select>
        <input type="search" data-cff="q" placeholder="Search party, code, reference" value="${esc(f.q)}" aria-label="Search"></div>
      <div class="cf-filters"><span class="small muted">${list.length} line${list.length === 1 ? "" : "s"} · left to collect ${plain(totIn)} · left to pay ${plain(totOut)}</span><span style="margin-left:auto" class="cf-group">${excelBar()}${writableUnits().length ? `<button class="btn primary" data-cf="item-new">+ Add a line</button>` : ""}</span></div>
      ${usdWarn()}${noType ? `<div class="cf-note">${noType} open line${noType > 1 ? "s have" : " has"} no type. Choose one so it adds up in the report. <button class="btn small" data-cf="no-type">Show them</button></div>` : ""}
      <section class="cf-card flush">${list.length ? `<div class="scroll"><table class="cf-table cf-items"><thead><tr><th>Code</th><th>Unit</th><th>Party</th><th>Type</th><th title="1 / 11 within a month, 2 / 22 within two months, 3 / 33 long term">Urgency</th><th title="The full amount of the invoice or payable">Total</th><th title="Collected for collections, paid for payments">Collected / paid</th><th title="Total minus collected or paid">Remaining</th><th title="Blank: about 30, 60 or 120 days ahead, by urgency">Expected</th><th class="cf-act"></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${list.length > f.show ? `<div class="toolbar cf-pad"><button class="btn" data-cf="more">Show more</button></div>` : ""}` : `<div class="empty"><b>Nothing here</b>Change the filters, or add a line.</div>`}</section></div>`;
  }

  // ---------------- Plan ----------------
  function renderPlan() {
    const units = scopeUnits(), from = S.pf.from || addMonths(monthOf(S.asOf), -1), plans = S.plan.filter((p) => units.includes(p.unit) && p.month >= from).sort((a, b) => a.month.localeCompare(b.month) || a.unit.localeCompare(b.unit) || a.kind.localeCompare(b.kind));
    const pm = planByMonth(plans, units), mths = pm.months;
    const sec = SECTIONS.slice(0, 3).flatMap(([s, l]) => ["in", "out"].map((k) => { const r = pm.rows[`${s}|${k}`]; return r ? `<tr><td>${l} ${k === "in" ? "inflow" : "outflow"}</td>${mths.map((m) => `<td class="num">${money(r[m])}</td>`).join("")}</tr>` : ""; })).join("");
    const net = `<tr class="tot"><td><b>Net cash flow</b></td>${mths.map((m) => `<td class="num strong">${money(sum(Object.entries(pm.rows), ([k, v]) => (k.endsWith("|in") ? 1 : -1) * num(v[m])), false)}</td>`).join("")}</tr>`;
    return `<div class="cf-body"><div class="cf-filters">${allUnits().length > 1 ? unitSel(S.scope) : ""}<label class="small muted">From <input type="month" data-cfc="pfrom" value="${esc(from)}"></label><span style="margin-left:auto" class="cf-group">${excelBar()}${writableUnits().length ? `<button class="btn primary" data-cf="plan-new">+ Plan line</button>` : ""}</span></div>
      <div class="small muted cf-pad">The monthly plan finance prepares: what is planned to come in and go out, by operating, investing and financing. The Report compares it with the cash that really moved.</div>
      ${mths.length ? `<section class="cf-card"><h3>Plan summary</h3><div class="scroll"><table class="cf-table"><thead><tr><th>Line</th>${mths.map((m) => `<th>${esc(periodLabel(m, "month"))}</th>`).join("")}</tr></thead><tbody>${sec}${net}</tbody></table></div></section>` : ""}
      <section class="cf-card flush">${plans.length ? `<div class="scroll"><table class="cf-table"><thead><tr><th>Month</th><th>Unit</th><th>Section</th><th></th><th>Line</th><th>Amount</th><th></th></tr></thead><tbody>${plans.map((p) => `<tr><td>${esc(periodLabel(p.month, "month"))}</td><td class="small">${esc(ushort(p.unit))}</td><td class="small">${esc((SECTIONS.find((s) => s[0] === p.section) || [])[1] || p.section)}</td><td class="small">${p.kind === "in" ? "Inflow" : "Outflow"}</td><td>${esc(p.label)}</td><td class="num">${money(p.amount, false)}</td><td>${canWrite(p.unit) ? `<button class="btn small ghost" data-cf="plan-open" data-id="${esc(p.id)}">Edit</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><b>No plan lines yet</b>Add the monthly forecast, for example collections expected, payroll, CAPEX or loan repayments.</div>`}</section></div>`;
  }

  // ---------------- Setup ----------------
  function renderSetup() {
    const use = {}; S.items.forEach((i) => { if (i.typeCode) use[i.typeCode] = (use[i.typeCode] || 0) + 1; });
    const unconf = S.types.filter((t) => !t.confirmed).length;
    const rows = [...S.types].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "in" ? -1 : 1) || a.sort - b.sort).map((t) => `<tr class="${t.active ? "" : "dim"}"><td><b>${esc(t.code)}</b></td><td>${esc(t.label)}${!t.label || t.label === t.code ? ' <span class="small muted">no description yet</span>' : ""}<div class="small muted">${esc(t.description || "")}</div></td><td class="small">${t.kind === "in" ? "Collections" : t.kind === "out" ? "Payments" : "Both"}</td>
      <td class="small">${t.expected ? "Yes" : "No"}</td><td class="small">${t.confirmed ? '<span class="pill s-done">Confirmed</span>' : '<span class="pill s-not">To confirm</span>'}</td><td class="num small">${use[t.code] || 0}</td><td>${canWriteAny() ? `<button class="btn small ghost" data-cf="type-open" data-id="${esc(t.id)}">Edit</button>` : ""}</td></tr>`).join("");
    return `<div class="cf-body">${admin() ? `<section class="cf-card"><h3>USD rate</h3><div class="toolbar"><label class="small">1 USD in ETB <input type="number" id="cfFx" min="0" step="any" value="${esc(S.settings.usd_etb || "")}" style="width:120px"></label><button class="btn small" data-cf="fx-save">Save rate</button><span class="small muted">Used to add USD lines and movements into the ETB totals.</span></div></section>` : ""}
      <section class="cf-card"><div class="cf-split"><h3>Types</h3><span class="cf-group"><button class="btn small" data-cf="xl-types">Download list for finance</button>${canWriteAny() ? `<button class="btn primary small" data-cf="type-new">+ Add type</button>` : ""}</span></div>
        <div class="small muted">The list behind the Type dropdown. ${unconf} of ${S.types.length} still to confirm with finance. “Counted” means the type is expected to be collected or paid, so it is included in the position.</div>
        <div class="scroll"><table class="cf-table"><thead><tr><th>Code</th><th>Meaning</th><th>For</th><th>Counted</th><th>Status</th><th>Lines</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section></div>`;
  }

  // ---------------- forms ----------------
  function ensureRoot() {
    let root = document.getElementById("cfModalRoot");
    if (!root) { root = document.createElement("div"); root.id = "cfModalRoot"; document.body.append(root);
      root.addEventListener("click", (e) => { const el = e.target.closest("[data-cf]"); if (el) onAction(el); else if (e.target.classList && e.target.classList.contains("overlay")) closeModal(); });
      root.addEventListener("change", (e) => { const id = e.target.id; if (id === "ci-type" && e.target.value === "__new__") onAction({ dataset: { cf: "type-from-item" } }); else if (id === "cl-code") linkPick(); else if (id === "cl-bank") bankPick(); else if (id === "ci-kind") { readItem(); drawModal(); } });
      root.addEventListener("input", (e) => { if (e.target.id === "cl-code") linkPick(); }); }
    return root;
  }
  function drawModal() {
    const root = ensureRoot(), m = S.m; if (!m) { root.innerHTML = ""; return; }
    const body = { item: itemForm, log: logForm, bank: bankForm, plan: planForm, type: typeForm, result: resultView }[m.type](m);
    root.innerHTML = `<div class="overlay"><div class="modal wide xmodal" role="dialog" aria-modal="true">${body}</div></div>`;
    const first = root.querySelector("input[type=text], input[type=number]"); if (first && m.isNew && !m.focused) { m.focused = true; first.focus(); }
  }
  const closeModal = () => { S.m = null; drawModal(); c.render(); };
  const field = (id, label, inner, wide) => `<div class="field${wide ? " wide" : ""}"><label for="${id}">${label}</label>${inner}</div>`;
  const opt = (list, cur) => list.map((x) => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("");
  const v = (id) => { const e = document.getElementById(id); return e ? e.value : ""; };
  const footer = (m, saveKey, delKey, extra) => `<div class="save-bar"><div class="toolbar">${delKey && !m.isNew ? `<button class="btn danger" data-cf="${delKey}">${m.confirmDel ? "Click again to delete" : "Delete"}</button>` : ""}${extra || ""}</div><div class="toolbar"><button class="btn" data-cf="close">Cancel</button><button class="btn primary" data-cf="${saveKey}">Save</button></div></div>`;
  const unitOpts = (cur) => writableUnits().map((u) => `<option value="${esc(u)}" ${u === cur ? "selected" : ""}>${esc(uname(u))}</option>`).join("");
  const typeHint = (code) => { const t = typeByCode(code); return t ? esc((t.label && t.label !== t.code ? t.label + ". " : "") + (t.description || "")) : ""; };

  function readItem() { const r = S.m.row; Object.assign(r, { unit: v("ci-unit") || r.unit, kind: v("ci-kind") || r.kind, party: v("ci-party").trim(), description: v("ci-desc").trim(), ref: v("ci-ref").trim(), typeCode: v("ci-type") === "__new__" ? r.typeCode : v("ci-type"), bucket: Number(v("ci-bucket")) || 1, amount: v("ci-amt"), currency: v("ci-cur") || "ETB", priority: v("ci-pri"), expected: v("ci-exp"), note: v("ci-note").trim(), status: v("ci-st") || r.status, settledOn: v("ci-sdate") }); }
  function itemForm(m) {
    const r = m.row, logs = r.id ? S.log.filter((l) => l.itemId === r.id).sort((a, b) => a.day.localeCompare(b.day)) : [];
    return `<div class="panel-head"><h2>${m.isNew ? "Add a line" : "Line " + esc(r.code || "")}</h2></div><div class="xgrid">
      ${field("ci-unit", "Unit", `<select id="ci-unit" ${m.isNew ? "" : "disabled"}>${unitOpts(r.unit)}</select>`)}${field("ci-kind", "Collect or pay", `<select id="ci-kind" ${m.isNew ? "" : "disabled"}><option value="in" ${r.kind === "in" ? "selected" : ""}>Collect (money coming in)</option><option value="out" ${r.kind === "out" ? "selected" : ""}>Pay (money going out)</option></select>`)}
      ${field("ci-party", "Customer or payee", `<input type="text" id="ci-party" value="${esc(r.party)}">`)}${field("ci-ref", "Invoice or reference no.", `<input type="text" id="ci-ref" value="${esc(r.ref)}">`)}
      ${field("ci-desc", "Description", `<input type="text" id="ci-desc" value="${esc(r.description)}">`, true)}
      ${field("ci-type", "Type", `<select id="ci-type">${typeOptions(r.kind, r.typeCode, true)}</select>${r.typeCode ? `<div class="small muted">${typeHint(r.typeCode)}</div>` : ""}`)}${field("ci-bucket", "Urgency", `<select id="ci-bucket"><option value="1" ${r.bucket === 1 ? "selected" : ""}>${bucketCode(r.kind, 1)} · within a month</option><option value="2" ${r.bucket === 2 ? "selected" : ""}>${bucketCode(r.kind, 2)} · within two months</option><option value="3" ${r.bucket === 3 ? "selected" : ""}>${bucketCode(r.kind, 3)} · long term</option></select>`)}
      ${field("ci-amt", "Total amount", `<input type="number" id="ci-amt" min="0" step="any" value="${esc(String(r.amount ?? ""))}">`)}${field("ci-cur", "Currency", `<select id="ci-cur">${opt(CURRENCIES, r.currency)}</select>`)}
      ${field("ci-pri", "Priority", `<select id="ci-pri">${opt(PRIORITIES, r.priority)}</select>`)}${field("ci-exp", "Expected date (optional)", `<input type="date" id="ci-exp" value="${esc(r.expected || "")}">`)}
      ${m.isNew ? "" : field("ci-st", "Status", `<select id="ci-st"><option value="open" ${r.status === "open" ? "selected" : ""}>Open</option><option value="settled" ${r.status === "settled" ? "selected" : ""}>${r.kind === "in" ? "Collected" : "Paid"}</option><option value="written_off" ${r.status === "written_off" ? "selected" : ""}>Written off</option></select>`)}${m.isNew ? "" : field("ci-sdate", "Date settled", `<input type="date" id="ci-sdate" value="${esc(r.settledOn || "")}">`)}
      ${field("ci-note", "Note", `<textarea id="ci-note" rows="2">${esc(r.note)}</textarea>`, true)}</div>
      ${logs.length ? `<div class="small" style="margin:8px 0 4px"><b>Cash recorded against this line</b></div><div class="scroll"><table class="cf-table"><tbody>${logs.map((l) => `<tr><td>${esc(dShort(l.day))}</td><td>${esc(l.bank || "")}</td><td class="num">${money(l.amount, false)}</td></tr>`).join("")}<tr class="tot"><td colspan="2"><b>Done</b></td><td class="num">${money(sum(logs, (l) => l.amount), false)}</td></tr></tbody></table></div>` : ""}
      ${footer(m, "item-save", "item-del")}`;
  }
  // a cash movement
  const openLines = (unit, kind) => S.items.filter((i) => i.unit === unit && i.kind === kind && i.status === "open");
  function logForm(m) {
    const r = m.row, banks = knownBanks(r.unit), lines = openLines(r.unit, r.kind), isNewBank = m.newBank || (r.bank && !banks.includes(r.bank));
    return `<div class="panel-head"><h2>${m.isNew ? "Add a cash movement" : "Cash movement"}</h2></div><div class="xgrid">
      ${field("cl-day", "Date", `<input type="date" id="cl-day" value="${esc(r.day)}">`)}${field("cl-unit", "Unit", `<select id="cl-unit">${unitOpts(r.unit)}</select>`)}
      ${field("cl-kind", "In or out", `<select id="cl-kind"><option value="in" ${r.kind === "in" ? "selected" : ""}>In (money received)</option><option value="out" ${r.kind === "out" ? "selected" : ""}>Out (money paid)</option></select>`)}
      ${field("cl-bank", r.kind === "in" ? "Credited to bank" : "Debited from bank", `<select id="cl-bank"><option value="">Choose the bank</option>${banks.map((b) => `<option ${b === r.bank ? "selected" : ""}>${esc(b)}</option>`).join("")}<option value="__new__" ${isNewBank ? "selected" : ""}>+ New bank…</option></select>${isNewBank ? `<input type="text" id="cl-newbank" placeholder="Bank name" value="${esc(banks.includes(r.bank) ? "" : r.bank)}" style="margin-top:6px">` : ""}`)}
      ${field("cl-amt", "Amount", `<input type="number" id="cl-amt" min="0" step="any" value="${esc(String(r.amount ?? ""))}">`)}${field("cl-cur", "Currency", `<select id="cl-cur">${opt(CURRENCIES, r.currency)}</select>`)}
      ${field("cl-code", "Planned line (optional)", `<input type="text" id="cl-code" list="cl-lines" value="${esc(r.itemCode || "")}" placeholder="Type or pick a code, e.g. CF-00012" autocomplete="off"><datalist id="cl-lines">${lines.map((i) => `<option value="${esc(i.code)}" label="${esc((i.party || i.description || "") + " · left " + plain(Math.max(0, num(i.amount) - loggedFor(i.id, null, r.id))) + " " + i.currency)}"></option>`).join("")}</datalist><div class="small muted" id="cl-hint">${linkHint(r)}</div>`, true)}
      ${field("cl-party", "Party", `<input type="text" id="cl-party" value="${esc(r.party)}">`)}${field("cl-type", "Type", `<select id="cl-type">${typeOptions(r.kind, r.typeCode, false)}</select>`)}
      ${field("cl-desc", "Description", `<input type="text" id="cl-desc" value="${esc(r.description)}">`, true)}${field("cl-note", "Note", `<input type="text" id="cl-note" value="${esc(r.note || "")}">`, true)}</div>${footer(m, "log-save", "log-del")}`;
  }
  function linkHint(r) { const it = r.itemId ? S.items.find((i) => i.id === r.itemId) : null; if (!it) return r.itemCode ? '<span class="neg">No open line has this code.</span>' : "Link it so the line shows how much is done. Leave empty for cash that was not planned."; const left = Math.max(0, num(it.amount) - loggedFor(it.id, null, r.id)); return `${esc(it.party || it.description)}: planned ${plain(it.amount)}, left ${plain(left)} ${esc(it.currency)}.`; }
  function readLog() { const r = S.m.row, bank = v("cl-bank"); Object.assign(r, { day: v("cl-day") || r.day, unit: v("cl-unit") || r.unit, kind: v("cl-kind") || r.kind, bank: bank === "__new__" ? (v("cl-newbank").trim() || "") : bank, amount: v("cl-amt"), currency: v("cl-cur") || "ETB", party: v("cl-party").trim(), typeCode: v("cl-type"), description: v("cl-desc").trim(), note: v("cl-note").trim() }); S.m.newBank = bank === "__new__"; }
  function linkPick() {
    const m = S.m; if (!m || m.type !== "log") return; const r = m.row, code = v("cl-code").trim().toUpperCase(); const it = code ? S.items.find((i) => i.code && i.code.toUpperCase() === code) : null;
    r.itemCode = code; r.itemId = it ? it.id : "";
    if (it) { const left = Math.max(0, num(it.amount) - loggedFor(it.id, null, r.id)); readLog(); r.itemCode = it.code; r.itemId = it.id; r.kind = it.kind; r.unit = it.unit; r.currency = it.currency; r.party = r.party || it.party; r.description = r.description || it.description; r.typeCode = r.typeCode || it.typeCode; if (!num(r.amount)) r.amount = left; drawModal(); }
    else { const h = document.getElementById("cl-hint"); if (h) h.innerHTML = linkHint(r); }
  }
  function bankPick() { if (!S.m || S.m.type !== "log") return; readLog(); drawModal(); }
  function bankForm(m) {
    const r = m.row;
    return `<div class="panel-head"><h2>Bank balance</h2></div><div class="xgrid">
      ${field("cb-unit", "Unit", `<select id="cb-unit">${unitOpts(r.unit)}</select>`)}${field("cb-day", "Day", `<input type="date" id="cb-day" value="${esc(r.day)}">`)}
      ${field("cb-bank", "Bank account", `<input type="text" id="cb-bank" list="cb-banks" value="${esc(r.bank)}"><datalist id="cb-banks">${[...new Set(S.bank.map((b) => b.bank))].sort().map((b) => `<option value="${esc(b)}">`).join("")}</datalist>`, true)}
      ${field("cb-open", "Opening balance", `<input type="number" id="cb-open" step="any" value="${esc(String(r.opening ?? 0))}">`)}${field("cb-in", "In", `<input type="number" id="cb-in" step="any" value="${esc(String(r.inflow ?? 0))}">`)}
      ${field("cb-out", "Out", `<input type="number" id="cb-out" step="any" value="${esc(String(r.outflow ?? 0))}">`)}${field("cb-close", "Closing balance", `<input type="number" id="cb-close" step="any" value="${esc(String(r.closing ?? 0))}">`)}</div>${footer(m, "bank-save", null, `<button type="button" class="btn small" data-cf="bank-calc">Work out the closing</button>`)}`;
  }
  function planForm(m) {
    const r = m.row;
    return `<div class="panel-head"><h2>${m.isNew ? "Add a plan line" : "Plan line"}</h2></div><div class="xgrid">
      ${field("cp-unit", "Unit", `<select id="cp-unit">${unitOpts(r.unit)}</select>`)}${field("cp-month", "Month", `<input type="month" id="cp-month" value="${esc(r.month)}">`)}
      ${field("cp-kind", "Inflow or outflow", `<select id="cp-kind"><option value="in" ${r.kind === "in" ? "selected" : ""}>Inflow</option><option value="out" ${r.kind === "out" ? "selected" : ""}>Outflow</option></select>`)}${field("cp-sec", "Section", `<select id="cp-sec">${PLAN_SECTIONS.map(([k, l]) => `<option value="${k}" ${k === r.section ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
      ${field("cp-label", "Line (for example Payroll, CAPEX, Proceeds from borrowings)", `<input type="text" id="cp-label" value="${esc(r.label)}">`, true)}${field("cp-amt", "Amount", `<input type="number" id="cp-amt" min="0" step="any" value="${esc(String(r.amount ?? ""))}">`)}${field("cp-note", "Note", `<input type="text" id="cp-note" value="${esc(r.note || "")}">`)}</div>${footer(m, "plan-save", "plan-del")}`;
  }
  function typeForm(m) {
    const r = m.row, canEditCode = m.isNew || admin();
    return `<div class="panel-head"><h2>${m.isNew ? "Add a type" : "Type " + esc(r.code)}</h2></div><div class="xgrid">
      ${field("ct-code", "Code (as finance writes it)", `<input type="text" id="ct-code" value="${esc(r.code)}" ${canEditCode ? "" : "disabled"}>`)}${field("ct-label", "Meaning", `<input type="text" id="ct-label" value="${esc(r.label)}">`)}
      ${field("ct-kind", "For", `<select id="ct-kind"><option value="in" ${r.kind === "in" ? "selected" : ""}>Collections</option><option value="out" ${r.kind === "out" ? "selected" : ""}>Payments</option><option value="both" ${r.kind === "both" ? "selected" : ""}>Both</option></select>`)}
      ${field("ct-sec", "Cash flow section", `<select id="ct-sec">${SECTIONS.map(([k, l]) => `<option value="${k}" ${k === r.section ? "selected" : ""}>${l}</option>`).join("")}</select>`)}${field("ct-grp", "Group (for summaries)", `<input type="text" id="ct-grp" value="${esc(r.group || "")}">`)}
      ${field("ct-exp", "Counted in the position", `<select id="ct-exp"><option value="yes" ${r.expected ? "selected" : ""}>Yes, expected to be collected or paid</option><option value="no" ${r.expected ? "" : "selected"}>No, not expected soon (for example related parties)</option></select>`)}
      ${admin() ? field("ct-conf", "Finance has confirmed this meaning", `<select id="ct-conf"><option value="no" ${r.confirmed ? "" : "selected"}>Not yet</option><option value="yes" ${r.confirmed ? "selected" : ""}>Confirmed</option></select>`) : ""}${admin() && !m.isNew ? field("ct-act", "In the dropdown", `<select id="ct-act"><option value="yes" ${r.active ? "selected" : ""}>Shown</option><option value="no" ${r.active ? "" : "selected"}>Hidden</option></select>`) : ""}
      ${field("ct-desc", "Description (shown as a hint)", `<textarea id="ct-desc" rows="2">${esc(r.description || "")}</textarea>`, true)}</div>${footer(m, "type-save", null)}`;
  }
  const resultView = (m) => `<div class="panel-head"><h2>${esc(m.title)}</h2></div><div class="cf-result">${m.lines.map((l) => `<p>${l}</p>`).join("")}${m.notes.length ? `<div class="small"><b>To check</b></div><ul class="small">${m.notes.slice(0, 25).map((n) => `<li>${esc(n)}</li>`).join("")}${m.notes.length > 25 ? `<li>…and ${m.notes.length - 25} more</li>` : ""}</ul>` : ""}</div><div class="save-bar"><span></span><button class="btn primary" data-cf="close">OK</button></div>`;

  // ---------------- actions ----------------
  const todayRow = (kind) => ({ id: undefined, unit: writableUnits().includes(S.scope) ? S.scope : writableUnits()[0], kind: kind || "in", party: "", description: "", ref: "", typeCode: "", bucket: 1, amount: "", currency: "ETB", priority: "Normal", expected: "", status: "open", settledOn: "", note: "", enteredOn: c.todayIso });
  // After cash is recorded against a line (or removed): close the line when fully covered, reopen it if it no longer is.
  async function syncLine(itemId, extra, latestDay, skipLogId) {
    const it = S.items.find((q) => q.id === itemId); if (!it || it.status === "written_off") return null;
    const logged = loggedFor(itemId, null, skipLogId) + (extra || 0), any = logged > 0 || S.log.some((l) => l.itemId === itemId && l.id !== skipLogId);
    if (!any) return it.status === "settled" && it.settledOn ? null : null;
    const full = logged >= num(it.amount) - 0.005;
    if (full && it.status === "open") return c.api().saveCfItem(A(), itemRow({ ...it, status: "settled", settledOn: latestDay || c.todayIso }));
    if (!full && it.status === "settled") return c.api().saveCfItem(A(), itemRow({ ...it, status: "open", settledOn: "" }));
    return null;
  }
  async function onAction(el) {
    const x = el.dataset.cf, id = el.dataset.id, m = S.m, it = id ? S.items.find((q) => q.id === id) : null;
    if (x === "view") { S.view = el.dataset.v; c.render(); }
    else if (x === "today") { S.asOf = c.todayIso; c.render(); }
    else if (x === "mode") { S.mode = el.dataset.v; c.render(); }
    else if (x === "range") { S.range = Number(el.dataset.v); c.render(); }
    else if (x === "bk") { const b = Number(el.dataset.v); S.bk[b] = !S.bk[b]; if (!S.bk[1] && !S.bk[2] && !S.bk[3]) S.bk[b] = true; c.render(); }
    else if (x === "type-on") { const t = typesEff().find((q) => q.code === el.dataset.code); if (t) { S.typeOn[t.code] = !t.expected; const base = S.types.find((q) => q.code === t.code); if (base && base.expected === S.typeOn[t.code]) delete S.typeOn[t.code]; } keepOpen(); }
    else if (x === "type-reset") { S.typeOn = {}; keepOpen(); }
    else if (x === "lkind") { S.lf.kind = el.dataset.v; S.lf.show = 40; c.render(); }
    else if (x === "more") { S.lf.show += 40; c.render(); }
    else if (x === "no-type") { S.lf.type = "__none"; S.lf.status = "open"; c.render(); }
    else if (x === "cat-open") { S.lf.kind = el.dataset.kind; S.lf.type = el.dataset.code; S.lf.status = "open"; S.lf.q = ""; S.view = "items"; c.render(); }
    else if (x === "close") closeModal();
    else if (x === "day-shift") { S.day = addDays(S.day, Number(el.dataset.v)); c.render(); }
    else if (x === "day-today") { S.day = c.todayIso; c.render(); }
    else if (x === "day-pick") { S.day = el.dataset.v; c.render(); }
    // lines
    else if (x === "item-new") { S.m = { type: "item", isNew: true, row: todayRow(S.lf.kind || "in") }; drawModal(); }
    else if (x === "item-open" && it) { S.m = { type: "item", isNew: false, row: clone(it) }; drawModal(); }
    else if (x === "item-save") {
      readItem(); const r = m.row; if (!r.unit) { c.toast("Choose the unit"); return; } if (!r.party && !r.description) { c.toast("Write who it is from or to, or a description"); return; } if (num(r.amount) <= 0) { c.toast("Enter the total amount"); return; }
      if (r.status !== "open" && !r.settledOn) r.settledOn = c.todayIso; if (r.status === "open") r.settledOn = "";
      if (await run(() => c.api().saveCfItem(A(), itemRow({ ...r, id: m.isNew ? undefined : r.id })), "Saved")) closeModal();
    }
    else if (x === "item-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } if (await run(() => c.api().deleteCf(A(), "cf_items", m.row.id), "Deleted")) closeModal(); }
    else if (x === "rec" && it) { const left = Math.max(0, num(it.amount) - loggedFor(it.id)); S.m = { type: "log", isNew: true, row: { unit: it.unit, day: c.todayIso, kind: it.kind, bank: knownBanks(it.unit)[0] || "", amount: left, currency: it.currency, party: it.party, description: it.description, typeCode: it.typeCode, itemId: it.id, itemCode: it.code, note: "" } }; drawModal(); }
    // log
    else if (x === "dkind") { S.dq.kind = el.dataset.v; S.dq.show = 30; c.render(); }
    else if (x === "dmore") { S.dq.show += 30; c.render(); }
    else if (x === "dr-save") {
      const ents = Object.entries(S.dr).map(([id, d]) => ({ it: S.items.find((q) => q.id === id), d })).filter((o) => o.it && num(o.d.amt) > 0 && canWrite(o.it.unit));
      if (!ents.length) return; const noBank = ents.find((o) => !(o.d.bank || lastBank(o.it.unit, o.it.kind))); if (noBank) { c.toast("Choose the bank for " + (noBank.it.party || noBank.it.code)); return; }
      const ok = await run(async () => { for (const { it, d } of ents) {
        const res = await c.api().saveCfLog(A(), { unit: it.unit, day: S.day, kind: it.kind, bank: d.bank || lastBank(it.unit, it.kind), amount: num(d.amt), currency: it.currency, party: it.party, description: it.description, typeCode: it.typeCode, itemId: it.id, itemCode: it.code, note: "" });
        if (res && res.error) return res; const e = await syncLine(it.id, num(d.amt), S.day); if (e && e.error) return e; } return { ok: true }; }, `${ents.length} entr${ents.length > 1 ? "ies" : "y"} saved`);
      if (ok) { ents.forEach((o) => delete S.dr[o.it.id]); c.render(); }
    }
    else if (x === "log-new") { const u = writableUnits().includes(S.scope) ? S.scope : writableUnits()[0]; S.m = { type: "log", isNew: true, row: { unit: u, day: S.day, kind: "in", bank: knownBanks(u)[0] || "", amount: "", currency: "ETB", party: "", description: "", typeCode: "", itemId: "", itemCode: "", note: "" } }; drawModal(); }
    else if (x === "log-open") { const l = S.log.find((q) => q.id === id); if (l && canWrite(l.unit)) { S.m = { type: "log", isNew: false, row: clone(l) }; drawModal(); } }
    else if (x === "log-save") {
      readLog(); const r = m.row; if (!r.unit || !r.day) { c.toast("Choose the date and unit"); return; } if (num(r.amount) <= 0) { c.toast("Enter the amount"); return; } if (!r.bank) { c.toast("Choose the bank"); return; }
      if (r.itemCode && !r.itemId) { c.toast("No line has the code " + r.itemCode + ". Clear it or pick one from the list."); return; }
      const old = m.isNew ? null : S.log.find((q) => q.id === r.id), prevItem = old && old.itemId && old.itemId !== r.itemId ? old.itemId : null;
      const ok = await run(async () => {
        const res = await c.api().saveCfLog(A(), logRow({ ...r, id: m.isNew ? undefined : r.id, amount: num(r.amount) })); if (res && res.error) return res;
        if (r.itemId) { const e = await syncLine(r.itemId, num(r.amount), r.day, r.id); if (e && e.error) return e; }
        if (prevItem) { const e = await syncLine(prevItem, 0, null, r.id); if (e && e.error) return e; }
        return res; }, "Saved");
      if (ok) { S.day = r.day; closeModal(); }
    }
    else if (x === "log-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } const l = m.row;
      if (await run(async () => { const res = await c.api().deleteCf(A(), "cf_log", l.id); if (res && res.error) return res; if (l.itemId) await syncLine(l.itemId, 0, null, l.id); return res; }, "Deleted")) closeModal(); }
    else if (x === "bk-save") {
      const rows = [...document.querySelectorAll("tr[data-bkkey]")].map((tr) => { const [unit, bank, day] = tr.dataset.bkkey.split("|"), g = (k) => (tr.querySelector(`[data-bd="${k}"]`) || {}).value; return { unit, bank, day, tr, open: g("open"), inn: sumExpr(g("in")), out: sumExpr(g("out")), close: g("close") }; }).filter((r) => canWrite(r.unit));
      if (!rows.length) return;
      const bad = rows.find((r) => Number.isNaN(r.inn) || Number.isNaN(r.out)); if (bad) { c.toast("In and Out must be numbers, or a sum like 500000+250000"); return; }
      const ok = await run(async () => { for (const r of rows) { const prev = effBank().filter((b) => b.unit === r.unit && b.bank === r.bank && b.day < r.day).sort((a, b) => b.day.localeCompare(a.day))[0], opening = prev ? num(prev.closing) : num(r.open); const closing = r.close === "" ? opening + r.inn - r.out : num(r.close);
        const res = await c.api().saveCfBank(A(), { unit: r.unit, day: r.day, bank: r.bank, opening, inflow: r.inn, outflow: r.out, closing }); if (res && res.error) return res; } return { ok: true }; }, "Day saved");
      if (ok) rows.forEach((r) => delete S.bd[`${r.unit}|${r.bank}|${r.day}`]);
    }
    else if (x === "bank-new") { S.m = { type: "bank", isNew: true, row: { unit: writableUnits().includes(S.scope) ? S.scope : writableUnits()[0], day: S.day, bank: "", opening: 0, inflow: 0, outflow: 0, closing: 0 } }; drawModal(); }
    else if (x === "bank-calc") { document.getElementById("cb-close").value = String(Math.round((num(v("cb-open")) + num(v("cb-in")) - num(v("cb-out"))) * 100) / 100); }
    else if (x === "bank-save") {
      const row = { unit: v("cb-unit"), day: v("cb-day"), bank: v("cb-bank").trim(), opening: num(v("cb-open")), inflow: num(v("cb-in")), outflow: num(v("cb-out")), closing: num(v("cb-close")) };
      if (!row.day || !row.bank) { c.toast("Fill in the day and the bank"); return; }
      if (await run(() => c.api().saveCfBank(A(), row), "Saved")) { S.day = row.day; closeModal(); }
    }
    // plan
    else if (x === "plan-new" || x === "plan-fin") { const nm = addMonths(monthOf(S.asOf), 1); S.m = { type: "plan", isNew: true, row: { unit: writableUnits().includes(S.scope) ? S.scope : writableUnits()[0], month: nm, kind: x === "plan-fin" ? "in" : "in", section: x === "plan-fin" ? "financing" : "operating", label: x === "plan-fin" ? "Proceeds from borrowings" : "", amount: "" } }; drawModal(); }
    else if (x === "plan-open") { const p = S.plan.find((q) => q.id === id); if (p) { S.m = { type: "plan", isNew: false, row: clone(p) }; drawModal(); } }
    else if (x === "plan-save") {
      const r = m.row, row = { id: m.isNew ? undefined : r.id, unit: v("cp-unit"), month: v("cp-month"), kind: v("cp-kind"), section: v("cp-sec"), label: v("cp-label").trim(), amount: num(v("cp-amt")), note: v("cp-note").trim() };
      if (!row.label || !row.month) { c.toast("Fill in the month and the line"); return; }
      if (await run(() => c.api().saveCfPlan(A(), row), "Saved")) closeModal();
    }
    else if (x === "plan-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } if (await run(() => c.api().deleteCf(A(), "cf_plan", m.row.id), "Deleted")) closeModal(); }
    // types
    else if (x === "type-new") { S.m = { type: "type", isNew: true, row: { code: "", label: "", kind: "both", section: "operating", group: "", description: "", expected: true, confirmed: false, active: true } }; drawModal(); }
    else if (x === "type-open") { const t = S.types.find((q) => q.id === id); if (t) { S.m = { type: "type", isNew: false, row: clone(t) }; drawModal(); } }
    else if (x === "type-from-item") { readItem(); S.m = { type: "type", isNew: true, back: S.m, row: { code: "", label: "", kind: S.m.row.kind, section: "operating", group: "", description: "", expected: true, confirmed: false, active: true } }; drawModal(); }
    else if (x === "type-save") {
      const r = m.row, row = { id: m.isNew ? undefined : r.id, code: v("ct-code").trim(), label: v("ct-label").trim(), kind: v("ct-kind"), section: v("ct-sec"), group: v("ct-grp").trim(), description: v("ct-desc").trim(), expected: v("ct-exp") !== "no", sort: r.sort };
      if (document.getElementById("ct-conf")) row.confirmed = v("ct-conf") === "yes"; if (document.getElementById("ct-act")) row.active = v("ct-act") !== "no";
      if (!row.code) { c.toast("Enter the code"); return; }
      if (!(await run(() => c.api().saveCfType(A(), row), "Saved"))) return;
      if (m.back) { S.m = m.back; S.m.row.typeCode = row.code; drawModal(); }
      else if (m.applyTo) { const target = S.items.find((q) => q.id === m.applyTo); closeModal(); if (target) run(() => c.api().saveCfItem(A(), itemRow({ ...target, typeCode: row.code }))); }
      else closeModal();
    }
    else if (x === "fx-save") { await run(() => c.api().saveCfSetting(A(), "usd_etb", (document.getElementById("cfFx") || {}).value || ""), "Rate saved"); }
    else if (x === "xl-down") excelWorkbook();
    else if (x === "xl-report") reportExcel();
    else if (x === "xl-types") typesExcel();
  }
  // re-render but keep the "Counted types" box open
  function keepOpen() { c.render(); const d = document.querySelector(".cf-inc"); if (d) d.open = true; }

  async function onQuick(el) {
    const it = S.items.find((q) => q.id === el.dataset.id); if (!it || !canWrite(it.unit)) return;
    const k = el.dataset.cfq, val = el.value;
    if (k === "type" && val === "__new__") { S.m = { type: "type", isNew: true, applyTo: it.id, row: { code: "", label: "", kind: it.kind, section: "operating", group: "", description: "", expected: true, confirmed: false, active: true } }; drawModal(); return; }
    await run(() => c.api().saveCfItem(A(), itemRow({ ...it, ...(k === "type" ? { typeCode: val } : { expected: val }) })), "Saved");
  }
  function onControl(el) {
    const k = el.dataset.cfc;
    if (k === "asOf") { if (el.value) S.asOf = el.value; } else if (k === "scope") S.scope = el.value; else if (k === "day") { if (el.value) S.day = el.value; } else if (k === "pfrom") S.pf.from = el.value;
    c.render();
  }
  function onFilter(el) { S.lf[el.dataset.cff] = el.value; S.lf.show = 40; c.render(); if (el.dataset.cff === "q") { const e = document.querySelector('[data-cff="q"]'); if (e) { e.focus(); e.setSelectionRange(e.value.length, e.value.length); } } }

  const main = document.getElementById("main");
  main.addEventListener("click", (e) => { if (e.target.closest("select,input,label")) return; const el = e.target.closest("[data-cf]"); if (el) { if (el.tagName === "A") e.preventDefault(); onAction(el); } });
  main.addEventListener("keydown", (e) => { const el = e.target.closest && e.target.closest("tr[data-cf]"); if (el && (e.key === "Enter" || e.key === " ") && !e.target.closest("select,input,button")) { e.preventDefault(); onAction(el); } });
  main.addEventListener("change", (e) => { const t = e.target; if (t.id === "cfUpload") { if (t.files[0]) uploadFile(t.files[0]); t.value = ""; return; } if (!t.dataset) return; if (t.dataset.dr) { onDraft(t); return; } if (t.dataset.cfq) onQuick(t); else if (t.dataset.cfc) onControl(t); else if (t.dataset.cff && t.dataset.cff !== "q") onFilter(t); });
  const onBank = (t) => {
    const key = t.dataset.key, d = S.bd[key] || (S.bd[key] = {}), tr = t.closest("tr"), k = t.dataset.bd; d[k] = t.value;
    const g = (n) => (tr.querySelector(`[data-bd="${n}"]`) || {}).value, openCell = tr.querySelector('[data-bd="open"]'), opening = openCell ? num(openCell.value) : num(String(tr.children[2].textContent).replace(/,/g, "")), inn = sumExpr(g("in")), out = sumExpr(g("out"));
    const calc = opening + (Number.isNaN(inn) ? 0 : inn) - (Number.isNaN(out) ? 0 : out), cl = tr.querySelector('[data-bd="close"]');
    if (k !== "close" && cl) { cl.value = String(Math.round(calc * 100) / 100); d.close = cl.value; }
    const chk = tr.querySelector(".cf-bkchk"); if (chk) chk.innerHTML = Math.abs(num(cl.value) - calc) > 0.5 ? `<span class="neg">opening + in − out is ${plain(calc)}</span>` : '<span class="muted">not saved</span>';
    const rowsAll = [...document.querySelectorAll("tr[data-bkkey]")], tot = (n) => sum(rowsAll, (r) => { const x = n === "close" ? num((r.querySelector('[data-bd="close"]') || {}).value) : sumExpr((r.querySelector(`[data-bd="${n}"]`) || {}).value); return Number.isNaN(x) ? 0 : x; });
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = plain(v); }; set("cfTotIn", tot("in")); set("cfTotOut", tot("out")); set("cfTotClose", tot("close"));
  };
  const onDraft = (t) => { const d = S.dr[t.dataset.id] || (S.dr[t.dataset.id] = {}); d[t.dataset.dr] = t.value; const b = document.getElementById("cfDrSave"), n = draftCount(); if (b) { b.disabled = !n; b.textContent = n ? `Save ${n} entr${n > 1 ? "ies" : "y"}` : "Save entries"; } const row = t.closest("tr"); if (row) row.classList.toggle("cf-fill", num(d.amt) > 0); };
  main.addEventListener("input", (e) => { const t = e.target; if (t.dataset && t.dataset.bd) { onBank(t); return; } if (t.dataset && t.dataset.dr) { onDraft(t); return; } if (t.dataset && t.dataset.cfd === "q") { clearTimeout(onFilter.d); onFilter.d = setTimeout(() => { S.dq.q = t.value; S.dq.show = 30; c.render(); const e2 = document.querySelector('[data-cfd="q"]'); if (e2) { e2.focus(); e2.setSelectionRange(e2.value.length, e2.value.length); } }, 250); return; } if (t.dataset && t.dataset.cff === "q") { clearTimeout(onFilter.t); onFilter.t = setTimeout(() => onFilter(t), 250); } });
  main.addEventListener("pointermove", hover); main.addEventListener("pointerleave", unhover, true); main.addEventListener("pointerdown", hover);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.m) closeModal(); });

  // ---------------- Excel: download (template with dropdowns and checks, filled with the current data) ----------------
  async function excelWorkbook() {
    let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch (e) { c.toast("The Excel tool did not load. Reload the page and try again."); return; }
    const units = scopeUnits().filter((u) => canWrite(u)), wb = new ExcelJS.Workbook(), lists = wb.addWorksheet("Lists", { state: "veryHidden" }), asOf = c.todayIso;
    if (!units.length) { c.toast("You can only download the workbook for a unit you can edit."); return; }
    const col = (i, arr) => { arr.forEach((x, k) => { lists.getCell(k + 1, i).value = x; }); const L = lists.getColumn(i).letter; return `Lists!$${L}$1:$${L}$${Math.max(1, arr.length)}`; };
    const banks = [...new Set(units.flatMap(knownBanks))].filter((b) => b && b !== "All banks");
    wb.definedNames.add(col(1, units.map(uname)), "L_Unit"); wb.definedNames.add(col(2, ["Collect", "Pay"]), "L_Kind"); wb.definedNames.add(col(3, S.types.filter((t) => t.active).map((t) => t.code)), "L_Type"); wb.definedNames.add(col(4, ["1", "2", "3"]), "L_Urg");
    wb.definedNames.add(col(5, CURRENCIES), "L_Cur"); wb.definedNames.add(col(6, PRIORITIES), "L_Pri"); wb.definedNames.add(col(7, ["In", "Out"]), "L_InOut"); wb.definedNames.add(col(8, banks.length ? banks : [""]), "L_Bank"); wb.definedNames.add(col(9, PLAN_SECTIONS.map((s) => s[1])), "L_Sec"); wb.definedNames.add(col(10, ["Inflow", "Outflow"]), "L_Flow");
    const sheet = (name, heads, widths, rows, nrows) => { const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] }); ws.columns = heads.map((h, i) => ({ header: h, key: "c" + i, width: widths[i] })); const hr = ws.getRow(1); hr.font = { bold: true, color: { argb: "FF2A2208" } }; hr.height = 30; hr.alignment = { vertical: "middle", wrapText: true };
      hr.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5C518" } }; }); rows.forEach((r) => ws.addRow(r)); return { ws, last: Math.max(rows.length + 200, nrows || 300) }; };
    const list = (ws, cI, last, name, err) => { for (let r = 2; r <= last; r++) ws.getCell(r, cI).dataValidation = { type: "list", allowBlank: true, formulae: [name], showErrorMessage: true, errorTitle: "Pick from the list", error: err }; };
    const amount = (ws, cI, last) => { for (let r = 2; r <= last; r++) { ws.getCell(r, cI).dataValidation = { type: "decimal", operator: "greaterThanOrEqual", allowBlank: true, formulae: [0], showErrorMessage: true, errorTitle: "Amount", error: "Enter a number, 0 or more." }; ws.getCell(r, cI).numFmt = "#,##0.00"; } };
    const date = (ws, cI, last) => { for (let r = 2; r <= last; r++) { ws.getCell(r, cI).dataValidation = { type: "date", operator: "greaterThan", allowBlank: true, formulae: [new Date(Date.UTC(2020, 0, 1))], showErrorMessage: true, errorTitle: "Date", error: "Enter a date, for example 2026-10-22." }; ws.getCell(r, cI).numFmt = "yyyy-mm-dd"; } };
    const toDate = (iso) => (iso ? new Date(iso + "T00:00:00Z") : "");
    // 1 collections and payments
    const eff = S.items.filter((i) => units.includes(i.unit) && i.status === "open");
    const a = sheet("Collections and payments", ["Code (leave empty for a new line)", "Unit", "Collect or pay", "Party", "Invoice / reference", "Description", "Type", "Urgency (1, 2 or 3)", "Planned amount", "Currency", "Priority", "Expected date", "Note"], [16, 26, 13, 28, 18, 36, 14, 12, 16, 10, 10, 14, 30],
      eff.map((i) => [i.code, uname(i.unit), i.kind === "in" ? "Collect" : "Pay", i.party, i.ref, i.description, i.typeCode, i.bucket, num(i.amount), i.currency, i.priority, toDate(i.expected), i.note]), 300);
    list(a.ws, 2, a.last, "L_Unit", "Pick a unit from the list."); list(a.ws, 3, a.last, "L_Kind", "Pick Collect or Pay."); list(a.ws, 7, a.last, "L_Type", "Pick a type from the list. To add a new type, use Setup in the app."); list(a.ws, 8, a.last, "L_Urg", "Pick 1, 2 or 3."); list(a.ws, 10, a.last, "L_Cur", "Pick ETB or USD."); list(a.ws, 11, a.last, "L_Pri", "Pick High, Normal or Low."); amount(a.ws, 9, a.last); date(a.ws, 12, a.last);
    // 2 daily log
    const logs = S.log.filter((l) => units.includes(l.unit) && l.day >= addDays(asOf, -7));
    const b = sheet("Daily log", ["Date", "Unit", "In or out", "Bank", "Planned line code (optional)", "Party", "Description", "Amount", "Currency", "Note"], [13, 26, 10, 22, 18, 28, 36, 16, 10, 30], logs.map((l) => [toDate(l.day), uname(l.unit), l.kind === "in" ? "In" : "Out", l.bank, l.itemCode, l.party, l.description, num(l.amount), l.currency, l.note]), 300);
    date(b.ws, 1, b.last); list(b.ws, 2, b.last, "L_Unit", "Pick a unit from the list."); list(b.ws, 3, b.last, "L_InOut", "Pick In or Out."); list(b.ws, 4, b.last, "L_Bank", "Pick a bank. To add a new bank, record it once in the app."); amount(b.ws, 8, b.last); list(b.ws, 9, b.last, "L_Cur", "Pick ETB or USD.");
    // 3 bank balances
    const bk = S.bank.filter((r) => units.includes(r.unit) && r.day >= addDays(asOf, -7)).sort((x, y) => x.day.localeCompare(y.day));
    const d = sheet("Bank balances", ["Date", "Unit", "Bank", "Opening", "In", "Out", "Closing balance"], [13, 26, 22, 16, 16, 16, 18], bk.map((r) => [toDate(r.day), uname(r.unit), r.bank, num(r.opening), num(r.inflow), num(r.outflow), num(r.closing)]), 200);
    date(d.ws, 1, d.last); list(d.ws, 2, d.last, "L_Unit", "Pick a unit from the list."); list(d.ws, 3, d.last, "L_Bank", "Pick a bank, or write a new one in the app first."); for (const cI of [4, 5, 6, 7]) for (let r = 2; r <= d.last; r++) d.ws.getCell(r, cI).numFmt = "#,##0.00";
    // 4 plan
    const pl = S.plan.filter((p) => units.includes(p.unit) && p.month >= addMonths(monthOf(asOf), -1));
    const p = sheet("Plan", ["Month (YYYY-MM)", "Unit", "Inflow or outflow", "Section", "Line", "Amount", "Note"], [14, 26, 14, 14, 36, 16, 30], pl.map((r) => [r.month, uname(r.unit), r.kind === "in" ? "Inflow" : "Outflow", (SECTIONS.find((s) => s[0] === r.section) || [])[1] || r.section, r.label, num(r.amount), r.note]), 200);
    list(p.ws, 2, p.last, "L_Unit", "Pick a unit from the list."); list(p.ws, 3, p.last, "L_Flow", "Pick Inflow or Outflow."); list(p.ws, 4, p.last, "L_Sec", "Pick Operating, Investing or Financing."); amount(p.ws, 6, p.last);
    // 5 types (the hint sheet) and instructions
    const ty = wb.addWorksheet("Types"); ty.columns = [{ header: "Type code", width: 18 }, { header: "Meaning", width: 36 }, { header: "For", width: 12 }, { header: "Counted", width: 10 }, { header: "Description", width: 70 }]; ty.getRow(1).font = { bold: true };
    S.types.filter((t) => t.active).forEach((t) => ty.addRow([t.code, t.label, t.kind === "in" ? "Collections" : t.kind === "out" ? "Payments" : "Both", t.expected ? "Yes" : "No", t.description]));
    const info = wb.addWorksheet("Info", { views: [{ showGridLines: false }] }); info.getColumn(1).width = 8; info.getColumn(2).width = 120;
    [["How to fill this in"], ["1", "Collections and payments: one row per invoice or payable. Leave Code empty for a new line; the app gives it a code (CF-00012). Keep the code of existing lines to update them."],
      ["2", "Urgency: 1 within a month (11 when paying), 2 within two months (22), 3 long term (33). Type 1, 2 or 3; the app knows if it is a collection or a payment."],
      ["3", "Daily log: one row per receipt or payment, with the bank that was credited or debited. Put the code of the planned line in “Planned line code” so a part payment is traced to its line."],
      ["4", "Bank balances: the closing balance per bank per day. Plan: the monthly forecast lines."],
      ["5", "Dropdowns list the allowed values. See the Types sheet for what each type means. New types are added in the app under Cash flow, Setup."],
      ["6", "Upload the file on any Enter page with Upload Excel. Rows that cannot be read are listed so you can fix them; the rest are saved. Uploading does not delete anything."]].forEach((r, i) => { const row = info.addRow(r); if (i === 0) row.font = { bold: true, size: 14 }; });
    wb.worksheets.forEach((w) => { if (w.name !== "Lists") w.properties.tabColor = { argb: w.name === "Info" || w.name === "Types" ? "FF999999" : "FFF5C518" }; });
    const buf = await wb.xlsx.writeBuffer(); await c.saveFile(`Cash flow ${asOf}.xlsx`, buf, "Excel saved");
  }

  // ---------------- Excel: upload ----------------
  async function uploadFile(file) {
    const units = writableUnits(); if (!units.length) { c.toast("You cannot edit any unit's cash flow"); return; }
    if (!c.libsReady("xlsx")) return; const X = c.XLSX(); let wb;
    try { wb = X.read(await file.arrayBuffer(), { type: "array" }); } catch (e) { c.toast("Could not read that file. Use the workbook from Download Excel."); return; }
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(), uMap = new Map();
    units.forEach((u) => [uname(u), ushort(u), c.unitName(u), u].forEach((n) => uMap.set(norm(n), u)));
    if (units.includes("wagwago-electric")) uMap.set("wagwago trading", "wagwago-electric");
    const tMap = new Map(S.types.map((t) => [norm(t.code), t.code])), rep = { items: [0, 0], log: 0, bank: 0, plan: [0, 0], skip: 0, notes: [] };
    const sheetRows = (re) => { const n = wb.SheetNames.find((s) => re.test(s)); if (!n) return null; const rows = X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }); return rows.length > 1 ? rows.slice(1).map((r, i) => ({ r, line: i + 2 })).filter((o) => o.r.some((x) => String(x).trim() !== "")) : []; };
    const bad = (name, line, why) => { rep.skip++; rep.notes.push(`${name} row ${line}: ${why}`); };
    const money = (x) => { if (x === "" || x == null) return null; const n = Number(String(x).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
    await run(async () => {
      const aRows = sheetRows(/^collections/i), added = {};
      if (aRows) for (const { r, line } of aRows) {
        const [code, unitN, kindN, party, ref, desc, typeN, urg, amt, cur, pri, exp, note] = r, unit = uMap.get(norm(unitN)), kind = /^c/i.test(String(kindN).trim()) ? "in" : /^p/i.test(String(kindN).trim()) ? "out" : "", old = String(code).trim() ? S.items.find((i) => i.code && i.code.toUpperCase() === String(code).trim().toUpperCase()) : null;
        if (!unit) { bad("Collections and payments", line, `unit “${unitN}” not found or not yours`); continue; }
        const b = bucketOf(urg) || (old ? old.bucket : 0), a = money(amt); if (!kind && !old) { bad("Collections and payments", line, "Collect or pay is empty"); continue; } if (!b) { bad("Collections and payments", line, "urgency must be 1, 2 or 3"); continue; } if (a === null || a < 0) { bad("Collections and payments", line, "amount is missing or not a number"); continue; }
        if (!String(party).trim() && !String(desc).trim() && !old) { bad("Collections and payments", line, "party and description are both empty"); continue; }
        let typeCode = String(typeN).trim() ? tMap.get(norm(typeN)) : ""; if (String(typeN).trim() && !typeCode) { rep.notes.push(`Collections and payments row ${line}: type “${typeN}” is not in the list, left without a type`); typeCode = ""; }
        const base = old ? itemRow(old) : { unit, kind, status: "open", enteredOn: c.todayIso, bucket: b };
        const row = { ...base, unit: old ? old.unit : unit, kind: old ? old.kind : kind, party: String(party).trim(), ref: String(ref).trim(), description: String(desc).trim(), typeCode, bucket: b, amount: a, currency: CURRENCIES.includes(String(cur).trim().toUpperCase()) ? String(cur).trim().toUpperCase() : "ETB", priority: PRIORITIES.find((p) => p.toLowerCase() === String(pri).trim().toLowerCase()) || "Normal", expected: serialToIso(exp), note: String(note).trim() };
        if (old && !canWrite(old.unit)) { bad("Collections and payments", line, "not your unit"); continue; }
        const res = await c.api().saveCfItem(A(), row); if (res && res.error) return res; rep.items[old ? 1 : 0]++;
      }
      const lRows = sheetRows(/^daily/i);
      if (lRows) for (const { r, line } of lRows) {
        const [dt, unitN, io, bank, code, party, desc, amt, cur, note] = r, unit = uMap.get(norm(unitN)), day = serialToIso(dt), kind = /^i/i.test(String(io).trim()) ? "in" : /^o/i.test(String(io).trim()) ? "out" : "", a = money(amt);
        if (!unit) { bad("Daily log", line, `unit “${unitN}” not found or not yours`); continue; } if (!day) { bad("Daily log", line, "date is missing or not a date"); continue; } if (!kind) { bad("Daily log", line, "In or out is empty"); continue; } if (a === null || a <= 0) { bad("Daily log", line, "amount must be above 0"); continue; } if (!String(bank).trim()) { bad("Daily log", line, "bank is empty"); continue; }
        const item = String(code).trim() ? S.items.find((i) => i.code && i.code.toUpperCase() === String(code).trim().toUpperCase() && i.unit === unit) : null; if (String(code).trim() && !item) { bad("Daily log", line, `no line with code ${code} for this unit`); continue; }
        const dup = S.log.find((l) => l.unit === unit && l.day === day && l.kind === kind && l.bank === String(bank).trim() && Math.abs(num(l.amount) - a) < 0.005 && (l.itemCode || "") === (item ? item.code : "") && (l.party || "") === String(party).trim());
        if (dup) { rep.notes.push(`Daily log row ${line}: already recorded, skipped`); continue; }
        const res = await c.api().saveCfLog(A(), { unit, day, kind, bank: String(bank).trim(), amount: a, currency: CURRENCIES.includes(String(cur).trim().toUpperCase()) ? String(cur).trim().toUpperCase() : "ETB", party: String(party).trim() || (item ? item.party : ""), description: String(desc).trim() || (item ? item.description : ""), typeCode: item ? item.typeCode : "", itemId: item ? item.id : "", itemCode: item ? item.code : "", note: String(note).trim() });
        if (res && res.error) return res; rep.log++; if (item) { const g = added[item.id] || (added[item.id] = { amt: 0, day: "" }); g.amt += a; if (day > g.day) g.day = day; }
      }
      for (const [id, g] of Object.entries(added)) { const e = await syncLine(id, g.amt, g.day); if (e && e.error) return e; }
      const bRows = sheetRows(/^bank/i);
      if (bRows) for (const { r, line } of bRows) {
        const [dt, unitN, bank, op, inn, out, cl] = r, unit = uMap.get(norm(unitN)), day = serialToIso(dt), closing = money(cl);
        if (!unit) { bad("Bank balances", line, `unit “${unitN}” not found or not yours`); continue; } if (!day || !String(bank).trim()) { bad("Bank balances", line, "date or bank is empty"); continue; } if (closing === null) { bad("Bank balances", line, "closing balance is missing"); continue; }
        const res = await c.api().saveCfBank(A(), { unit, day, bank: String(bank).trim(), opening: money(op) || 0, inflow: money(inn) || 0, outflow: money(out) || 0, closing }); if (res && res.error) return res; rep.bank++;
      }
      const pRows = sheetRows(/^plan/i);
      if (pRows) for (const { r, line } of pRows) {
        const [mo, unitN, flow, sec, label, amt, note] = r, unit = uMap.get(norm(unitN)), month = String(mo).trim().slice(0, 7), kind = /^i/i.test(String(flow).trim()) ? "in" : /^o/i.test(String(flow).trim()) ? "out" : "", a = money(amt), section = (PLAN_SECTIONS.find((s) => s[1].toLowerCase() === String(sec).trim().toLowerCase()) || [])[0] || "operating";
        if (!unit) { bad("Plan", line, `unit “${unitN}” not found or not yours`); continue; } if (!/^\d{4}-\d{2}$/.test(month)) { bad("Plan", line, "month must look like 2026-11"); continue; } if (!kind || !String(label).trim() || a === null) { bad("Plan", line, "inflow/outflow, line or amount is missing"); continue; }
        const old = S.plan.find((p) => p.unit === unit && p.month === month && p.kind === kind && p.section === section && norm(p.label) === norm(label));
        const res = await c.api().saveCfPlan(A(), { id: old ? old.id : undefined, unit, month, kind, section, label: String(label).trim(), amount: a, note: String(note).trim() }); if (res && res.error) return res; rep.plan[old ? 1 : 0]++;
      }
      return { ok: true };
    });
    const lines = []; if (rep.items[0] || rep.items[1]) lines.push(`Collections and payments: <b>${rep.items[0]}</b> added, <b>${rep.items[1]}</b> updated.`); if (rep.log) lines.push(`Daily log: <b>${rep.log}</b> movement${rep.log > 1 ? "s" : ""} added.`); if (rep.bank) lines.push(`Bank balances: <b>${rep.bank}</b> saved.`); if (rep.plan[0] || rep.plan[1]) lines.push(`Plan: <b>${rep.plan[0]}</b> added, <b>${rep.plan[1]}</b> updated.`);
    if (rep.skip) lines.push(`<b>${rep.skip}</b> row${rep.skip > 1 ? "s were" : " was"} not saved. Fix them in the file and upload again.`); if (!lines.length) lines.push("Nothing was found to save. Use the workbook from Download Excel and keep its sheet names.");
    S.m = { type: "result", title: "Upload finished", lines, notes: rep.notes }; drawModal();
  }

  // ---------------- Excel: report and types ----------------
  async function reportExcel() {
    if (!c.libsReady("xlsx")) return; const X = c.XLSX(), wb = X.utils.book_new(), units = scopeUnits(), asOf = S.asOf, sheet = (rows, w, name) => X.utils.book_append_sheet(wb, c.sheetFromRows(rows, w), name);
    const pos = position(inScope(units, asOf), effBank(), typesEff(), asOf, units, { fx: fx() });
    sheet([["Unit", "Bank balance", "1 collect", "11 pay", "After 1 − 11", "2 collect", "22 pay", "After 2 − 22", "3 collect", "33 pay", "After 3 − 33", "Financing need"], ...[...pos.rows, { ...pos.total, unit: "all" }].map((r) => [r.unit === "all" ? "Total" : uname(r.unit), Math.round(r.bank), Math.round(r.c[0]), Math.round(r.p[0]), Math.round(r.b[0]), Math.round(r.c[1]), Math.round(r.p[1]), Math.round(r.b[1]), Math.round(r.c[2]), Math.round(r.p[2]), Math.round(r.b[2]), Math.round(r.need)])], [26, 16, 14, 14, 16, 14, 14, 16, 14, 14, 16, 16], "Position");
    for (const [kind, name] of [["in", "Collections by type"], ["out", "Payments by type"]]) { const rows = byType(inScope(units, asOf), typesEff(), asOf, units, kind, { fx: fx() }); sheet([["Type", "Lines", ...units.map(ushort), kind === "in" ? "1" : "11", kind === "in" ? "2" : "22", kind === "in" ? "3" : "33", "Total"], ...rows.map((r) => [r.code || "No type", r.n, ...units.map((u) => Math.round(r.byUnit[u] || 0)), ...r.byBucket.map(Math.round), Math.round(r.total)])], [18, 7, ...units.map(() => 14), 14, 14, 14, 16], name); }
    const act = actuals(units, asOf, "month"); sheet([["Month", "Actual in", "Actual out"], ...Object.keys(act).sort().map((k) => [k, Math.round(act[k].in), Math.round(act[k].out)])], [12, 16, 16], "Actual by month");
    await c.writeXlsx(wb, `Cash flow report ${asOf}.xlsx`, "Excel saved");
  }
  async function typesExcel() {
    if (!c.libsReady("xlsx")) return; const X = c.XLSX(), wb = X.utils.book_new(), use = {}; S.items.forEach((i) => { if (i.typeCode) use[i.typeCode] = (use[i.typeCode] || 0) + 1; });
    X.utils.book_append_sheet(wb, c.sheetFromRows([["Code", "Meaning", "For", "Section", "Group", "Counted in the position", "Confirmed by finance", "Lines using it", "Description", "Finance to describe"], ...S.types.map((t) => [t.code, t.label, t.kind, t.section, t.group, t.expected ? "Yes" : "No", t.confirmed ? "Yes" : "No", use[t.code] || 0, t.description, ""])], [20, 36, 10, 14, 18, 14, 14, 10, 50, 40]), "Types");
    await c.writeXlsx(wb, `Cash flow types ${c.todayIso}.xlsx`, "Excel saved");
  }

  return { renderCash, subscribe, canSee };
}
