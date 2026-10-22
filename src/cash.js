// Cash flow: bank balances, what we expect to collect and must pay, the position step by step (1-11, 2-22, 3-33),
// a rolling forecast by day, month or quarter, and the plan. Shown to Group Finance, unit Finance departments, Group Strategy, CEO and DCEO.
import { SECTIONS, PLAN_SECTIONS, PRIORITIES, CURRENCIES, bucketCode, BUCKET_TEXT, FIN_UNITS_FALLBACK, num, sum, addDays, addMonths, monthOf, periodLabel, closedOn, isOpenAt, etb, countsIn, bankAt, bankDays, position, funding, timeline, byType, planByMonth, HORIZON, MONTHS } from "./cashcalc.js";

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clone = (o) => JSON.parse(JSON.stringify(o));
const SHORT = { "wagwago-electric": "WWE", trucksload: "TrucksLoad", geez: "Geez", "niyat-consultancy": "Niyat", "wanza-logistics": "Wanza" };
const FULL = { "wagwago-electric": "Wagwago Trading (Electric and Corporate)" };
const KIND_TEXT = { in: "Collection", out: "Payment" };
const PRI_RANK = { High: 0, Normal: 1, Low: 2 };

export function createCash(c) {
  const { state, esc, fmt } = c;
  const S = (state.cf = { items: [], types: [], bank: [], plan: [], settings: {}, loaded: 0, view: "position", asOf: c.todayIso, scope: "all", incl: false, mode: "month", bday: "", m: null, busy: false,
    lf: { kind: "", type: "", bucket: "", status: "open", pri: "", q: "", show: 50 } });
  const A = () => c.auth() || {};
  const finDept = () => (A().departments || []).some((d) => /^fin/i.test(String(d)));
  const full = () => ["super_admin", "executive"].includes(A().role) || A().unit === "group-finance-function";
  const admin = () => A().role === "super_admin" || A().unit === "group-finance-function";
  const canSee = () => full() || (!!A().unit && finDept());
  const canWrite = (u) => A().role === "super_admin" || A().unit === "group-finance-function" || (!!u && A().unit === u && finDept());
  const canWriteAny = () => A().role === "super_admin" || A().unit === "group-finance-function" || (!!A().unit && finDept());
  const allUnits = () => { const bu = c.sortedUnits().filter((u) => u.type === "Business unit").map((u) => u.id); const ids = bu.length ? bu : FIN_UNITS_FALLBACK; return full() ? ids : [A().unit]; };
  const scopeUnits = () => (S.scope === "all" || !allUnits().includes(S.scope) ? allUnits() : [S.scope]);
  const writableUnits = () => allUnits().filter((u) => canWrite(u));
  const ushort = (u) => SHORT[u] || c.unitName(u);
  const uname = (u) => FULL[u] || c.unitName(u);
  const fx = () => num(S.settings.usd_etb);
  const ok = (res, msg) => { if (res && res.error) { c.toast(res.error === "exists" ? "That code already exists" : c.errText(res)); return false; } if (msg) c.toast(msg); return true; };
  const typeByCode = (code) => S.types.find((t) => t.code === code);
  const typeLabel = (code) => { if (!code) return "No type"; const t = typeByCode(code); return t && t.label && t.label !== code ? `${code}` : code; };
  const money = (v, dash) => { const x = Math.round(num(v)); return x === 0 && dash !== false ? '<span class="muted">–</span>' : `<span class="${x < 0 ? "neg" : ""}">${x < 0 ? "−" : ""}${Math.abs(x).toLocaleString("en-US")}</span>`; };
  const plain = (v) => Math.round(num(v)).toLocaleString("en-US");
  const dShort = (iso) => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

  // ---------------- data ----------------
  let subs = [];
  function subscribe() {
    if (!c.db() || subs.length || !canSee()) return;
    const on = (col, key, order, fn) => c.db().collection(col).orderBy(order).limit(5000).onSnapshot((snap) => { S[key] = fn ? fn(snap) : snap.docs.map((d) => ({ id: d.id, ...d.data() })); S.loaded++; if (state.tab === "cashflow" && !S.m) c.render(); }, () => { S.loaded++; });
    subs = [on("cftypes", "types", "sort"), on("cfitems", "items", "createdAt"), on("cfbank", "bank", "day"), on("cfplan", "plan", "month"),
      on("cfsettings", "settings", "updatedAt", (snap) => Object.fromEntries(snap.docs.map((d) => [d.id, d.data().value])))];
  }
  async function save(fn, msg) { if (S.busy) return false; S.busy = true; try { const r = await fn(); return ok(r, msg) ? r : false; } catch (e) { c.toast(c.errText(e)); return false; } finally { S.busy = false; c.render(); } }
  const saveItem = (row, msg) => save(() => c.api().saveCfItem(A(), row), msg);
  const itemRow = (it) => ({ id: it.id, unit: it.unit, kind: it.kind, party: it.party, description: it.description, ref: it.ref, typeCode: it.typeCode, bucket: it.bucket, amount: it.amount, currency: it.currency, priority: it.priority, expected: it.expected || "", status: it.status, settledOn: it.settledOn || "", note: it.note, enteredOn: it.enteredOn });

  // ---------------- shared controls ----------------
  const unitSel = (attr, val, withAll) => `<select data-cfc="${attr}" aria-label="Unit">${withAll === false ? "" : `<option value="all">${full() ? "All business units" : "My unit"}</option>`}${allUnits().map((u) => `<option value="${esc(u)}" ${val === u ? "selected" : ""}>${esc(uname(u))}</option>`).join("")}</select>`;
  function controls(showAsOf) {
    return `<div class="toolbar cf-controls">${showAsOf ? `<label class="small muted">As of <input type="date" data-cfc="asOf" value="${esc(S.asOf)}" max="2100-01-01"></label><button class="btn small" data-cf="today">Today</button>` : ""}
      ${allUnits().length > 1 ? unitSel("scope", S.scope) : ""}${showAsOf ? `<label class="chk" title="Related parties and similar items that are not expected to pay soon"><input type="checkbox" data-cfc="incl" ${S.incl ? "checked" : ""}> Include items not expected to be collected</label>` : ""}</div>`;
  }
  const usdWarn = () => { const n = S.items.filter((i) => i.currency === "USD" && i.status === "open").length; return n && !fx() ? `<div class="banner warn" style="margin:0 16px 12px">${n} open item${n > 1 ? "s are" : " is"} in USD and are left out of the totals until the USD rate is set (Types screen, Group Finance only).</div>` : ""; };

  // ---------------- screens ----------------
  function renderCash() {
    if (!canSee()) return `<div class="panel"><div class="empty"><b>Cash flow</b>Cash flow is shown to Group Finance, the Finance departments of the business units, Group Strategy and the executive.</div></div>`;
    subscribe();
    const tab = (v, l) => `<button class="btn${S.view === v ? " on" : ""}" data-cf="view" data-v="${v}">${l}</button>`;
    const head = `<div class="panel-head"><div><h2>Cash flow</h2><div class="small muted">Where cash stands today, what is still to be collected and paid, and what is left after each step.</div></div>
      <div class="toolbar">${tab("position", "Position")}${tab("list", "Collections and payments")}${tab("category", "By type")}${tab("bank", "Bank balances")}${tab("forecast", "Forecast and plan")}${tab("types", "Types")}</div></div>`;
    const body = S.view === "list" ? renderList() : S.view === "category" ? renderCategory() : S.view === "bank" ? renderBank() : S.view === "forecast" ? renderForecast() : S.view === "types" ? renderTypes() : renderPosition();
    return `<div class="panel">${head}${S.loaded < 3 ? `<div class="small muted" style="padding:0 16px 8px">Loading…</div>` : ""}${body}</div>`;
  }
  const card = (k, v, cls, sub) => `<div class="stat ${cls || ""}"><div class="v" style="font-size:20px">${v}</div><div class="k">${k}${sub ? `<div class="small muted">${sub}</div>` : ""}</div></div>`;

  // ----- position -----
  function renderPosition() {
    const units = scopeUnits(), pos = position(S.items, S.bank, S.types, S.asOf, units, { fx: fx(), incl: S.incl }), fu = funding(pos), t = pos.total;
    const days = bankDays(S.bank, units).filter((d) => d <= S.asOf), last = days[days.length - 1] || "";
    const low = Math.min(...t.b), rowHtml = (r, tot) => { const bad = r.need > 0;
      return `<tr class="${tot ? "tot" : ""}${bad ? " cf-bad" : ""}"><td><b>${tot ? "Group total" : esc(uname(r.unit))}</b>${!tot && r.bankDay && r.bankDay !== last ? `<div class="small muted">bank as of ${esc(dShort(r.bankDay))}</div>` : ""}${!tot && !r.hasBank ? '<div class="small muted">no bank balance yet</div>' : ""}</td>
        <td class="num">${money(r.bank)}</td><td class="num">${money(r.c[0])}</td><td class="num">${money(r.p[0])}</td><td class="num strong">${money(r.b[0], false)}</td>
        <td class="num">${money(r.c[1])}</td><td class="num">${money(r.p[1])}</td><td class="num strong">${money(r.b[1], false)}</td>
        <td class="num">${money(r.c[2])}</td><td class="num">${money(r.p[2])}</td><td class="num strong">${money(r.b[2], false)}</td><td class="num">${r.need > 0 ? `<b class="neg">${plain(r.need)}</b>` : '<span class="muted">–</span>'}</td></tr>`; };
    const gap = t.need > 0 ? `<b class="neg">${plain(t.need)}</b>` : "None";
    const fundHtml = !pos.rows.some((r) => r.hasBank || r.c.some(Boolean) || r.p.some(Boolean)) ? `<div class="empty"><b>No data for this selection yet</b>Enter the bank balances and the collections and payments first.</div>` : `
      <div class="cf-fund">${t.need > 0 ? `<p><b>The group would fall to ${money(low, false)} at its lowest.</b> That is the amount to finance, from outside the group, after the units use each other's spare cash.</p>`
        : fu.short.length ? `<p><b>The group stays positive, but ${fu.short.length} unit${fu.short.length > 1 ? "s run" : " runs"} short.</b> The gap can be covered from the units that have spare cash (for example a sister company loan), at no outside cost.</p>`
        : `<p><b>No deficit in the three steps.</b> Every unit stays above zero.</p>`}
        ${fu.short.length ? `<div class="scroll"><table><thead><tr><th>Unit short of cash</th><th>Lowest balance</th><th>Needs</th></tr></thead><tbody>${fu.short.map((r) => `<tr><td>${esc(uname(r.unit))}</td><td class="num">${money(Math.min(...r.b), false)}</td><td class="num"><b class="neg">${plain(r.need)}</b></td></tr>`).join("")}</tbody></table></div>` : ""}
        ${fu.rich.length ? `<div class="small" style="margin-top:8px"><b>Spare cash in other units:</b> ${fu.rich.map((r) => `${esc(ushort(r.unit))} ${plain(r.spare)}`).join(" · ")}</div>` : ""}
        ${fu.short.length ? `<div class="small" style="margin-top:4px">Can be covered inside the group: <b>${plain(Math.min(fu.internal, fu.spare))}</b>. Needs outside financing or a later payment date: <b class="${fu.external > 0 ? "neg" : ""}">${plain(fu.external)}</b>.</div>` : ""}
        <div class="toolbar" style="margin-top:8px">${writableUnits().length ? `<button class="btn" data-cf="plan-fin">Record a financing line in the plan</button>` : ""}</div></div>`;
    const open = S.items.filter((i) => units.includes(i.unit) && isOpenAt(i, S.asOf) && countsIn(i, S.types, S.incl));
    const chase = open.filter((i) => i.kind === "in" && i.bucket <= 2).sort((a, b) => etb(b, fx()) - etb(a, fx())).slice(0, 5);
    const wait = open.filter((i) => i.kind === "out" && i.priority !== "High" && (i.bucket >= 2 || i.priority === "Low")).sort((a, b) => etb(b, fx()) - etb(a, fx())).slice(0, 5);
    const li = (i) => `<tr class="clickable" data-cf="item-open" data-id="${esc(i.id)}" tabindex="0"><td class="small">${esc(ushort(i.unit))}</td><td>${esc(i.party || i.description || "")}<div class="small muted">${esc(i.description && i.party ? i.description : "")}</div></td><td class="small">${esc(i.typeCode || "No type")}</td><td class="small">${bucketCode(i.kind, i.bucket)}</td><td class="num">${money(etb(i, fx()))}</td></tr>`;
    return `${controls(true)}${usdWarn()}
      <div class="stats" style="padding:0 16px;margin:0 0 12px">${card("Bank balance", plain(t.bank), "", last ? "as of " + dShort(last) : "none entered")}${card("To collect", plain(sum(t.c, (x) => x)), "ok", `1: ${plain(t.c[0])} · 2: ${plain(t.c[1])} · 3: ${plain(t.c[2])}`)}${card("To pay", plain(sum(t.p, (x) => x)), "warn", `11: ${plain(t.p[0])} · 22: ${plain(t.p[1])} · 33: ${plain(t.p[2])}`)}${card("Ending balance", `<span class="${t.b[2] < 0 ? "neg" : ""}">${t.b[2] < 0 ? "−" : ""}${plain(Math.abs(t.b[2]))}</span>`, "", "after 3 − 33")}${card("Financing needed", gap, t.need > 0 ? "bad" : "", "from outside the group")}</div>
      <div class="small muted" style="padding:0 16px 8px">Step by step, as finance does it: the bank balance, plus what is collected, minus what is paid. <b>1 − 11</b> within a month, <b>2 − 22</b> within two months, <b>3 − 33</b> long term. Negative balances are in red.</div>
      <div class="scroll"><table class="cf-table"><thead><tr><th>Unit</th><th>Bank balance</th><th>1 collect</th><th>11 pay</th><th>Balance after 1 − 11</th><th>2 collect</th><th>22 pay</th><th>Balance after 2 − 22</th><th>3 collect</th><th>33 pay</th><th>Ending balance</th><th>Financing need</th></tr></thead>
        <tbody>${pos.rows.map((r) => rowHtml(r)).join("")}${pos.rows.length > 1 ? rowHtml({ ...t, unit: "all" }, true) : ""}</tbody></table></div>
      ${t.skipped ? `<div class="small muted" style="padding:8px 16px">Not counted (related parties and similar, not expected to be collected soon): <b>${plain(t.skipped)}</b>. Tick “Include items not expected to be collected” above to count them.</div>` : ""}
      <div style="padding:8px 16px"><h3 style="margin:8px 0">Deficit and how to finance it</h3>${fundHtml}</div>
      <div class="cf-two">${chase.length ? `<div><h3>Collections to chase first</h3><div class="scroll"><table><tbody>${chase.map(li).join("")}</tbody></table></div></div>` : ""}${wait.length ? `<div><h3>Payments that could wait</h3><div class="small muted">Not marked High priority, in the later steps</div><div class="scroll"><table><tbody>${wait.map(li).join("")}</tbody></table></div></div>` : ""}</div>
      <div style="padding:8px 16px 16px"><h3 style="margin:8px 0">Bank balance by day</h3>${spark(units)}</div>`;
  }
  function spark(units) {
    const days = bankDays(S.bank, units).filter((d) => d <= S.asOf).slice(-60); if (days.length < 2) return '<div class="small muted">Not enough days yet.</div>';
    const pts = days.map((d) => ({ d, v: sum(units, (u) => bankAt(S.bank, u, d).total) })), max = Math.max(...pts.map((p) => p.v)), min = Math.min(0, ...pts.map((p) => p.v)), W = 700, H = 120, rng = max - min || 1;
    const xy = pts.map((p, i) => [Math.round((i / (pts.length - 1)) * W), Math.round(H - ((p.v - min) / rng) * (H - 10) - 5)]);
    return `<svg viewBox="0 0 ${W} ${H + 18}" class="cf-spark" role="img" aria-label="Bank balance by day"><polyline fill="none" stroke="var(--brand)" stroke-width="2" points="${xy.map((p) => p.join(",")).join(" ")}"/>${xy.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" fill="var(--brand)"><title>${esc(dShort(pts[i].d))}: ${plain(pts[i].v)}</title></circle>`).join("")}
      <text x="0" y="${H + 14}" font-size="11" fill="currentColor">${esc(dShort(pts[0].d))}</text><text x="${W}" y="${H + 14}" font-size="11" text-anchor="end" fill="currentColor">${esc(dShort(pts[pts.length - 1].d))} · ${plain(pts[pts.length - 1].v)}</text></svg>`;
  }

  // ----- collections and payments list -----
  function filteredItems() {
    const f = S.lf, q = f.q.trim().toLowerCase(), units = scopeUnits();
    return S.items.filter((i) => units.includes(i.unit) && (!f.kind || i.kind === f.kind) && (f.type === "" || (f.type === "__none" ? !i.typeCode : i.typeCode === f.type)) && (!f.bucket || String(i.bucket) === f.bucket) && (!f.pri || i.priority === f.pri)
      && (f.status === "all" || i.status === f.status) && (!q || `${i.party} ${i.description} ${i.ref} ${i.typeCode} ${i.note}`.toLowerCase().includes(q)))
      .sort((a, b) => a.kind.localeCompare(b.kind) * -1 || a.bucket - b.bucket || (PRI_RANK[a.priority] ?? 1) - (PRI_RANK[b.priority] ?? 1) || etb(b, fx()) - etb(a, fx()));
  }
  const typeOptions = (kind, cur, withNew) => { const list = S.types.filter((t) => t.active && (!kind || t.kind === "both" || t.kind === kind)); if (cur && !list.some((t) => t.code === cur)) list.push({ code: cur, label: cur });
    return `<option value="">No type</option>${list.map((t) => `<option value="${esc(t.code)}" ${t.code === cur ? "selected" : ""}>${esc(t.code)}${t.label && t.label !== t.code ? " – " + esc(t.label) : ""}</option>`).join("")}${withNew && canWriteAny() ? `<option value="__new__">+ Add a new type…</option>` : ""}`; };
  function renderList() {
    const f = S.lf, list = filteredItems(), shown = list.slice(0, f.show), inT = sum(list.filter((i) => i.kind === "in"), (i) => etb(i, fx())), outT = sum(list.filter((i) => i.kind === "out"), (i) => etb(i, fx())), noType = S.items.filter((i) => i.status === "open" && scopeUnits().includes(i.unit) && !i.typeCode).length;
    const rows = shown.map((i) => { const w = canWrite(i.unit), closed = i.status !== "open";
      return `<tr class="${closed ? "dim" : ""}"><td class="small"><b>${esc(ushort(i.unit))}</b></td><td class="sup-req"><b>${esc(i.party || "")}</b>${i.description ? `<div class="small muted">${esc(i.description)}</div>` : ""}${i.ref ? `<div class="small muted">Ref ${esc(i.ref)}</div>` : ""}</td>
        <td><span class="pill ${i.kind === "in" ? "s-done" : "s-not"}">${i.kind === "in" ? "Collect" : "Pay"}</span></td>
        <td>${w && !closed ? `<select class="cf-sel" data-cfq="type" data-id="${esc(i.id)}" aria-label="Type">${typeOptions(i.kind, i.typeCode, true)}</select>` : esc(i.typeCode || "No type")}</td>
        <td class="num small" title="${esc(BUCKET_TEXT[i.bucket])}">${bucketCode(i.kind, i.bucket)}</td><td class="num">${money(i.amount, false)}${i.currency !== "ETB" ? ` <span class="tag">${esc(i.currency)}</span>` : ""}</td>
        <td>${w && !closed ? `<select class="cf-sel" data-cfq="priority" data-id="${esc(i.id)}" aria-label="Priority">${PRIORITIES.map((p) => `<option ${p === i.priority ? "selected" : ""}>${p}</option>`).join("")}</select>` : esc(i.priority)}</td>
        <td>${w && !closed ? `<input type="date" class="cf-date" data-cfq="expected" data-id="${esc(i.id)}" value="${esc(i.expected || "")}" aria-label="Expected date">` : esc(dShort(i.expected))}</td>
        <td class="small">${closed ? `<span class="pill s-done">${i.status === "settled" ? (i.kind === "in" ? "Collected" : "Paid") : "Written off"}</span><div class="muted">${esc(dShort(i.settledOn))}</div>` : ""}${w ? `<div class="toolbar">${closed ? "" : `<button class="btn small" data-cf="settle" data-id="${esc(i.id)}">${i.kind === "in" ? "Collected" : "Paid"}</button>`}<button class="btn small ghost" data-cf="item-open" data-id="${esc(i.id)}">Edit</button></div>` : ""}</td></tr>`; }).join("");
    return `${controls(false)}${usdWarn()}
      <div class="toolbar" style="padding:0 16px 12px;border-bottom:1px solid var(--line)"><input type="search" data-cff="q" placeholder="Search party, description, reference" value="${esc(f.q)}" aria-label="Search">
        <select data-cff="kind" aria-label="Collections or payments"><option value="">Collections and payments</option><option value="in" ${f.kind === "in" ? "selected" : ""}>Collections</option><option value="out" ${f.kind === "out" ? "selected" : ""}>Payments</option></select>
        <select data-cff="type" aria-label="Type"><option value="">All types</option><option value="__none" ${f.type === "__none" ? "selected" : ""}>No type (${noType})</option>${S.types.map((t) => `<option value="${esc(t.code)}" ${f.type === t.code ? "selected" : ""}>${esc(t.code)}</option>`).join("")}</select>
        <select data-cff="bucket" aria-label="Urgency"><option value="">Any urgency</option><option value="1" ${f.bucket === "1" ? "selected" : ""}>1 / 11 within a month</option><option value="2" ${f.bucket === "2" ? "selected" : ""}>2 / 22 within two months</option><option value="3" ${f.bucket === "3" ? "selected" : ""}>3 / 33 long term</option></select>
        <select data-cff="pri" aria-label="Priority"><option value="">Any priority</option>${PRIORITIES.map((p) => `<option ${f.pri === p ? "selected" : ""}>${p}</option>`).join("")}</select>
        <select data-cff="status" aria-label="Status"><option value="open" ${f.status === "open" ? "selected" : ""}>Open</option><option value="settled" ${f.status === "settled" ? "selected" : ""}>Settled</option><option value="written_off" ${f.status === "written_off" ? "selected" : ""}>Written off</option><option value="all" ${f.status === "all" ? "selected" : ""}>All</option></select>
        <span class="small muted">${list.length} row${list.length === 1 ? "" : "s"} · collect ${plain(inT)} · pay ${plain(outT)}</span><span style="margin-left:auto" class="toolbar"><button class="btn" data-cf="xlsx-list">Download Excel</button>${writableUnits().length ? `<button class="btn primary" data-cf="item-new">+ Add</button>` : ""}</span></div>
      ${noType ? `<div class="banner info" style="margin:12px 16px 0">${noType} open row${noType > 1 ? "s have" : " has"} no type. Choose one in the Type column so it adds up in the summaries. <button class="btn small" data-cf="no-type">Show them</button></div>` : ""}
      ${list.length ? `<div class="scroll"><table class="cf-list"><thead><tr><th>Unit</th><th>Party and description</th><th></th><th>Type</th><th title="1 / 11 within a month, 2 / 22 within two months, 3 / 33 long term">Code</th><th>Amount</th><th>Priority</th><th title="When it is expected. Blank: about 30, 60 or 120 days from today, by code">Expected</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${list.length > f.show ? `<div class="toolbar" style="padding:12px 16px"><button class="btn" data-cf="more">Show more</button></div>` : ""}` : `<div class="empty"><b>Nothing here</b>Change the filters, or add a collection or payment.</div>`}`;
  }

  // ----- by type -----
  function renderCategory() {
    const units = scopeUnits(), mk = (kind, title) => { const rows = byType(S.items, S.types, S.asOf, units, kind, { fx: fx() }); if (!rows.length) return "";
      const tot = { byUnit: {}, byBucket: [0, 0, 0], total: 0, n: 0 }; rows.forEach((r) => { tot.total += r.total; tot.n += r.n; r.byBucket.forEach((v, i) => (tot.byBucket[i] += v)); Object.entries(r.byUnit).forEach(([u, v]) => (tot.byUnit[u] = (tot.byUnit[u] || 0) + v)); });
      const cell = (r) => `${units.map((u) => `<td class="num">${money(r.byUnit[u])}</td>`).join("")}${r.byBucket.map((v) => `<td class="num">${money(v)}</td>`).join("")}<td class="num strong">${money(r.total)}</td>`;
      return `<h3 style="margin:14px 16px 6px">${title}</h3><div class="scroll"><table class="cf-table"><thead><tr><th>Type</th><th>Rows</th>${units.map((u) => `<th>${esc(ushort(u))}</th>`).join("")}<th>${kind === "in" ? "1" : "11"}</th><th>${kind === "in" ? "2" : "22"}</th><th>${kind === "in" ? "3" : "33"}</th><th>Total</th></tr></thead><tbody>
        ${rows.map((r) => { const t = typeByCode(r.code); return `<tr class="${r.code ? "clickable" : "cf-bad clickable"}" data-cf="cat-open" data-kind="${kind}" data-code="${esc(r.code || "__none")}" tabindex="0"><td><b>${esc(r.code || "No type")}</b>${t && t.label && t.label !== t.code ? `<div class="small muted">${esc(t.label)}</div>` : ""}${!r.code ? '<div class="small muted">choose a type in the list</div>' : ""}</td><td class="num small">${r.n}</td>${cell(r)}</tr>`; }).join("")}
        <tr class="tot"><td><b>Total</b></td><td class="num small">${tot.n}</td>${cell(tot)}</tr></tbody></table></div>`; };
    return `${controls(true)}${usdWarn()}<div class="small muted" style="padding:0 16px 4px">Open collections and payments as of ${esc(dShort(S.asOf))}, added up by type, unit and urgency. Click a row to see its lines. <button class="btn small" data-cf="xlsx-cat">Download Excel</button></div>${mk("in", "Collections")}${mk("out", "Payments")}${S.items.length ? "" : `<div class="empty"><b>No data yet</b></div>`}`;
  }

  // ----- bank balances -----
  function renderBank() {
    const units = scopeUnits(), days = bankDays(S.bank, allUnits()), day = S.bday || (days.filter((d) => d <= S.asOf).pop() || S.asOf);
    const rows = S.bank.filter((b) => b.day === day && units.includes(b.unit)).sort((a, b) => a.unit.localeCompare(b.unit) || a.bank.localeCompare(b.bank));
    const prev = days.filter((d) => d < day).pop() || "";
    const unitRows = units.map((u) => { const r = rows.filter((x) => x.unit === u); if (!r.length) return `<tr><td><b>${esc(uname(u))}</b></td><td colspan="5" class="small muted">nothing entered for this day</td><td>${canWrite(u) ? `<button class="btn small" data-cf="bank-new" data-unit="${esc(u)}">+ Add</button>` : ""}</td></tr>`;
      return r.map((x, i) => `<tr class="${canWrite(u) ? "clickable" : ""}" ${canWrite(u) ? `data-cf="bank-open" data-id="${esc(x.id)}" tabindex="0"` : ""}><td>${i ? "" : `<b>${esc(uname(u))}</b>`}</td><td>${esc(x.bank)}</td><td class="num">${money(x.opening)}</td><td class="num">${money(x.inflow)}</td><td class="num">${money(x.outflow)}</td><td class="num strong">${money(x.closing, false)}</td><td>${i === 0 && canWrite(u) ? `<button class="btn small" data-cf="bank-new" data-unit="${esc(u)}">+ Add</button>` : ""}</td></tr>`).join("") + (r.length > 1 ? `<tr class="sub"><td></td><td class="small muted">${esc(ushort(u))} total</td><td class="num">${money(sum(r, (x) => x.opening))}</td><td class="num">${money(sum(r, (x) => x.inflow))}</td><td class="num">${money(sum(r, (x) => x.outflow))}</td><td class="num strong">${money(sum(r, (x) => x.closing), false)}</td><td></td></tr>` : ""); }).join("");
    const hist = days.slice(-14).reverse();
    return `<div class="toolbar cf-controls"><label class="small muted">Day <input type="date" data-cfc="bday" value="${esc(day)}"></label>${prev ? `<button class="btn small" data-cf="bday-prev" data-day="${esc(prev)}">Previous day with data</button>` : ""}${allUnits().length > 1 ? unitSel("scope", S.scope) : ""}
      ${writableUnits().length && prev ? `<button class="btn" data-cf="bank-copy" data-from="${esc(prev)}" data-to="${esc(day)}">Copy bank lines from ${esc(dShort(prev))}</button>` : ""}<button class="btn" data-cf="xlsx-bank">Download Excel</button></div>
      <div class="scroll"><table class="cf-table"><thead><tr><th>Unit</th><th>Bank</th><th>Opening</th><th>In</th><th>Out</th><th>Closing balance</th><th></th></tr></thead><tbody>${unitRows}
        <tr class="tot"><td><b>Total</b></td><td></td><td class="num">${money(sum(rows, (x) => x.opening))}</td><td class="num">${money(sum(rows, (x) => x.inflow))}</td><td class="num">${money(sum(rows, (x) => x.outflow))}</td><td class="num strong">${money(sum(rows, (x) => x.closing), false)}</td><td></td></tr></tbody></table></div>
      <h3 style="margin:16px 16px 6px">Recent days</h3><div class="scroll"><table class="cf-table"><thead><tr><th>Day</th>${units.map((u) => `<th>${esc(ushort(u))}</th>`).join("")}<th>Total</th></tr></thead><tbody>${hist.map((d) => `<tr class="clickable" data-cf="bday-pick" data-day="${esc(d)}" tabindex="0"><td>${esc(dShort(d))}</td>${units.map((u) => `<td class="num">${money(bankAt(S.bank, u, d).total, false)}</td>`).join("")}<td class="num strong">${money(sum(units, (u) => bankAt(S.bank, u, d).total), false)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  // ----- forecast and plan -----
  function renderForecast() {
    const units = scopeUnits(), mode = S.mode, tl = timeline(S.items, S.bank, S.plan, S.types, S.asOf, units, mode, { fx: fx(), incl: S.incl }), showPlan = mode !== "day";
    const mb = (m, l) => `<button class="btn${mode === m ? " on" : ""}" data-cf="mode" data-v="${m}">${l}</button>`;
    const body = tl.rows.map((r) => { const net = r.projIn - r.projOut; return `<tr class="${r.past ? "dim" : ""}${r.now ? " cf-now" : ""}"><td><b>${esc(r.label)}</b>${r.now ? ' <span class="tag">now</span>' : ""}</td>
      <td class="num">${r.hasBank ? money(r.actIn) : '<span class="muted">–</span>'}</td><td class="num">${r.hasBank ? money(r.actOut) : '<span class="muted">–</span>'}</td>
      ${showPlan ? `<td class="num">${money(r.planIn)}</td><td class="num">${money(r.planOut)}</td>` : ""}<td class="num">${r.past ? '<span class="muted">–</span>' : money(r.projIn)}</td><td class="num">${r.past ? '<span class="muted">–</span>' : money(r.projOut)}</td><td class="num">${r.past ? '<span class="muted">–</span>' : money(net, false)}</td>
      <td class="num strong">${r.closing === null ? '<span class="muted">–</span>' : money(r.closing, false)}</td></tr>`; }).join("");
    const plans = S.plan.filter((p) => units.includes(p.unit)).sort((a, b) => a.month.localeCompare(b.month) || a.unit.localeCompare(b.unit) || a.kind.localeCompare(b.kind));
    const pm = planByMonth(S.plan, units);
    const secRows = SECTIONS.slice(0, 3).flatMap(([s, l]) => ["in", "out"].map((k) => { const r = pm.rows[`${s}|${k}`]; return r ? `<tr><td>${l} ${k === "in" ? "inflow" : "outflow"}</td>${pm.months.map((m) => `<td class="num">${money(r[m])}</td>`).join("")}</tr>` : ""; })).join("");
    const netRow = `<tr class="tot"><td><b>Net cash flow (plan)</b></td>${pm.months.map((m) => `<td class="num strong">${money(sum(Object.entries(pm.rows), ([k, v]) => (k.endsWith("|in") ? 1 : -1) * num(v[m])), false)}</td>`).join("")}</tr>`;
    return `${controls(true)}${usdWarn()}
      <div class="toolbar" style="padding:0 16px 8px">${mb("day", "Daily")}${mb("month", "Monthly")}${mb("quarter", "Quarterly")}<span class="small muted">Rolls forward from the as-of date: ${HORIZON[mode].past} earlier and ${HORIZON[mode].future} coming ${mode === "day" ? "days" : mode === "month" ? "months" : "quarters"}.</span></div>
      <div class="scroll"><table class="cf-table"><thead><tr><th>${mode === "day" ? "Day" : mode === "month" ? "Month" : "Quarter"}</th><th title="From the daily bank report">Actual in</th><th title="From the daily bank report">Actual out</th>${showPlan ? "<th>Plan in</th><th>Plan out</th>" : ""}<th title="Open collections still to come">Expected in</th><th title="Open payables still to pay">Expected out</th><th>Expected net</th><th title="Past: bank balance. Coming: bank balance now plus expected net">Closing balance</th></tr></thead><tbody>${body}</tbody></table></div>
      <div class="small muted" style="padding:8px 16px">Expected amounts use the date entered on a row. Rows without a date are placed about 30 days (code 1 / 11), 60 days (2 / 22) or 120 days (3 / 33) after the as-of date. Actual in and out come from the daily bank report. Plan lines are the monthly forecast finance prepared.</div>
      <div style="padding:8px 16px"><div class="toolbar" style="justify-content:space-between"><h3 style="margin:8px 0">Plan lines</h3>${writableUnits().length ? `<button class="btn primary" data-cf="plan-new">+ Plan line</button>` : ""}</div>
      ${pm.months.length ? `<div class="scroll"><table class="cf-table"><thead><tr><th>Cash flow plan</th>${pm.months.map((m) => `<th>${esc(periodLabel(m, "month"))}</th>`).join("")}</tr></thead><tbody>${secRows}${netRow}</tbody></table></div>` : ""}
      ${plans.length ? `<details style="margin-top:10px"><summary class="small"><b>${plans.length} plan line${plans.length > 1 ? "s" : ""}</b> (open to edit)</summary><div class="scroll"><table><thead><tr><th>Unit</th><th>Month</th><th>Section</th><th></th><th>Line</th><th>Amount</th><th></th></tr></thead><tbody>${plans.map((p) => `<tr><td class="small">${esc(ushort(p.unit))}</td><td class="small">${esc(periodLabel(p.month, "month"))}</td><td class="small">${esc((SECTIONS.find((s) => s[0] === p.section) || [])[1] || p.section)}</td><td class="small">${p.kind === "in" ? "Inflow" : "Outflow"}</td><td>${esc(p.label)}</td><td class="num">${money(p.amount, false)}</td><td>${canWrite(p.unit) ? `<button class="btn small" data-cf="plan-open" data-id="${esc(p.id)}">Edit</button>` : ""}</td></tr>`).join("")}</tbody></table></div></details>` : `<div class="empty"><b>No plan lines yet</b>${writableUnits().length ? "Add the monthly forecast, for example collections expected, rent, payroll, CAPEX or loan repayments." : ""}</div>`}</div>`;
  }

  // ----- types -----
  function renderTypes() {
    const use = {}; S.items.forEach((i) => { if (i.typeCode) use[i.typeCode] = (use[i.typeCode] || 0) + 1; });
    const unconf = S.types.filter((t) => !t.confirmed).length;
    const rows = [...S.types].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "in" ? -1 : 1) || a.sort - b.sort).map((t) => `<tr class="${t.active ? "" : "dim"}"><td><b>${esc(t.code)}</b></td><td>${esc(t.label)}${!t.label || t.label === t.code ? ' <span class="small muted">no description yet</span>' : ""}</td><td class="small">${t.kind === "in" ? "Collections" : t.kind === "out" ? "Payments" : "Both"}</td>
      <td class="small">${esc((SECTIONS.find((s) => s[0] === t.section) || [])[1] || "")}</td><td class="small">${esc(t.group || "")}</td><td class="small">${t.expected ? "Yes" : "No"}</td><td class="small">${t.confirmed ? '<span class="pill s-done">Confirmed</span>' : '<span class="pill s-not">To confirm</span>'}</td><td class="num small">${use[t.code] || 0}</td><td>${canWriteAny() ? `<button class="btn small" data-cf="type-open" data-id="${esc(t.id)}">Edit</button>` : ""}</td></tr>`).join("");
    return `<div class="toolbar" style="padding:0 16px 8px"><span class="small muted">The list behind the Type dropdown. ${unconf} of ${S.types.length} still to confirm with finance.</span><span style="margin-left:auto" class="toolbar"><button class="btn" data-cf="xlsx-types">Download list for finance</button>${canWriteAny() ? `<button class="btn primary" data-cf="type-new">+ Add type</button>` : ""}</span></div>
      ${admin() ? `<div class="toolbar" style="padding:0 16px 8px"><label class="small">USD to ETB rate <input type="number" id="cfFx" min="0" step="any" value="${esc(S.settings.usd_etb || "")}" style="width:110px"></label><button class="btn small" data-cf="fx-save">Save rate</button><span class="small muted">Used to add USD rows into the ETB totals.</span></div>` : ""}
      <div class="scroll"><table><thead><tr><th>Code</th><th>Meaning</th><th>For</th><th>Cash flow section</th><th>Group</th><th title="No: not expected to be collected or paid soon, left out of the position unless included">Counted</th><th>Status</th><th>Rows</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ---------------- forms ----------------
  function drawModal() {
    let root = document.getElementById("cfModalRoot");
    if (!root) { root = document.createElement("div"); root.id = "cfModalRoot"; document.body.append(root); root.addEventListener("click", (e) => { const el = e.target.closest("[data-cf]"); if (el) onAction(el); else if (e.target.classList && e.target.classList.contains("overlay")) closeModal(); }); root.addEventListener("change", (e) => { if (e.target.id === "ci-type" && e.target.value === "__new__") onAction({ dataset: { cf: "type-from-item" } }); }); }
    const m = S.m; if (!m) { root.innerHTML = ""; return; }
    const body = m.type === "item" ? itemForm(m) : m.type === "settle" ? settleForm(m) : m.type === "bank" ? bankForm(m) : m.type === "plan" ? planForm(m) : typeForm(m);
    root.innerHTML = `<div class="overlay"><div class="modal wide xmodal" role="dialog" aria-modal="true">${body}</div></div>`;
    const first = root.querySelector("input[type=text], input[type=number], textarea"); if (first && m.isNew && !m.focused) { m.focused = true; first.focus(); }
  }
  const closeModal = () => { S.m = null; drawModal(); c.render(); };
  const field = (id, label, inner, wide) => `<div class="field${wide ? " wide" : ""}"><label for="${id}">${label}</label>${inner}</div>`;
  const opt = (list, cur) => list.map((x) => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("");
  const v = (id) => { const e = document.getElementById(id); return e ? e.value : ""; };
  const footer = (m, saveKey, delKey, extra) => `<div class="save-bar"><div class="toolbar">${delKey && !m.isNew ? `<button class="btn danger" data-cf="${delKey}">${m.confirmDel ? "Click again to delete" : "Delete"}</button>` : ""}${extra || ""}</div><div class="toolbar"><button class="btn" data-cf="close">Cancel</button><button class="btn primary" data-cf="${saveKey}">Save</button></div></div>`;
  const unitOpts = (cur) => writableUnits().map((u) => `<option value="${esc(u)}" ${u === cur ? "selected" : ""}>${esc(uname(u))}</option>`).join("");

  function readItem() { const r = S.m.row; Object.assign(r, { unit: v("ci-unit") || r.unit, kind: v("ci-kind") || r.kind, party: v("ci-party").trim(), description: v("ci-desc").trim(), ref: v("ci-ref").trim(), typeCode: v("ci-type") === "__new__" ? r.typeCode : v("ci-type"), bucket: Number(v("ci-bucket")) || 1, amount: v("ci-amt"), currency: v("ci-cur") || "ETB", priority: v("ci-pri"), expected: v("ci-exp"), note: v("ci-note").trim(), status: v("ci-st") || r.status, settledOn: v("ci-sdate") }); }
  function itemForm(m) {
    const r = m.row;
    return `<div class="panel-head"><h2>${m.isNew ? "Add a collection or payment" : "Collection or payment"}</h2></div><div class="xgrid">
      ${field("ci-unit", "Unit", `<select id="ci-unit" ${m.isNew ? "" : "disabled"}>${unitOpts(r.unit)}</select>`)}${field("ci-kind", "Kind", `<select id="ci-kind" ${m.isNew ? "" : "disabled"}><option value="in" ${r.kind === "in" ? "selected" : ""}>Collection (money coming in)</option><option value="out" ${r.kind === "out" ? "selected" : ""}>Payment (money going out)</option></select>`)}
      ${field("ci-party", "Customer or payee", `<input type="text" id="ci-party" value="${esc(r.party)}">`)}${field("ci-ref", "Invoice or reference no.", `<input type="text" id="ci-ref" value="${esc(r.ref)}">`)}
      ${field("ci-desc", "Description", `<input type="text" id="ci-desc" value="${esc(r.description)}">`, true)}
      ${field("ci-type", "Type", `<select id="ci-type">${typeOptions(r.kind, r.typeCode, true)}</select>`)}${field("ci-bucket", "Urgency code", `<select id="ci-bucket"><option value="1" ${r.bucket === 1 ? "selected" : ""}>${bucketCode(r.kind, 1)} · within a month</option><option value="2" ${r.bucket === 2 ? "selected" : ""}>${bucketCode(r.kind, 2)} · within two months</option><option value="3" ${r.bucket === 3 ? "selected" : ""}>${bucketCode(r.kind, 3)} · long term</option></select>`)}
      ${field("ci-amt", "Amount", `<input type="number" id="ci-amt" min="0" step="any" value="${esc(String(r.amount ?? ""))}">`)}${field("ci-cur", "Currency", `<select id="ci-cur">${opt(CURRENCIES, r.currency)}</select>`)}
      ${field("ci-pri", "Priority", `<select id="ci-pri">${opt(PRIORITIES, r.priority)}</select>`)}${field("ci-exp", "Expected date (optional)", `<input type="date" id="ci-exp" value="${esc(r.expected || "")}">`)}
      ${m.isNew ? "" : field("ci-st", "Status", `<select id="ci-st"><option value="open" ${r.status === "open" ? "selected" : ""}>Open</option><option value="settled" ${r.status === "settled" ? "selected" : ""}>${r.kind === "in" ? "Collected" : "Paid"}</option><option value="written_off" ${r.status === "written_off" ? "selected" : ""}>Written off</option></select>`)}${m.isNew ? "" : field("ci-sdate", "Date settled", `<input type="date" id="ci-sdate" value="${esc(r.settledOn || "")}">`)}
      ${field("ci-note", "Note", `<textarea id="ci-note" rows="2">${esc(r.note)}</textarea>`, true)}</div>${footer(m, "item-save", "item-del")}`;
  }
  function settleForm(m) {
    const r = m.row, word = r.kind === "in" ? "collected" : "paid";
    return `<div class="panel-head"><div><h2>${r.kind === "in" ? "Collected" : "Paid"}: ${esc(r.party || r.description)}</h2><div class="small muted">Open amount ${plain(r.amount)} ${esc(r.currency)}. Enter less to record a part payment; the rest stays open.</div></div></div><div class="xgrid">
      ${field("cs-amt", `Amount ${word}`, `<input type="number" id="cs-amt" min="0" step="any" value="${esc(String(r.amount))}">`)}${field("cs-date", "Date", `<input type="date" id="cs-date" value="${esc(c.todayIso)}">`)}</div>
      ${footer(m, "settle-save", null, `<button class="btn" data-cf="settle-off">Write off instead</button>`)}`;
  }
  function bankForm(m) {
    const r = m.row;
    return `<div class="panel-head"><h2>${m.isNew ? "Add a bank line" : "Bank line"}</h2></div><div class="xgrid">
      ${field("cb-unit", "Unit", `<select id="cb-unit" ${m.isNew ? "" : "disabled"}>${unitOpts(r.unit)}</select>`)}${field("cb-day", "Day", `<input type="date" id="cb-day" value="${esc(r.day)}" ${m.isNew ? "" : "disabled"}>`)}
      ${field("cb-bank", "Bank (or “All banks” for one total)", `<input type="text" id="cb-bank" list="cb-banks" value="${esc(r.bank)}" ${m.isNew ? "" : "disabled"}><datalist id="cb-banks">${[...new Set(S.bank.map((b) => b.bank))].sort().map((b) => `<option value="${esc(b)}">`).join("")}</datalist>`, true)}
      ${field("cb-open", "Opening balance", `<input type="number" id="cb-open" step="any" value="${esc(String(r.opening ?? 0))}">`)}${field("cb-in", "In", `<input type="number" id="cb-in" step="any" value="${esc(String(r.inflow ?? 0))}">`)}
      ${field("cb-out", "Out", `<input type="number" id="cb-out" step="any" value="${esc(String(r.outflow ?? 0))}">`)}${field("cb-close", "Closing balance", `<input type="number" id="cb-close" step="any" value="${esc(String(r.closing ?? 0))}">`)}
      <div class="field wide small muted">The closing balance is opening plus in minus out. <button type="button" class="btn small" data-cf="bank-calc">Work it out</button></div></div>${footer(m, "bank-save", "bank-del")}`;
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
      ${field("ct-desc", "Description", `<textarea id="ct-desc" rows="2">${esc(r.description || "")}</textarea>`, true)}</div>${footer(m, "type-save", null)}`;
  }

  // ---------------- actions ----------------
  const newItem = (kind) => ({ id: undefined, unit: writableUnits().includes(S.scope) ? S.scope : writableUnits()[0], kind: kind || "in", party: "", description: "", ref: "", typeCode: "", bucket: 1, amount: "", currency: "ETB", priority: "Normal", expected: "", status: "open", settledOn: "", note: "", enteredOn: c.todayIso });
  async function onAction(el) {
    const x = el.dataset.cf, id = el.dataset.id, m = S.m, it = id ? S.items.find((q) => q.id === id) : null;
    if (x === "view") { S.view = el.dataset.v; c.render(); }
    else if (x === "today") { S.asOf = c.todayIso; c.render(); }
    else if (x === "mode") { S.mode = el.dataset.v; c.render(); }
    else if (x === "more") { S.lf.show += 50; c.render(); }
    else if (x === "no-type") { S.lf.type = "__none"; S.lf.status = "open"; c.render(); }
    else if (x === "cat-open") { S.lf.kind = el.dataset.kind; S.lf.type = el.dataset.code; S.lf.status = "open"; S.lf.q = ""; S.view = "list"; c.render(); }
    else if (x === "close") closeModal();
    else if (x === "item-new") { S.m = { type: "item", isNew: true, row: newItem(S.lf.kind || "in") }; drawModal(); }
    else if (x === "item-open" && it) { S.m = { type: "item", isNew: false, row: clone(it) }; drawModal(); }
    else if (x === "item-save") {
      readItem(); const r = m.row; if (!r.unit) { c.toast("Choose the unit"); return; } if (!r.party && !r.description) { c.toast("Write who it is from or to, or a description"); return; } if (num(r.amount) <= 0 && m.isNew) { c.toast("Enter the amount"); return; }
      if (r.status !== "open" && !r.settledOn) r.settledOn = c.todayIso; if (r.status === "open") r.settledOn = "";
      if (await saveItem(itemRow({ ...r, id: m.isNew ? undefined : r.id }), "Saved")) { S.m = null; drawModal(); }
    }
    else if (x === "item-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } if (await save(() => c.api().deleteCf(A(), "cf_items", m.row.id), "Deleted")) { S.m = null; drawModal(); } }
    else if (x === "settle" && it) { S.m = { type: "settle", row: clone(it) }; drawModal(); }
    else if (x === "settle-save" || x === "settle-off") {
      const r = m.row, amt = num(v("cs-amt")), date = v("cs-date") || c.todayIso, off = x === "settle-off";
      if (!off && (amt <= 0)) { c.toast("Enter the amount"); return; }
      if (off || amt >= num(r.amount)) { if (await saveItem(itemRow({ ...r, status: off ? "written_off" : "settled", settledOn: date }), off ? "Written off" : "Recorded")) { S.m = null; drawModal(); } }
      else {
        const left = { ...r, amount: num(r.amount) - amt }, paid = { ...r, id: undefined, amount: amt, status: "settled", settledOn: date, note: ((r.note ? r.note + " " : "") + "Part payment.").trim() };
        if (await saveItem(itemRow(paid)) && await saveItem(itemRow(left), "Part recorded, the rest stays open")) { S.m = null; drawModal(); }
      }
    }
    // bank
    else if (x === "bank-new") { S.m = { type: "bank", isNew: true, row: { unit: el.dataset.unit || writableUnits()[0], day: S.bday || bankDaySel(), bank: "All banks", opening: 0, inflow: 0, outflow: 0, closing: 0 } }; drawModal(); }
    else if (x === "bank-open") { const b = S.bank.find((q) => q.id === id); if (b) { S.m = { type: "bank", isNew: false, row: clone(b) }; drawModal(); } }
    else if (x === "bank-calc") { const o = num(v("cb-open")), i = num(v("cb-in")), u = num(v("cb-out")); document.getElementById("cb-close").value = String(Math.round((o + i - u) * 100) / 100); }
    else if (x === "bank-save") {
      const r = m.row, row = { unit: v("cb-unit") || r.unit, day: v("cb-day") || r.day, bank: v("cb-bank").trim() || "All banks", opening: num(v("cb-open")), inflow: num(v("cb-in")), outflow: num(v("cb-out")), closing: num(v("cb-close")) };
      if (!row.day) { c.toast("Choose the day"); return; }
      if (await save(() => c.api().saveCfBank(A(), row), "Saved")) { S.bday = row.day; S.m = null; drawModal(); }
    }
    else if (x === "bank-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } if (await save(() => c.api().deleteCf(A(), "cf_bank", m.row.id), "Deleted")) { S.m = null; drawModal(); } }
    else if (x === "bday-prev" || x === "bday-pick") { S.bday = el.dataset.day; S.view = "bank"; c.render(); }
    else if (x === "bank-copy") {
      const from = el.dataset.from, to = el.dataset.to, units = scopeUnits().filter((u) => canWrite(u)), have = new Set(S.bank.filter((b) => b.day === to).map((b) => b.unit + "|" + b.bank));
      const src = S.bank.filter((b) => b.day === from && units.includes(b.unit) && !have.has(b.unit + "|" + b.bank));
      if (!src.length) { c.toast("Nothing to copy"); return; }
      S.busy = true; try { for (const b of src) { const r = await c.api().saveCfBank(A(), { unit: b.unit, bank: b.bank, day: to, opening: b.closing, inflow: 0, outflow: 0, closing: b.closing }); if (r && r.error) { c.toast(c.errText(r)); break; } } c.toast(`${src.length} bank line${src.length > 1 ? "s" : ""} copied. Enter today's in, out and closing balance.`); } finally { S.busy = false; c.render(); }
    }
    // plan
    else if (x === "plan-new" || x === "plan-fin") { const nm = addMonths(monthOf(S.asOf), 1); S.m = { type: "plan", isNew: true, row: { unit: writableUnits().includes(S.scope) ? S.scope : writableUnits()[0], month: nm, kind: "in", section: x === "plan-fin" ? "financing" : "operating", label: x === "plan-fin" ? "Proceeds from borrowings" : "", amount: "" } }; drawModal(); }
    else if (x === "plan-open") { const p = S.plan.find((q) => q.id === id); if (p) { S.m = { type: "plan", isNew: false, row: clone(p) }; drawModal(); } }
    else if (x === "plan-save") {
      const r = m.row, row = { id: m.isNew ? undefined : r.id, unit: v("cp-unit"), month: v("cp-month"), kind: v("cp-kind"), section: v("cp-sec"), label: v("cp-label").trim(), amount: num(v("cp-amt")), note: v("cp-note").trim() };
      if (!row.label || !row.month) { c.toast("Fill in the month and the line"); return; }
      if (await save(() => c.api().saveCfPlan(A(), row), "Saved")) { S.m = null; drawModal(); }
    }
    else if (x === "plan-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } if (await save(() => c.api().deleteCf(A(), "cf_plan", m.row.id), "Deleted")) { S.m = null; drawModal(); } }
    // types
    else if (x === "type-new") { S.m = { type: "type", isNew: true, row: { code: "", label: "", kind: "both", section: "operating", group: "", description: "", expected: true, confirmed: false, active: true } }; drawModal(); }
    else if (x === "type-open") { const t = S.types.find((q) => q.id === id); if (t) { S.m = { type: "type", isNew: false, row: clone(t) }; drawModal(); } }
    else if (x === "type-from-item") { readItem(); S.m = { type: "type", isNew: true, back: S.m, row: { code: "", label: "", kind: S.m.row.kind, section: "operating", group: "", description: "", expected: true, confirmed: false, active: true } }; drawModal(); }
    else if (x === "type-save") {
      const r = m.row, row = { id: m.isNew ? undefined : r.id, code: v("ct-code").trim(), label: v("ct-label").trim(), kind: v("ct-kind"), section: v("ct-sec"), group: v("ct-grp").trim(), description: v("ct-desc").trim(), expected: v("ct-exp") !== "no", sort: r.sort };
      if (document.getElementById("ct-conf")) row.confirmed = v("ct-conf") === "yes"; if (document.getElementById("ct-act")) row.active = v("ct-act") !== "no";
      if (!row.code) { c.toast("Enter the code"); return; }
      const res = await save(() => c.api().saveCfType(A(), row), "Saved"); if (!res) return;
      if (m.back) { S.m = m.back; S.m.row.typeCode = row.code; drawModal(); } else if (m.applyTo) { const target = S.items.find((q) => q.id === m.applyTo); S.m = null; drawModal(); if (target) saveItem(itemRow({ ...target, typeCode: row.code })); } else { S.m = null; drawModal(); }
    }
    else if (x === "fx-save") { const val = (document.getElementById("cfFx") || {}).value || ""; await save(() => c.api().saveCfSetting(A(), "usd_etb", val), "Rate saved"); }
    else if (x === "xlsx-list") xlsx("list"); else if (x === "xlsx-cat") xlsx("cat"); else if (x === "xlsx-bank") xlsx("bank"); else if (x === "xlsx-types") xlsx("types");
  }
  const bankDaySel = () => { const d = bankDays(S.bank, allUnits()).filter((q) => q <= S.asOf).pop(); return d || S.asOf; };

  async function onQuick(el) {
    const it = S.items.find((q) => q.id === el.dataset.id); if (!it || !canWrite(it.unit)) return;
    const k = el.dataset.cfq, val = el.value;
    if (k === "type" && val === "__new__") { S.m = { type: "type", isNew: true, applyTo: it.id, row: { code: "", label: "", kind: it.kind, section: "operating", group: "", description: "", expected: true, confirmed: false, active: true } }; drawModal(); return; }
    const patch = k === "type" ? { typeCode: val } : k === "priority" ? { priority: val } : { expected: val };
    await saveItem(itemRow({ ...it, ...patch }), "Saved");
  }
  function onControl(el) {
    const k = el.dataset.cfc;
    if (k === "asOf") { if (el.value) S.asOf = el.value; } else if (k === "scope") S.scope = el.value; else if (k === "incl") S.incl = el.checked; else if (k === "bday") { if (el.value) S.bday = el.value; }
    c.render();
  }
  function onFilter(el) { S.lf[el.dataset.cff] = el.value; S.lf.show = 50; c.render(); if (el.dataset.cff === "q") { const e = document.querySelector('[data-cff="q"]'); if (e) { e.focus(); e.setSelectionRange(e.value.length, e.value.length); } } }

  const main = document.getElementById("main");
  main.addEventListener("click", (e) => { if (e.target.closest("select,input")) return; const el = e.target.closest("[data-cf]"); if (el) onAction(el); });
  main.addEventListener("keydown", (e) => { const el = e.target.closest && e.target.closest("tr[data-cf]"); if (el && (e.key === "Enter" || e.key === " ") && !e.target.closest("select,input,button")) { e.preventDefault(); onAction(el); } });
  main.addEventListener("change", (e) => { const t = e.target; if (!t.dataset) return; if (t.dataset.cfq) onQuick(t); else if (t.dataset.cfc) onControl(t); else if (t.dataset.cff && t.dataset.cff !== "q") onFilter(t); });
  main.addEventListener("input", (e) => { const t = e.target; if (t.dataset && t.dataset.cff === "q") { clearTimeout(onFilter.t); onFilter.t = setTimeout(() => onFilter(t), 250); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.m) closeModal(); });

  // ---------------- Excel ----------------
  async function xlsx(which) {
    if (!c.libsReady("xlsx")) return;
    const X = c.XLSX(), wb = X.utils.book_new(), units = scopeUnits(), sheet = (rows, w, name) => X.utils.book_append_sheet(wb, c.sheetFromRows(rows, w), name);
    let file = "Cash flow";
    if (which === "list") { file = "Collections and payments"; sheet([["Unit", "Collect or pay", "Party", "Description", "Reference", "Type", "Code", "Amount", "Currency", "Priority", "Expected", "Status", "Settled on", "Note"], ...filteredItems().map((i) => [uname(i.unit), KIND_TEXT[i.kind], i.party, i.description, i.ref, i.typeCode, bucketCode(i.kind, i.bucket), num(i.amount), i.currency, i.priority, i.expected || "", i.status, i.settledOn || "", i.note])], [26, 12, 30, 40, 14, 14, 7, 16, 9, 9, 12, 11, 12, 30], "List"); }
    else if (which === "cat") { file = "Cash flow by type"; for (const [kind, name] of [["in", "Collections"], ["out", "Payments"]]) { const rows = byType(S.items, S.types, S.asOf, units, kind, { fx: fx() }); sheet([["Type", "Rows", ...units.map(ushort), kind === "in" ? "1" : "11", kind === "in" ? "2" : "22", kind === "in" ? "3" : "33", "Total"], ...rows.map((r) => [r.code || "No type", r.n, ...units.map((u) => Math.round(r.byUnit[u] || 0)), ...r.byBucket.map(Math.round), Math.round(r.total)])], [18, 7, ...units.map(() => 14), 14, 14, 14, 16], name); } }
    else if (which === "bank") { file = "Bank balances"; sheet([["Day", "Unit", "Bank", "Opening", "In", "Out", "Closing"], ...S.bank.filter((b) => units.includes(b.unit)).sort((a, b) => a.day.localeCompare(b.day) || a.unit.localeCompare(b.unit)).map((b) => [b.day, uname(b.unit), b.bank, num(b.opening), num(b.inflow), num(b.outflow), num(b.closing)])], [12, 26, 22, 16, 16, 16, 16], "Bank"); }
    else { file = "Cash flow types"; const use = {}; S.items.forEach((i) => { if (i.typeCode) use[i.typeCode] = (use[i.typeCode] || 0) + 1; }); sheet([["Code", "Meaning", "For", "Section", "Group", "Counted in the position", "Confirmed by finance", "Rows using it", "Description", "Finance to describe"], ...S.types.map((t) => [t.code, t.label, t.kind, t.section, t.group, t.expected ? "Yes" : "No", t.confirmed ? "Yes" : "No", use[t.code] || 0, t.description, ""])], [20, 36, 10, 14, 18, 14, 14, 10, 50, 40], "Types"); }
    await c.writeXlsx(wb, `${file} ${c.todayIso}.xlsx`, "Excel saved");
  }

  return { renderCash, subscribe, canSee };
}
