// Cash flow, the weekly way of working. Three things are filled in:
//   1. The weekly plan   (what each unit expects to collect and pay this week; unpaid lines roll into the next week)
//   2. Collections and payments each day   (the amount moved is typed against the line's code; the system works out what is left)
//   3. The bank report each day   (opening, in, out, closing per bank)
// The system then checks the daily cash against the bank, flags what does not match, and builds the reports.
import { SECTIONS, CURRENCIES, bucketCode, num, sum, addDays, weekStart, weekEnd, weekLabel, movedIn, reconcileRows, TOLERANCE, bankAt, MONTHS } from "./cashcalc.js";

const SEC_LABEL = Object.fromEntries(SECTIONS);
const SEC_ORDER = ["operating", "investing", "financing", "intercompany", "other"];
const serialToIso = (v) => { if (v === "" || v == null) return ""; if (typeof v === "number") return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10); const s = String(v).trim(); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0]; const d = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return d ? `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}` : ""; };
const bucketOf = (v) => { const x = parseInt(String(v).trim(), 10); return x === 1 || x === 11 ? 1 : x === 2 || x === 22 ? 2 : x === 3 || x === 33 ? 3 : 0; };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const money = (x) => { if (x === "" || x == null) return null; const n = Number(String(x).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const dShort = (iso) => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

export function createWeek(h) {
  const { S, c, esc, A } = h;
  const plain = h.plain, mny = h.money;
  const toDate = (iso) => (iso ? new Date(iso + "T00:00:00Z") : "");

  // ---------------- what a week looks like ----------------
  function weekData(units, W) {
    const E = weekEnd(W), items = new Map(S.items.map((i) => [i.id, i]));
    const rows = S.week.filter((w) => units.includes(w.unit) && w.week === W && items.has(w.itemId)).map((w) => {
      const it = items.get(w.itemId), start = h.viewOf(it, addDays(W, -1)), end = h.viewOf(it, E);
      return { w, it, startLeft: start.left, moved: movedIn(S.log, it.id, W, E), endLeft: end.left };
    }).sort((a, b) => a.it.kind.localeCompare(b.it.kind) * -1 || SEC_ORDER.indexOf(a.it.section || "operating") - SEC_ORDER.indexOf(b.it.section || "operating") || a.it.bucket - b.it.bucket || num(b.w.planned) - num(a.w.planned));
    const planned = new Set(rows.map((r) => r.it.id));
    const loose = S.log.filter((l) => units.includes(l.unit) && l.day >= W && l.day <= E && !planned.has(l.itemId));
    const cand = S.items.filter((it) => units.includes(it.unit) && h.canWrite(it.unit) && it.status === "open" && !planned.has(it.id) && (it.enteredOn || "0000") <= E && h.viewOf(it, addDays(W, -1)).left > 0.005)
      .map((it) => ({ it, left: h.viewOf(it, addDays(W, -1)).left }));
    return { W, E, rows, loose, cand };
  }
  const cashAt = (units, day) => { const eb = h.effBank(); return sum(units, (u) => bankAt(eb, u, day).total); };
  const hasBankBy = (units, day) => { const eb = h.effBank(); return units.some((u) => bankAt(eb, u, day).has); };

  // ---------------- the weekly plan screen ----------------
  function renderWeek() {
    const units = h.scopeUnits(), W = S.wk, d = weekData(units, W), writable = h.writableUnits().length > 0;
    const pin = sum(d.rows.filter((r) => r.it.kind === "in"), (r) => num(r.w.planned)), pout = sum(d.rows.filter((r) => r.it.kind === "out"), (r) => num(r.w.planned));
    const ain = sum(d.rows.filter((r) => r.it.kind === "in"), (r) => r.moved) + sum(d.loose.filter((l) => l.kind === "in"), (l) => l.amount), aout = sum(d.rows.filter((r) => r.it.kind === "out"), (r) => r.moved) + sum(d.loose.filter((l) => l.kind === "out"), (l) => l.amount);
    const begin = cashAt(units, addDays(W, -1)), upTo = d.E < c.todayIso ? d.E : c.todayIso, started = W <= c.todayIso;
    const table = (kind, title) => {
      const list = d.rows.filter((r) => r.it.kind === kind); if (!list.length) return `<section class="cf-card"><h3>${title}</h3><div class="small muted">No ${kind === "in" ? "collections" : "payments"} planned for this week.</div></section>`;
      const secs = SEC_ORDER.filter((s) => list.some((r) => (r.it.section || "operating") === s));
      const body = secs.map((s) => { const part = list.filter((r) => (r.it.section || "operating") === s);
        return `<tr class="cf-sec"><td colspan="9"><b>${esc(SEC_LABEL[s] || s)}</b></td></tr>${part.map((r) => { const w = h.canWrite(r.it.unit), cur = r.it.currency !== "ETB" ? ` <span class="tag">${esc(r.it.currency)}</span>` : "";
          return `<tr class="${r.endLeft <= 0.005 && r.moved > 0 ? "dim" : ""}"><td><span class="tag">${esc(r.it.code || "")}</span>${r.w.rolled ? ' <span class="tag" title="Carried over from an earlier week">rolled</span>' : ""}</td>
            <td><b>${esc(r.it.party || r.it.description || "")}</b>${r.it.party && r.it.description ? `<div class="small muted">${esc(r.it.description)}</div>` : ""}<div class="small muted">${esc(h.ushort(r.it.unit))}${r.it.ref ? " · " + esc(r.it.ref) : ""}</div></td>
            <td class="small" title="${esc(h.typeHint(r.it.typeCode))}">${esc(r.it.typeCode || "")}<div class="muted">${bucketCode(r.it.kind, r.it.bucket)}</div></td>
            <td class="small">${esc(dShort(r.w.due || r.it.expected))}</td>
            <td class="num"><b>${mny(r.w.planned, false)}</b>${cur}</td><td class="num">${r.moved ? mny(r.moved, false) : '<span class="muted">–</span>'}${num(r.w.planned) > 0 && r.moved ? `<div class="small muted">${Math.round((r.moved / num(r.w.planned)) * 100)}%</div>` : ""}</td>
            <td class="num ${r.moved - num(r.w.planned) < -0.5 ? "neg" : ""}">${mny(r.moved - num(r.w.planned))}</td><td class="num">${r.endLeft > 0.005 ? mny(r.endLeft, false) : '<span class="muted">–</span>'}</td>
            <td class="small cf-act"><div class="toolbar"><button class="btn small" data-cf="w-trace" data-id="${esc(r.it.id)}" title="See every week and every day this line appeared">Trace</button>${w ? `<button class="btn small" data-cf="w-edit" data-id="${esc(r.w.id)}">Edit</button><button class="btn small ghost" data-cf="w-remove" data-id="${esc(r.w.id)}" title="Take it out of this week's plan">Remove</button>` : ""}</div></td></tr>`; }).join("")}`; }).join("");
      const tp = sum(list, (r) => num(r.w.planned)), ta = sum(list, (r) => r.moved);
      return `<section class="cf-card flush"><div class="cf-pad"><h3>${title}</h3></div><div class="scroll"><table class="cf-table cf-items"><thead><tr><th>Code</th><th>Party</th><th>Type</th><th>Due</th><th>Planned</th><th>${kind === "in" ? "Collected" : "Paid"}</th><th>Variance</th><th title="What is still to ${kind === "in" ? "collect" : "pay"} at the end of the week">Left</th><th></th></tr></thead>
        <tbody>${body}<tr class="tot"><td colspan="4"><b>Total</b></td><td class="num">${plain(tp)}</td><td class="num">${plain(ta)}</td><td class="num ${ta - tp < -0.5 ? "neg" : ""}">${plain(ta - tp)}</td><td colspan="2"></td></tr></tbody></table></div></section>`; };
    const looseHtml = d.loose.length ? `<section class="cf-card"><h3>Cash that moved but was not in this week's plan</h3><div class="small muted">${d.loose.length} movement${d.loose.length > 1 ? "s" : ""}: collected ${plain(sum(d.loose.filter((l) => l.kind === "in"), (l) => l.amount))}, paid ${plain(sum(d.loose.filter((l) => l.kind === "out"), (l) => l.amount))}. Unplanned cash is welcome; it is listed so the plan can be improved.</div>
      <div class="scroll"><table class="cf-table"><tbody>${d.loose.slice(0, 15).map((l) => `<tr><td class="small">${esc(dShort(l.day))}</td><td><span class="pill ${l.kind === "in" ? "s-done" : "s-not"}">${l.kind === "in" ? "In" : "Out"}</span></td><td>${esc(l.party || l.description || "")}${l.itemCode ? ` <span class="tag">${esc(l.itemCode)}</span>` : ""}</td><td class="small">${esc(l.bank || "")}</td><td class="num">${plain(l.amount)}</td></tr>`).join("")}</tbody></table></div>${d.loose.length > 15 ? `<div class="small muted">and ${d.loose.length - 15} more</div>` : ""}</section>` : "";
    const candHtml = d.cand.length ? `<section class="cf-card cf-roll"><div class="cf-split"><div><h3>${d.cand.length} open line${d.cand.length > 1 ? "s" : ""} not in this week's plan</h3><div class="small muted">Lines still to be collected or paid at the start of this week. Roll them in with what is left as the planned amount, then change the ones you expect to move.</div></div>
      ${writable ? `<button class="btn primary" data-cf="w-roll-all">Roll all ${d.cand.length} into this week</button>` : ""}</div>
      <details><summary class="small">Show the lines</summary><div class="scroll"><table class="cf-table"><tbody>${d.cand.slice(0, 40).map((x) => `<tr><td><span class="tag">${esc(x.it.code || "")}</span></td><td><b>${esc(x.it.party || x.it.description || "")}</b></td><td class="small">${esc(h.ushort(x.it.unit))}</td><td><span class="pill ${x.it.kind === "in" ? "s-done" : "s-not"}">${x.it.kind === "in" ? "Collect" : "Pay"}</span></td><td class="num">${plain(x.left)}</td><td><button class="btn small" data-cf="w-roll-one" data-id="${esc(x.it.id)}">Plan this week</button></td></tr>`).join("")}</tbody></table></div>${d.cand.length > 40 ? `<div class="small muted">and ${d.cand.length - 40} more. Use Roll all.</div>` : ""}</details></section>` : "";
    const wk = `<div class="cf-daybar"><span class="cf-lab">Week</span><button class="btn small" data-cf="w-shift" data-v="-7" aria-label="Previous week">‹</button><b>${esc(weekLabel(W))}</b><button class="btn small" data-cf="w-shift" data-v="7" aria-label="Next week">›</button>
      <input type="date" data-cfc="wk" value="${esc(W)}" aria-label="Pick any day in the week"><button class="btn small" data-cf="w-thisweek">This week</button><span class="small muted">Saturday to Friday</span></div>`;
    return `<div class="cf-body"><div class="cf-filters">${h.allUnits().length > 1 ? h.unitSel(S.scope) : ""}<span style="margin-left:auto" class="cf-group">${writable ? `<button class="btn primary small" data-cf="w-new">+ Add a line</button>` : ""}<button class="btn small" data-cf="w-xl-down" title="A workbook for this week with the lines already filled in">Download weekly plan template</button>${writable ? `<label class="btn small">Upload plan<input type="file" id="cwUploadWeek" accept=".xlsx,.xls" hidden></label>` : ""}</span></div>
      ${wk}
      <div class="cf-stats">${h.stat("Cash at the start", plain(begin), hasBankBy(units, addDays(W, -1)) ? "bank balance the day before" : "no bank report yet")}${h.stat("Planned in", plain(pin))}${h.stat("Planned out", plain(pout))}${h.stat("Expected cash at the end", plain(begin + pin - pout), "start + in − out", begin + pin - pout < 0 ? "neg" : "")}
        ${started ? h.stat("Actually in / out", `${plain(ain)} / ${plain(aout)}`, ain + aout > 0 || d.rows.length ? `${pin ? Math.round((ain / pin) * 100) : 0}% of planned in · ${pout ? Math.round((aout / pout) * 100) : 0}% of planned out` : "") : ""}</div>
      ${candHtml}${table("in", "Collections planned")}${table("out", "Payments planned")}${looseHtml}</div>`;
  }

  // ---------------- add / edit a line in the week ----------------
  function lineForm(m) {
    const r = m.row, ex = !!r.itemId, it = ex ? S.items.find((i) => i.id === r.itemId) : null, field = h.field;
    return `<div class="panel-head"><h2>${m.isNew ? "Add a line to the week of " + esc(dShort(S.wk)) : "Planned line " + esc((it && it.code) || "")}</h2></div><div class="xgrid">
      ${field("cw-unit", "Unit", `<select id="cw-unit" ${ex ? "disabled" : ""}>${h.unitOpts(r.unit)}</select>`)}${field("cw-kind", "Collect or pay", `<select id="cw-kind" ${ex ? "disabled" : ""}><option value="in" ${r.kind === "in" ? "selected" : ""}>Collect (inflow)</option><option value="out" ${r.kind === "out" ? "selected" : ""}>Pay (outflow)</option></select>`)}
      ${field("cw-party", "Customer or payee", `<input type="text" id="cw-party" value="${esc(r.party)}">`)}${field("cw-ref", "Invoice or reference no.", `<input type="text" id="cw-ref" value="${esc(r.ref)}">`)}
      ${field("cw-desc", "Description", `<input type="text" id="cw-desc" value="${esc(r.description)}">`, true)}
      ${field("cw-sec", "Section", `<select id="cw-sec">${SECTIONS.map(([k, l]) => `<option value="${k}" ${k === r.section ? "selected" : ""}>${l}</option>`).join("")}</select>`)}${field("cw-type", "Type", `<select id="cw-type">${h.typeOptions(r.kind, r.typeCode, false)}</select>`)}
      ${field("cw-buck", "Urgency", `<select id="cw-buck">${[1, 2, 3].map((b) => `<option value="${b}" ${Number(r.bucket) === b ? "selected" : ""}>${b} / ${b}${b} · ${["within a month", "within two months", "long term"][b - 1]}</option>`).join("")}</select>`)}${field("cw-due", "Due date (end date)", `<input type="date" id="cw-due" value="${esc(r.due || "")}">`)}
      ${field("cw-plan", "Planned this week", `<input type="number" id="cw-plan" min="0" step="any" value="${esc(String(r.planned ?? ""))}"><div class="small muted">What you expect to ${r.kind === "in" ? "collect" : "pay"} between ${esc(dShort(S.wk))} and ${esc(dShort(weekEnd(S.wk)))}.</div>`)}
      ${ex ? field("cw-left", "Left at the start of the week", `<input type="text" id="cw-left" value="${esc(plain(r.startLeft || 0))}" disabled>`) : field("cw-out", "Total still outstanding (optional)", `<input type="number" id="cw-out" min="0" step="any" value="${esc(String(r.outstanding ?? ""))}"><div class="small muted">If more than this week's plan. Empty means the same as planned.</div>`)}
      ${field("cw-cur", "Currency", `<select id="cw-cur" ${ex ? "disabled" : ""}>${CURRENCIES.map((x) => `<option ${x === r.currency ? "selected" : ""}>${x}</option>`).join("")}</select>`)}${field("cw-note", "Note for this week", `<input type="text" id="cw-note" value="${esc(r.note || "")}">`)}</div>
      <div class="save-bar"><div class="toolbar"></div><div class="toolbar"><button class="btn" data-cf="close">Cancel</button><button class="btn primary" data-cf="w-save">Save</button></div></div>`;
  }
  const readLine = () => { const r = S.m.row, g = h.v; Object.assign(r, { unit: g("cw-unit") || r.unit, kind: g("cw-kind") || r.kind, party: g("cw-party").trim(), ref: g("cw-ref").trim(), description: g("cw-desc").trim(), section: g("cw-sec") || r.section, typeCode: g("cw-type"), bucket: Number(g("cw-buck")) || 1, due: g("cw-due"), planned: g("cw-plan"), outstanding: g("cw-out"), currency: g("cw-cur") || r.currency, note: g("cw-note") }); };
  const blankLine = (kind) => ({ itemId: "", unit: h.writableUnits().includes(S.scope) ? S.scope : h.writableUnits()[0], kind: kind || "in", party: "", ref: "", description: "", section: "operating", typeCode: "", bucket: 1, due: "", planned: "", outstanding: "", currency: "ETB", note: "" });

  async function saveLine() {
    readLine(); const r = S.m.row, planned = num(r.planned);
    if (!r.unit) { c.toast("Choose a unit"); return; } if (!r.party && !r.description) { c.toast("Fill in the customer or payee, or a description"); return; } if (!(planned > 0)) { c.toast("Enter the amount planned for this week"); return; }
    const ok = await h.run(async () => {
      let itemId = r.itemId, it = itemId ? S.items.find((i) => i.id === itemId) : null;
      if (!it) { const out = num(r.outstanding) > 0 ? num(r.outstanding) : planned;
        const res = await c.api().saveCfItem(A(), { unit: r.unit, kind: r.kind, party: r.party, description: r.description, ref: r.ref, typeCode: r.typeCode, bucket: r.bucket, amount: out, total: out, currency: r.currency, priority: "Normal", expected: r.due || "", status: "open", enteredOn: c.todayIso, section: r.section, firstWeek: S.wk, note: "" });
        if (res && res.error) return res; itemId = res.id; }
      else { const res = await c.api().saveCfItem(A(), h.itemRow({ ...it, party: r.party, description: r.description, ref: r.ref, typeCode: r.typeCode, bucket: r.bucket, section: r.section, expected: r.due || it.expected })); if (res && res.error) return res; }
      return c.api().saveCfWeek(A(), { unit: r.unit, week: S.wk, itemId, planned, due: r.due || "", rolled: !!r.rolled, note: r.note });
    }, "Saved");
    if (ok) h.closeModal();
  }
  async function rollIn(list) {
    if (!list.length) return;
    await h.run(async () => { for (const x of list) { const res = await c.api().saveCfWeek(A(), { unit: x.it.unit, week: S.wk, itemId: x.it.id, planned: Math.round(x.left * 100) / 100, due: x.it.expected || "", rolled: true, note: "" }); if (res && res.error) return res; } return { ok: true }; }, `${list.length} line${list.length > 1 ? "s" : ""} rolled into this week`);
  }

  // ---------------- trace one line through the weeks and days ----------------
  function traceView(m) {
    const it = S.itemsAll.find((i) => i.id === m.itemId); if (!it) return `<div class="panel-head"><h2>Line not found</h2></div><div class="save-bar"><div></div><button class="btn" data-cf="close">Close</button></div>`;
    const weeks = S.week.filter((w) => w.itemId === it.id).sort((a, b) => a.week.localeCompare(b.week)), logs = S.log.filter((l) => l.itemId === it.id).sort((a, b) => a.day.localeCompare(b.day));
    const first = weeks[0] ? weeks[0].week : it.firstWeek || weekStart(it.enteredOn || c.todayIso);
    return `<div class="panel-head"><div><h2>${esc(it.party || it.description)} <span class="tag">${esc(it.code || "")}</span></h2><div class="small muted">${it.kind === "in" ? "Collection" : "Payment"} · ${esc(h.uname(it.unit))}${it.ref ? " · " + esc(it.ref) : ""}${it.typeCode ? " · type " + esc(it.typeCode) : ""} · first planned in the week of ${esc(dShort(first))} · ${weeks.length} week${weeks.length === 1 ? "" : "s"} in the plan</div></div></div>
      <div class="small" style="margin:8px 0 4px"><b>Week by week</b></div>
      <div class="scroll"><table class="cf-table"><thead><tr><th>Week</th><th>Planned</th><th>${it.kind === "in" ? "Collected" : "Paid"}</th><th>Left at the end</th><th>Due</th></tr></thead><tbody>${weeks.map((w) => `<tr><td>${esc(weekLabel(w.week))}${w.rolled ? ' <span class="tag">rolled</span>' : ""}</td><td class="num">${plain(w.planned)}</td><td class="num">${plain(movedIn(S.log, it.id, w.week, weekEnd(w.week)))}</td><td class="num">${plain(h.viewOf(it, weekEnd(w.week)).left)}</td><td class="small">${esc(dShort(w.due))}</td></tr>`).join("") || `<tr><td colspan="5" class="small muted">Not in any weekly plan yet.</td></tr>`}</tbody></table></div>
      <div class="small" style="margin:12px 0 4px"><b>Cash recorded against it</b></div>
      <div class="scroll"><table class="cf-table"><thead><tr><th>Day</th><th>Bank</th><th>Amount</th><th>Note</th></tr></thead><tbody>${logs.map((l) => `<tr><td>${esc(dShort(l.day))}</td><td>${esc(l.bank || "")}</td><td class="num">${plain(l.amount)}</td><td class="small">${esc(l.note || "")}</td></tr>`).join("") || `<tr><td colspan="4" class="small muted">Nothing ${it.kind === "in" ? "collected" : "paid"} yet.</td></tr>`}</tbody></table></div>
      <div class="small muted" style="margin-top:8px">Amount outstanding when entered: <b>${plain(it.amount)}</b> · ${it.kind === "in" ? "collected" : "paid"} so far: <b>${plain(sum(logs, (l) => l.amount))}</b> · left: <b>${plain(h.viewOf(it, "9999-12-31").left)}</b></div>
      <div class="save-bar"><div></div><div class="toolbar"><button class="btn" data-cf="close">Close</button></div></div>`;
  }

  // ---------------- reconcile ----------------
  function renderReconcile() {
    const units = h.scopeUnits(), r = S.rc, to = S.day > c.todayIso ? c.todayIso : S.day, from = addDays(to, -(r.range - 1)), rows = reconcileRows(h.effBank().filter((b) => !b.synthetic), S.log, units, from, to, h.fx());
    const bad = rows.filter((x) => x.flags.length), shown = r.all ? rows : bad;
    const days = new Set(rows.map((x) => x.unit + "|" + x.day)).size;
    const chip = (on, a, l) => h.chip(on, a, l);
    const body = shown.map((x) => `<tr class="clickable" data-cf="w-goday" data-day="${esc(x.day)}" data-unit="${esc(x.unit)}" tabindex="0"><td class="small">${esc(dShort(x.day))}</td><td class="small">${esc(h.ushort(x.unit))}</td><td><b>${esc(x.bank)}</b></td>
      <td class="num">${x.has_bank ? plain(x.bank_in) : '<span class="muted">–</span>'}</td><td class="num">${plain(x.m_in)}</td><td class="num ${x.diff_in !== undefined && Math.abs(x.diff_in) > TOLERANCE ? "neg" : ""}">${x.diff_in !== undefined ? mny(x.diff_in) : ""}</td>
      <td class="num">${x.has_bank ? plain(x.bank_out) : '<span class="muted">–</span>'}</td><td class="num">${plain(x.m_out)}</td><td class="num ${x.diff_out !== undefined && Math.abs(x.diff_out) > TOLERANCE ? "neg" : ""}">${x.diff_out !== undefined ? mny(x.diff_out) : ""}</td>
      <td class="small">${x.flags.length ? x.flags.map((f) => `<div class="neg">${esc(f)}</div>`).join("") : '<span class="pill s-done">Matches</span>'}</td></tr>`).join("");
    return `<div class="cf-body"><div class="cf-filters">${h.allUnits().length > 1 ? h.unitSel(S.scope) : ""}<span class="cf-group">${[7, 14, 30, 90].map((n) => chip(r.range === n, `data-cf="w-rcrange" data-v="${n}"`, `${n} days`)).join("")}</span><span class="cf-group">${chip(!r.all, 'data-cf="w-rcall" data-v="0"', "Only mismatches")}${chip(r.all, 'data-cf="w-rcall" data-v="1"', "All days")}</span><span class="small muted">to ${esc(dShort(to))}</span></div>
      <div class="cf-stats">${h.stat("Bank lines checked", rows.length, `${days} day${days === 1 ? "" : "s"}`)}${h.stat("Mismatches", bad.length, bad.length ? "to look at" : "everything matches", bad.length ? "neg" : "")}${h.stat("Tolerance", plain(TOLERANCE) + " ETB", "smaller differences are ignored")}</div>
      <div class="small muted cf-pad">For each bank and day: what the bank report says came in and went out, against the collections and payments recorded with that bank. Click a row to open that day.</div>
      <section class="cf-card flush">${shown.length ? `<div class="scroll"><table class="cf-table"><thead><tr><th>Day</th><th>Unit</th><th>Bank</th><th>Bank in</th><th>Collections</th><th>Diff</th><th>Bank out</th><th>Payments</th><th>Diff</th><th>Check</th></tr></thead><tbody>${body}</tbody></table></div>` : `<div class="empty"><b>${rows.length ? "Everything matches" : "Nothing to check yet"}</b>${rows.length ? "Every bank report in this period agrees with the collections and payments recorded." : "Enter the bank report and the collections and payments for a day to see the check here."}</div>`}</section></div>`;
  }

  // ---------------- reports (downloads and the weekly report) ----------------
  function weekReport(unit, W) {
    const d = weekData([unit], W), E = d.E, sec = {};
    const add = (kind, section, label, plan, actual, code) => { const k = kind + "|" + section; (sec[k] = sec[k] || []).push({ label, plan, actual, code }); };
    for (const r of d.rows) add(r.it.kind, r.it.section || "operating", r.it.party || r.it.description || r.it.code, num(r.w.planned), r.moved, r.it.code);
    const grp = {}; for (const l of d.loose) { const k = l.kind + "|" + (l.party || l.description || "Other"); grp[k] = (grp[k] || 0) + num(l.amount); }
    for (const [k, v2] of Object.entries(grp)) { const [kind, label] = k.split("|"); add(kind, "unplanned", label, 0, v2, ""); }
    const total = (kind, f) => sum(Object.entries(sec).filter(([k]) => k.startsWith(kind + "|")).flatMap(([, v2]) => v2), f);
    const begin = cashAt([unit], addDays(W, -1)), pin = total("in", (x) => x.plan), pout = total("out", (x) => x.plan), ain = total("in", (x) => x.actual), aout = total("out", (x) => x.actual);
    const endDay = E < c.todayIso ? E : c.todayIso, endBank = hasBankBy([unit], endDay) && W <= c.todayIso ? cashAt([unit], endDay) : null;
    return { unit, W, E, sec, begin, pin, pout, ain, aout, endPlan: begin + pin - pout, endActual: begin + ain - aout, endBank };
  }
  const secName = (s) => (s === "unplanned" ? "Not in the plan" : SEC_LABEL[s] || s);
  function weekReportHtml(rep) {
    const part = (kind, title) => { const keys = Object.keys(rep.sec).filter((k) => k.startsWith(kind + "|")).sort((a, b) => SEC_ORDER.indexOf(a.split("|")[1]) - SEC_ORDER.indexOf(b.split("|")[1]));
      return `<tr class="cf-sec"><td colspan="4"><b>${title}</b></td></tr>${keys.map((k) => `<tr class="cf-sec2"><td colspan="4"><i>${esc(secName(k.split("|")[1]))}</i></td></tr>${rep.sec[k].map((x) => `<tr><td>${esc(x.label)}${x.code ? ` <span class="tag">${esc(x.code)}</span>` : ""}</td><td class="num">${mny(x.plan)}</td><td class="num">${mny(x.actual)}</td><td class="num ${x.actual - x.plan < -0.5 ? "neg" : ""}">${mny(x.actual - x.plan)}</td></tr>`).join("")}`).join("")}`; };
    const tr = (label, p, a, cls) => `<tr class="tot ${cls || ""}"><td><b>${label}</b></td><td class="num">${plain(p)}</td><td class="num">${plain(a)}</td><td class="num ${a - p < -0.5 ? "neg" : ""}">${plain(a - p)}</td></tr>`;
    return `<div class="scroll"><table class="cf-table"><thead><tr><th>${esc(h.uname(rep.unit))} · ${esc(weekLabel(rep.W))}</th><th>Plan</th><th>Actual</th><th>Variance</th></tr></thead><tbody>
      <tr class="tot"><td><b>Beginning cash</b></td><td class="num">${plain(rep.begin)}</td><td class="num">${plain(rep.begin)}</td><td></td></tr>${part("in", "Cash inflows")}${tr("Total cash in", rep.pin, rep.ain)}${tr("Available cash", rep.begin + rep.pin, rep.begin + rep.ain)}${part("out", "Cash outflows")}${tr("Total cash out", rep.pout, rep.aout)}
      ${tr("Ending cash", rep.endPlan, rep.endActual, "strong")}${rep.endBank !== null ? `<tr><td class="small muted">Bank balance at the end (from the bank report)</td><td></td><td class="num">${plain(rep.endBank)}</td><td class="num ${Math.abs(rep.endBank - rep.endActual) > TOLERANCE ? "neg" : ""}">${plain(rep.endBank - rep.endActual)}</td></tr>` : ""}</tbody></table></div>`;
  }
  const REPORTS = [
    ["weekly", "Weekly cash flow report", "Plan against actual for the week, in the layout finance uses: beginning cash, inflows, outflows, ending cash. One sheet per unit."],
    ["summary", "Summary by business unit", "One row per unit for the chosen period: cash at the start, planned and actual in and out, cash at the end. No line detail."],
    ["history", "Weekly plan history", "Every line in every weekly plan in the period, with planned amount, what moved and what was left, so a line can be traced back to when it was planned."],
    ["open", "Open collections and payments", "What is still to be collected or paid as at the end of the chosen day, by line."],
    ["moves", "Daily cash movements", "Each collection and payment recorded in the period, with its code, day and bank."],
    ["bank", "Bank balances", "Opening, in, out and closing per bank per day in the period."],
    ["recon", "Reconciliation", "The check of the bank report against the collections and payments, with every mismatch listed."],
  ];
  function renderReports() {
    const rp = S.rp, units = h.scopeUnits(), W = S.wk, to = S.day, from = rp.from || addDays(to, -29);
    const wr = units.length ? units.slice(0, 3).map((u) => weekReportHtml(weekReport(u, W))).join("") : "";
    return `<div class="cf-body"><div class="cf-filters">${h.allUnits().length > 1 ? h.unitSel(S.scope) : ""}<label class="small muted">Period from <input type="date" data-cfc="rpfrom" value="${esc(from)}"></label><span class="small muted">to the day chosen at the top (${esc(dShort(to))})</span></div>
      <section class="cf-card"><h3>Download a report</h3><div class="small muted">Each download is only what its name says. For a copy of everything, use the backup in Setup.</div>
        <div class="cf-reports">${REPORTS.map(([k, t, d]) => `<div class="cf-rep"><div><b>${esc(t)}</b><div class="small muted">${esc(d)}</div></div><button class="btn small" data-cf="w-report" data-v="${k}">Download Excel</button></div>`).join("")}</div></section>
      <section class="cf-card flush"><div class="cf-pad cf-split"><div><h3>Weekly report on screen</h3><div class="small muted">For the week chosen on the Weekly plan page: ${esc(weekLabel(W))}. Change the week there, or here:</div></div><span class="cf-group"><button class="btn small" data-cf="w-shift" data-v="-7" data-stay="1">‹ Earlier</button><button class="btn small" data-cf="w-shift" data-v="7" data-stay="1">Later ›</button></span></div>
        ${wr || '<div class="empty"><b>No unit</b></div>'}${units.length > 3 ? `<div class="small muted cf-pad">Showing three units. Download the Excel for all of them.</div>` : ""}</section></div>`;
  }
  async function download(kind) {
    if (!c.libsReady("xlsx")) return; const X = c.XLSX(), wb = X.utils.book_new(), units = h.scopeUnits(), W = S.wk, to = S.day, from = S.rp.from || addDays(to, -29);
    const sheet = (rows, w, name) => X.utils.book_append_sheet(wb, c.sheetFromRows(rows, w), name.slice(0, 31));
    if (kind === "weekly") {
      for (const u of units) { const r = weekReport(u, W), rows = [[`${h.uname(u)} · weekly cash flow report · ${weekLabel(W)}`], [], ["Description", "Code", "Plan", "Actual", "Variance"], ["Beginning cash", "", Math.round(r.begin), Math.round(r.begin), ""]];
        for (const [kindK, title] of [["in", "Cash inflows"], ["out", "Cash outflows"]]) { rows.push([title]); for (const k of Object.keys(r.sec).filter((q) => q.startsWith(kindK + "|")).sort((a, b) => SEC_ORDER.indexOf(a.split("|")[1]) - SEC_ORDER.indexOf(b.split("|")[1]))) { rows.push([secName(k.split("|")[1])]); r.sec[k].forEach((x) => rows.push(["   " + x.label, x.code, Math.round(x.plan), Math.round(x.actual), Math.round(x.actual - x.plan)])); }
          const p = kindK === "in" ? r.pin : r.pout, a = kindK === "in" ? r.ain : r.aout; rows.push([kindK === "in" ? "Total cash in" : "Total cash out", "", Math.round(p), Math.round(a), Math.round(a - p)]); if (kindK === "in") rows.push(["Available cash", "", Math.round(r.begin + r.pin), Math.round(r.begin + r.ain), ""]); }
        rows.push(["Ending cash", "", Math.round(r.endPlan), Math.round(r.endActual), Math.round(r.endActual - r.endPlan)]); if (r.endBank !== null) rows.push(["Bank balance at the end (bank report)", "", "", Math.round(r.endBank), Math.round(r.endBank - r.endActual)]);
        sheet(rows, [46, 12, 16, 16, 16], h.ushort(u)); }
      await c.writeXlsx(wb, `Weekly cash flow report ${W}.xlsx`, "Excel saved"); return; }
    if (kind === "summary") {
      const rows = [["Business unit", "Cash at the start", "Planned in", "Actual in", "Planned out", "Actual out", "Cash at the end (bank)"]];
      const weeks = []; for (let w = weekStart(from); w <= to; w = addDays(w, 7)) weeks.push(w);
      for (const u of units) { const wr = weeks.map((w) => weekReport(u, w)); rows.push([h.uname(u), Math.round(cashAt([u], addDays(weekStart(from), -1))), Math.round(sum(wr, (x) => x.pin)), Math.round(sum(wr, (x) => x.ain)), Math.round(sum(wr, (x) => x.pout)), Math.round(sum(wr, (x) => x.aout)), Math.round(cashAt([u], to))]); }
      rows.push(["Total", ...[1, 2, 3, 4, 5, 6].map((i) => Math.round(sum(rows.slice(1), (r) => r[i])))]);
      sheet([[`Summary by business unit · ${dShort(weekStart(from))} to ${dShort(to)}`], [], ...rows], [34, 18, 16, 16, 16, 16, 20], "Summary"); await c.writeXlsx(wb, `Cash flow summary ${to}.xlsx`, "Excel saved"); return; }
    if (kind === "history") {
      const rows = [["Week", "Unit", "Code", "Collect or pay", "Party", "Invoice", "Section", "Type", "Planned", "Moved in the week", "Left at the end", "Rolled", "Due", "First planned"]]; const items = new Map(S.itemsAll.map((i) => [i.id, i]));
      S.week.filter((w) => units.includes(w.unit) && w.week >= weekStart(from) && w.week <= to).sort((a, b) => a.week.localeCompare(b.week) || a.unit.localeCompare(b.unit)).forEach((w) => { const it = items.get(w.itemId); if (!it) return; rows.push([w.week, h.uname(w.unit), it.code, it.kind === "in" ? "Collect" : "Pay", it.party || it.description, it.ref, SEC_LABEL[it.section || "operating"], it.typeCode, Math.round(num(w.planned)), Math.round(movedIn(S.log, it.id, w.week, weekEnd(w.week))), Math.round(h.viewOf(it, weekEnd(w.week)).left), w.rolled ? "Yes" : "", w.due || it.expected || "", it.firstWeek || ""]); });
      sheet(rows, [12, 26, 12, 12, 34, 16, 12, 14, 16, 18, 16, 8, 12, 12], "Plan history"); await c.writeXlsx(wb, `Weekly plan history ${to}.xlsx`, "Excel saved"); return; }
    if (kind === "open") {
      const rows = [["Unit", "Code", "Collect or pay", "Party", "Invoice", "Description", "Type", "Urgency", "Outstanding when entered", "Collected or paid to date", "Left", "Currency", "Due"]];
      S.items.filter((i) => units.includes(i.unit)).map((i) => ({ i, v: h.viewOf(i, to) })).filter(({ v: v2 }) => v2.exists && v2.open).sort((a, b) => a.i.unit.localeCompare(b.i.unit) || a.i.kind.localeCompare(b.i.kind) * -1 || a.i.bucket - b.i.bucket).forEach(({ i, v: v2 }) => rows.push([h.uname(i.unit), i.code, i.kind === "in" ? "Collect" : "Pay", i.party, i.ref, i.description, i.typeCode, bucketCode(i.kind, i.bucket), Math.round(num(i.amount)), Math.round(v2.to), Math.round(v2.left), i.currency, i.expected || ""]));
      sheet([[`Open collections and payments as at ${dShort(to)}`], [], ...rows], [26, 12, 12, 30, 16, 34, 14, 9, 18, 18, 16, 9, 12], "Open lines"); await c.writeXlsx(wb, `Open collections and payments ${to}.xlsx`, "Excel saved"); return; }
    if (kind === "moves") {
      const rows = [["Day", "Unit", "In or out", "Bank", "Code", "Party", "Description", "Amount", "Currency", "Note"]];
      S.log.filter((l) => units.includes(l.unit) && l.day >= from && l.day <= to).sort((a, b) => a.day.localeCompare(b.day) || a.unit.localeCompare(b.unit)).forEach((l) => rows.push([l.day, h.uname(l.unit), l.kind === "in" ? "In" : "Out", l.bank, l.itemCode, l.party, l.description, num(l.amount), l.currency, l.note]));
      sheet(rows, [12, 26, 9, 22, 12, 30, 34, 16, 9, 30], "Movements"); await c.writeXlsx(wb, `Daily cash movements ${to}.xlsx`, "Excel saved"); return; }
    if (kind === "bank") {
      const rows = [["Day", "Unit", "Bank", "Opening", "In", "Out", "Closing"]];
      h.effBank().filter((b) => units.includes(b.unit) && b.day >= from && b.day <= to).sort((a, b) => a.day.localeCompare(b.day) || a.unit.localeCompare(b.unit) || a.bank.localeCompare(b.bank)).forEach((b) => rows.push([b.day, h.uname(b.unit), b.bank, Math.round(num(b.opening)), Math.round(num(b.inflow)), Math.round(num(b.outflow)), Math.round(num(b.closing))]));
      sheet(rows, [12, 26, 24, 16, 16, 16, 16], "Bank balances"); await c.writeXlsx(wb, `Bank balances ${to}.xlsx`, "Excel saved"); return; }
    if (kind === "recon") {
      const rows = [["Day", "Unit", "Bank", "Bank in", "Collections recorded", "Difference in", "Bank out", "Payments recorded", "Difference out", "Check"]];
      reconcileRows(h.effBank().filter((b) => !b.synthetic), S.log, units, from, to, h.fx()).forEach((x) => rows.push([x.day, h.uname(x.unit), x.bank, Math.round(x.bank_in), Math.round(x.m_in), x.diff_in === undefined ? "" : Math.round(x.diff_in), Math.round(x.bank_out), Math.round(x.m_out), x.diff_out === undefined ? "" : Math.round(x.diff_out), x.flags.length ? x.flags.join("; ") : "Matches"]));
      sheet(rows, [12, 26, 24, 16, 18, 16, 16, 18, 16, 60], "Reconciliation"); await c.writeXlsx(wb, `Cash reconciliation ${to}.xlsx`, "Excel saved"); }
  }

  // ---------------- Excel templates: weekly plan ----------------
  const header = (ws, row, heads, widths) => { heads.forEach((t, i) => { const cell = ws.getCell(row, i + 1); cell.value = t; cell.font = { bold: true, color: { argb: "FF2A2208" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5C518" } }; cell.alignment = { wrapText: true, vertical: "middle" }; ws.getColumn(i + 1).width = widths[i]; }); ws.getRow(row).height = 32; };
  const listV = (ws, col, from, last, name, msg, warn) => { for (let r = from; r <= last; r++) ws.getCell(r, col).dataValidation = { type: "list", allowBlank: true, formulae: [name], showErrorMessage: true, errorStyle: warn ? "warning" : "stop", errorTitle: "Pick from the list", error: msg }; };
  const numV = (ws, col, from, last, min) => { for (let r = from; r <= last; r++) { ws.getCell(r, col).dataValidation = { type: "decimal", operator: min === null ? "between" : "greaterThanOrEqual", allowBlank: true, formulae: min === null ? [-1e15, 1e15] : [min], showErrorMessage: true, errorTitle: "Amount", error: "Enter a number." }; ws.getCell(r, col).numFmt = "#,##0.00"; } };
  const dateV = (ws, col, from, last) => { for (let r = from; r <= last; r++) { ws.getCell(r, col).dataValidation = { type: "date", operator: "greaterThan", allowBlank: true, formulae: [new Date(Date.UTC(2020, 0, 1))], showErrorMessage: true, errorTitle: "Date", error: "Enter a date, for example 2026-10-22." }; ws.getCell(r, col).numFmt = "yyyy-mm-dd"; } };
  const grey = (cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } }; };
  async function newBook(listsFn) {
    let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch (e) { c.toast("The Excel tool did not load. Reload the page and try again."); return null; }
    const wb = new ExcelJS.Workbook(), lists = wb.addWorksheet("Lists", { state: "veryHidden" });
    const col = (i, arr, name) => { arr.forEach((x, k) => { lists.getCell(k + 1, i).value = x; }); const L = lists.getColumn(i).letter; wb.definedNames.add(`Lists!$${L}$1:$${L}$${Math.max(1, arr.length)}`, name); };
    listsFn(col); return wb;
  }
  const typeCodes = () => S.types.filter((t) => t.active).map((t) => t.code);
  async function weekTemplate() {
    const units = h.scopeUnits().filter((u) => h.canWrite(u)); if (!units.length) { c.toast("You can only download the template for a unit you can edit"); return; }
    const W = S.wk, wb = await newBook((col) => { col(1, ["Collect", "Pay"], "L_Kind"); col(2, SECTIONS.map((s) => s[1]), "L_Sec"); col(3, typeCodes().length ? typeCodes() : [""], "L_Type"); col(4, ["1", "2", "3"], "L_Urg"); col(5, CURRENCIES, "L_Cur"); }); if (!wb) return;
    for (const u of units) {
      const d = weekData([u], W), rows = d.rows.length ? d.rows.map((r) => ({ it: r.it, planned: num(r.w.planned), left: r.startLeft, due: r.w.due || r.it.expected, note: r.w.note })) : d.cand.map((x) => ({ it: x.it, planned: Math.round(x.left * 100) / 100, left: x.left, due: x.it.expected, note: "" }));
      const ws = wb.addWorksheet(`Plan ${h.ushort(u)}`.slice(0, 31), { views: [{ state: "frozen", ySplit: 4 }] });
      ws.getCell("A1").value = "Week starting (Saturday)"; ws.getCell("B1").value = toDate(W); ws.getCell("B1").numFmt = "yyyy-mm-dd"; ws.getCell("A2").value = "Business unit"; ws.getCell("B2").value = h.uname(u); ws.getCell("C1").value = `${weekLabel(W)}. Leave Code empty for a new line. Do not change the unit or the week.`; ws.getCell("A1").font = ws.getCell("A2").font = { bold: true };
      header(ws, 4, ["Code (empty for a new line)", "Collect or pay", "Section", "Customer or payee", "Invoice / reference", "Description", "Type", "Urgency (1, 2 or 3)", "Due date (end date)", "Planned this week", "Total outstanding (new lines; optional)", "Currency", "Note"], [16, 13, 14, 30, 18, 36, 14, 11, 13, 16, 18, 10, 30]);
      rows.forEach((x, k) => { const r = 5 + k, it = x.it; [it.code, it.kind === "in" ? "Collect" : "Pay", SEC_LABEL[it.section || "operating"], it.party, it.ref, it.description, it.typeCode, it.bucket, toDate(x.due), x.planned, x.left, it.currency, x.note].forEach((val, i) => { ws.getCell(r, i + 1).value = val; }); grey(ws.getCell(r, 1)); });
      const last = Math.max(5 + rows.length + 150, 200); listV(ws, 2, 5, last, "L_Kind", "Pick Collect or Pay."); listV(ws, 3, 5, last, "L_Sec", "Pick a section from the list."); listV(ws, 7, 5, last, "L_Type", "Pick a type. New types are added in the app under Setup."); listV(ws, 8, 5, last, "L_Urg", "Pick 1, 2 or 3."); listV(ws, 12, 5, last, "L_Cur", "Pick ETB or USD.");
      dateV(ws, 9, 5, last); numV(ws, 10, 5, last, 0); numV(ws, 11, 5, last, 0);
      ws.getCell(`D${last + 2}`).value = "Total planned this week"; ws.getCell(`J${last + 2}`).value = { formula: `SUM(J5:J${last})` }; ws.getCell(`J${last + 2}`).numFmt = "#,##0.00";
    }
    const info = wb.addWorksheet("Info", { views: [{ showGridLines: false }] }); info.getColumn(1).width = 6; info.getColumn(2).width = 120;
    [["How to fill in the weekly plan"], ["1", "One row per line you expect to collect or pay this week. Lines that were not paid or collected last week are already here with what is left."], ["2", "Code links the line to the daily collections and payments. Keep it. Leave it empty for a new line; the app gives it a code when you upload."],
      ["3", "Planned this week is what you expect to move in the week. Total outstanding is only for a new line, if the whole amount is more than this week's plan."], ["4", "To drop a line from this week, delete its Planned amount. Upload never deletes a line; remove it in the app."], ["5", "Upload this file on the Weekly plan page with Upload plan."]].forEach((r, i) => { const row = info.addRow(r); if (i === 0) row.font = { bold: true, size: 14 }; });
    wb.worksheets.forEach((w) => { if (w.name !== "Lists") w.properties.tabColor = { argb: w.name === "Info" ? "FF999999" : "FFF5C518" }; });
    await c.saveFile(`Weekly plan ${W}.xlsx`, await wb.xlsx.writeBuffer(), "Excel saved");
  }

  // ---------------- Excel templates: the daily sheets ----------------
  async function dayTemplate() {
    const units = h.scopeUnits().filter((u) => h.canWrite(u)); if (!units.length) { c.toast("You can only download the template for a unit you can edit"); return; }
    const D = S.day, prev = addDays(D, -1), banksAll = [...new Set(units.flatMap(h.knownBanks))].filter((b) => b && b !== "All banks");
    const wb = await newBook((col) => { col(1, ["Collect", "Pay"], "L_Kind"); col(2, banksAll.length ? banksAll : [""], "L_Bank"); }); if (!wb) return;
    for (const u of units) {
      const banks = h.knownBanks(u).filter((b) => b !== "All banks");
      const lines = S.items.filter((it) => it.unit === u).map((it) => ({ it, start: h.viewOf(it, prev).left, today: S.log.filter((l) => l.itemId === it.id && l.day === D) })).filter((x) => x.start > 0.005 || x.today.length).sort((a, b) => b.it.kind.localeCompare(a.it.kind) || a.it.bucket - b.it.bucket || num(b.start) - num(a.start));
      const ws = wb.addWorksheet(`Coll-Pay ${h.ushort(u)}`.slice(0, 31), { views: [{ state: "frozen", ySplit: 4 }] });
      ws.getCell("A1").value = "Day"; ws.getCell("B1").value = toDate(D); ws.getCell("B1").numFmt = "yyyy-mm-dd"; ws.getCell("A2").value = "Business unit"; ws.getCell("B2").value = h.uname(u); ws.getCell("A1").font = ws.getCell("A2").font = { bold: true };
      ws.getCell("C1").value = "Type the amount collected or paid today in the Moved today column. The rest is worked out. Leave the others empty."; header(ws, 4, ["Code", "Collect or pay", "Customer or payee", "Invoice / reference", "Description", "Type", "Urgency", "Remaining at the start of the day", "Moved today (collected or paid)", "Bank", "Remaining after today", "Note"], [14, 13, 30, 18, 36, 14, 9, 18, 18, 22, 18, 28]);
      let r = 5; const rowsOut = [];
      for (const x of lines) { const it = x.it, byBank = new Map(); x.today.forEach((l) => byBank.set(l.bank || "", (byBank.get(l.bank || "") || 0) + num(l.amount)));
        const start = x.start + sum(x.today, (l) => l.amount);   // the start of the day = what is left after the day plus what moved today
        const parts = byBank.size ? [...byBank.entries()] : [["", ""]];
        parts.forEach(([bank, amt], k) => { rowsOut.push([it.code, it.kind === "in" ? "Collect" : "Pay", it.party || it.description, it.ref, it.description, it.typeCode, bucketCode(it.kind, it.bucket), k === 0 ? Math.round(start * 100) / 100 : "", amt, bank || (amt === "" ? "" : ""), "", ""]); }); }
      rowsOut.forEach((row, k) => { const rr = r + k; row.forEach((val, i) => { ws.getCell(rr, i + 1).value = val; }); [1, 2, 3, 4, 5, 6, 7, 8].forEach((i) => grey(ws.getCell(rr, i))); ws.getCell(rr, 11).value = { formula: `IF(A${rr}="","",H${rr}-SUMIF($A$5:$A$2000,A${rr},$I$5:$I$2000))` }; ws.getCell(rr, 11).numFmt = "#,##0.00"; });
      const unplannedFrom = r + rowsOut.length + 2, last = unplannedFrom + 40; ws.getCell(`A${unplannedFrom - 1}`).value = "Unplanned cash today (no code): fill Collect or pay, the customer or payee, the amount and the bank."; ws.getCell(`A${unplannedFrom - 1}`).font = { bold: true };
      const all = Math.max(last, 5 + rowsOut.length + 60); listV(ws, 2, 5, all, "L_Kind", "Pick Collect or Pay."); listV(ws, 10, 5, all, "L_Bank", "That bank is not in the list. You can still type it; make sure it is spelled the same as in the bank sheet.", true); numV(ws, 9, 5, all, 0);
      ws.getCell(`H${all + 2}`).value = "Total moved today"; ws.getCell(`I${all + 2}`).value = { formula: `SUM(I5:I${all})` }; ws.getCell(`I${all + 2}`).numFmt = "#,##0.00";
      const bs = wb.addWorksheet(`Bank ${h.ushort(u)}`.slice(0, 31), { views: [{ state: "frozen", ySplit: 4 }] });
      bs.getCell("A1").value = "Day"; bs.getCell("B1").value = toDate(D); bs.getCell("B1").numFmt = "yyyy-mm-dd"; bs.getCell("A2").value = "Business unit"; bs.getCell("B2").value = h.uname(u); bs.getCell("A1").font = bs.getCell("A2").font = { bold: true };
      bs.getCell("C1").value = "From the bank report: what the account held, what came in, what went out, and the closing balance."; header(bs, 4, ["Bank", "Opening balance", "Total in", "Total out", "Closing balance (bank report)", "Check: opening + in − out − closing"], [26, 18, 18, 18, 22, 24]);
      const eb = h.effBank(), allBanks = [...new Set([...banks, ...S.bank.filter((b) => b.unit === u && b.day === D).map((b) => b.bank)])];
      allBanks.forEach((bk, k) => { const rr = 5 + k, saved = S.bank.find((b) => b.unit === u && b.bank === bk && b.day === D), pv = eb.filter((b) => b.unit === u && b.bank === bk && b.day < D).sort((a, b) => b.day.localeCompare(a.day))[0];
        bs.getCell(rr, 1).value = bk; bs.getCell(rr, 2).value = saved ? num(saved.opening) : pv ? num(pv.closing) : ""; if (saved) { bs.getCell(rr, 3).value = num(saved.inflow); bs.getCell(rr, 4).value = num(saved.outflow); bs.getCell(rr, 5).value = num(saved.closing); }
        bs.getCell(rr, 6).value = { formula: `IF(E${rr}="","",B${rr}+C${rr}-D${rr}-E${rr})` }; bs.getCell(rr, 6).numFmt = "#,##0.00"; grey(bs.getCell(rr, 1)); });
      const bl = 5 + allBanks.length + 20; listV(bs, 1, 5, bl, "L_Bank", "That bank is not in the list. You can still type it.", true); for (const cI of [2, 3, 4, 5]) numV(bs, cI, 5, bl, null);
    }
    const info = wb.addWorksheet("Info", { views: [{ showGridLines: false }] }); info.getColumn(1).width = 6; info.getColumn(2).width = 120;
    [["How to fill in the daily sheets"], ["1", "Coll-Pay sheet: every open collection and payable is listed with what was left at the start of the day. Type only the amount collected or paid today in Moved today, and choose the bank. Remaining after today is worked out."],
      ["2", "If one line was paid from two banks, add a second row with the same Code, the other bank and its amount."], ["3", "Cash that was not planned goes in the unplanned rows at the bottom, without a code."],
      ["4", "Bank sheet: the opening balance is yesterday's closing. Enter the total in, total out and the closing balance from the bank report. The Check column should be 0."], ["5", "Upload the file on the Daily page with Upload day. Uploading again for the same day updates the amounts; it never deletes."]].forEach((r, i) => { const row = info.addRow(r); if (i === 0) row.font = { bold: true, size: 14 }; });
    wb.worksheets.forEach((w) => { if (w.name !== "Lists") w.properties.tabColor = { argb: w.name === "Info" ? "FF999999" : "FFF5C518" }; });
    await c.saveFile(`Daily cash ${D}.xlsx`, await wb.xlsx.writeBuffer(), "Excel saved");
  }

  // ---------------- uploads ----------------
  const unitMap = (units) => { const m = new Map(); units.forEach((u) => [h.uname(u), h.ushort(u), c.unitName(u), u].forEach((n) => m.set(norm(n), u))); if (units.includes("wagwago-electric")) m.set("wagwago trading", "wagwago-electric"); return m; };
  const readSheets = (X, wb, re) => wb.SheetNames.filter((n) => re.test(n)).map((n) => ({ name: n, rows: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }) }));
  function report(rep, title) {
    const lines = []; for (const [k, t] of Object.entries(rep.counts)) if (t) lines.push(t); if (rep.skip) lines.push(`<b>${rep.skip}</b> row${rep.skip > 1 ? "s were" : " was"} not saved. Fix ${rep.skip > 1 ? "them" : "it"} in the file and upload again.`); if (!lines.length) lines.push("Nothing was found to save. Use the template from this page and keep its sheet names.");
    S.m = { type: "result", title, lines, notes: rep.notes }; h.drawModal();
  }
  async function uploadWeek(file) {
    const units = h.writableUnits(); if (!units.length) { c.toast("You cannot edit any unit's cash flow"); return; } if (!c.libsReady("xlsx")) return; const X = c.XLSX(); let wb;
    try { wb = X.read(await file.arrayBuffer(), { type: "array" }); } catch (e) { c.toast("Could not read that file. Use the template from Download weekly plan template."); return; }
    const uMap = unitMap(units), tMap = new Map(S.types.map((t) => [norm(t.code), t.code])), secMap = new Map(SECTIONS.map(([k, l]) => [norm(l), k])), rep = { counts: {}, skip: 0, notes: [] };
    const bad = (sheet, line, why) => { rep.skip++; rep.notes.push(`${sheet} row ${line}: ${why}`); }; let added = 0, upd = 0, planned = 0;
    const sheets = readSheets(X, wb, /^plan/i); if (!sheets.length) { c.toast("No “Plan …” sheet found. Use the template from Download weekly plan template."); return; }
    await h.run(async () => {
      for (const sh of sheets) {
        const unit = uMap.get(norm(sh.rows[1] && sh.rows[1][1])), wk = serialToIso(sh.rows[0] && sh.rows[0][1]);
        if (!unit) { bad(sh.name, 2, `unit “${sh.rows[1] && sh.rows[1][1]}” not found or not yours`); continue; } if (!wk) { bad(sh.name, 1, "the week (cell B1) is missing or not a date"); continue; }
        const W = weekStart(wk);
        for (let i = 4; i < sh.rows.length; i++) { const r = sh.rows[i], line = i + 1; if (!r.some((x) => String(x).trim() !== "")) continue;
          const [code, kindN, secN, party, ref, desc, typeN, urg, due, plan, outst, cur, note] = r;
          if (/^total/i.test(String(party || desc || "")) || /^total/i.test(String(code))) continue;
          const old = String(code).trim() ? S.items.find((q) => q.code && q.code.toUpperCase() === String(code).trim().toUpperCase() && q.unit === unit) : null;
          if (String(code).trim() && !old) { bad(sh.name, line, `no line with code ${code} for this unit`); continue; }
          const p = money(plan); if (p === null || p <= 0) { if (old) continue; bad(sh.name, line, "Planned this week is empty or zero"); continue; }
          const kind = old ? old.kind : /^c/i.test(String(kindN).trim()) ? "in" : /^p/i.test(String(kindN).trim()) ? "out" : ""; if (!kind) { bad(sh.name, line, "Collect or pay is empty"); continue; }
          if (!String(party).trim() && !String(desc).trim() && !old) { bad(sh.name, line, "customer or payee and description are both empty"); continue; }
          const b = bucketOf(urg) || (old ? old.bucket : 1), sec = secMap.get(norm(secN)) || (old ? old.section : "operating") || "operating", dueIso = serialToIso(due);
          let typeCode = String(typeN).trim() ? tMap.get(norm(typeN)) || "" : old ? old.typeCode : ""; if (String(typeN).trim() && !tMap.get(norm(typeN))) rep.notes.push(`${sh.name} row ${line}: type “${typeN}” is not in the list, left without a type`);
          let item = old;
          if (!item) item = S.items.find((q) => q.unit === unit && q.kind === kind && q.status === "open" && norm(q.party) === norm(party) && norm(q.ref) === norm(ref) && norm(q.description) === norm(desc) && (String(party).trim() || String(desc).trim()));   // the same line uploaded again
          let itemId = item && item.id;
          if (!item) { const total = money(outst) > 0 ? money(outst) : p, res = await c.api().saveCfItem(A(), { unit, kind, party: String(party).trim(), description: String(desc).trim(), ref: String(ref).trim(), typeCode, bucket: b, amount: total, total, currency: CURRENCIES.includes(String(cur).trim().toUpperCase()) ? String(cur).trim().toUpperCase() : "ETB", priority: "Normal", expected: dueIso, status: "open", enteredOn: c.todayIso, section: sec, firstWeek: W, note: "" });
            if (res && res.error) return res; itemId = res.id; added++; }
          else { const ch = { party: String(party).trim() || item.party, description: String(desc).trim() || item.description, ref: String(ref).trim() || item.ref, typeCode: typeCode || item.typeCode, bucket: b, section: sec, expected: dueIso || item.expected };
            if (Object.entries(ch).some(([k, val]) => (item[k] || "") !== val)) { const res = await c.api().saveCfItem(A(), h.itemRow({ ...item, ...ch })); if (res && res.error) return res; upd++; } }
          const res = await c.api().saveCfWeek(A(), { unit, week: W, itemId, planned: p, due: dueIso, rolled: false, note: String(note).trim() }); if (res && res.error) return res; planned++;
        }
      }
      return { ok: true };
    });
    rep.counts.a = planned ? `Weekly plan: <b>${planned}</b> line${planned > 1 ? "s" : ""} planned (<b>${added}</b> new, <b>${upd}</b> existing line${upd === 1 ? "" : "s"} updated).` : ""; report(rep, "Upload finished");
  }
  // close a line when cash has covered it, reopen it when it no longer is
  async function settle(itemId, total, day) {
    const it = S.items.find((q) => q.id === itemId); if (!it || it.status === "written_off") return null;
    if (total >= num(it.amount) - 0.005 && it.status === "open") return c.api().saveCfItem(A(), h.itemRow({ ...it, status: "settled", settledOn: day }));
    if (total < num(it.amount) - 0.005 && it.status === "settled") return c.api().saveCfItem(A(), h.itemRow({ ...it, status: "open", settledOn: "" }));
    return null;
  }
  async function uploadDay(file) {
    const units = h.writableUnits(); if (!units.length) { c.toast("You cannot edit any unit's cash flow"); return; } if (!c.libsReady("xlsx")) return; const X = c.XLSX(); let wb;
    try { wb = X.read(await file.arrayBuffer(), { type: "array" }); } catch (e) { c.toast("Could not read that file. Use the template from Download daily template."); return; }
    const uMap = unitMap(units), rep = { counts: {}, skip: 0, notes: [] }, bad = (sheet, line, why) => { rep.skip++; rep.notes.push(`${sheet} row ${line}: ${why}`); };
    let nNew = 0, nUpd = 0, nFree = 0, nBank = 0; const touched = new Map();
    const sheets = readSheets(X, wb, /^(coll|bank)/i); if (!sheets.length) { c.toast("No “Coll-Pay …” or “Bank …” sheet found. Use the template from Download daily template."); return; }
    await h.run(async () => {
      for (const sh of sheets.filter((s) => /^coll/i.test(s.name))) {
        const unit = uMap.get(norm(sh.rows[1] && sh.rows[1][1])), day = serialToIso(sh.rows[0] && sh.rows[0][1]);
        if (!unit) { bad(sh.name, 2, `unit “${sh.rows[1] && sh.rows[1][1]}” not found or not yours`); continue; } if (!day) { bad(sh.name, 1, "the day (cell B1) is missing or not a date"); continue; }
        for (let i = 4; i < sh.rows.length; i++) { const r = sh.rows[i], line = i + 1; const [code, kindN, party, ref, desc, typeN, urg, start, moved, bankN, , note] = r;
          if (!r.some((x) => String(x).trim() !== "") || /^unplanned|^total/i.test(String(code || kindN || "").trim()) || /^total/i.test(String(start || "")) ) continue;
          const amt = money(moved); if (amt === null || amt <= 0) continue;
          const bank = String(bankN).trim(); const it = String(code).trim() ? S.items.find((q) => q.code && q.code.toUpperCase() === String(code).trim().toUpperCase() && q.unit === unit) : null;
          if (String(code).trim() && !it) { bad(sh.name, line, `no line with code ${code} for this unit`); continue; }
          if (!bank) { bad(sh.name, line, "choose the bank"); continue; }
          if (it) { const same = S.log.filter((l) => l.itemId === it.id && l.day === day && (l.bank || "") === bank);
            if (same.length > 1) { bad(sh.name, line, `more than one entry already exists for ${it.code} on ${day} in ${bank}; change it in the app`); continue; }
            const row = same[0] ? h.logRow({ ...same[0], amount: amt, note: String(note).trim() || same[0].note }) : { unit, day, kind: it.kind, bank, amount: amt, currency: it.currency, party: it.party, description: it.description, typeCode: it.typeCode, itemId: it.id, itemCode: it.code, note: String(note).trim() };
            if (same[0] && Math.abs(num(same[0].amount) - amt) < 0.005) continue;
            const res = await c.api().saveCfLog(A(), row); if (res && res.error) return res; same[0] ? nUpd++ : nNew++;
            const g = touched.get(it.id) || { day: "", keys: new Map() }; g.keys.set(day + "|" + bank, amt); if (day > g.day) g.day = day; touched.set(it.id, g); }
          else { const kind = /^c/i.test(String(kindN).trim()) ? "in" : /^p/i.test(String(kindN).trim()) ? "out" : ""; if (!kind) { bad(sh.name, line, "Collect or pay is empty (rows without a code are unplanned cash)"); continue; }
            const dup = S.log.find((l) => !l.itemId && l.unit === unit && l.day === day && l.kind === kind && (l.bank || "") === bank && Math.abs(num(l.amount) - amt) < 0.005 && (l.party || "") === String(party).trim() && (l.description || "") === String(desc).trim());
            if (dup) { rep.notes.push(`${sh.name} row ${line}: already recorded, skipped`); continue; }
            const res = await c.api().saveCfLog(A(), { unit, day, kind, bank, amount: amt, currency: "ETB", party: String(party).trim(), description: String(desc).trim() || "Unplanned", typeCode: "", itemId: "", itemCode: "", note: String(note).trim() }); if (res && res.error) return res; nFree++; }
        }
      }
      for (const [id, g] of touched) { const it = S.items.find((q) => q.id === id); if (!it) continue; const others = sum(S.log.filter((l) => l.itemId === id && !g.keys.has(l.day + "|" + (l.bank || ""))), (l) => l.amount) + sum([...g.keys.values()], (x) => x); const e = await settle(id, others, g.day); if (e && e.error) return e; }
      for (const sh of sheets.filter((s) => /^bank/i.test(s.name))) {
        const unit = uMap.get(norm(sh.rows[1] && sh.rows[1][1])), day = serialToIso(sh.rows[0] && sh.rows[0][1]);
        if (!unit) { bad(sh.name, 2, `unit “${sh.rows[1] && sh.rows[1][1]}” not found or not yours`); continue; } if (!day) { bad(sh.name, 1, "the day (cell B1) is missing or not a date"); continue; }
        for (let i = 4; i < sh.rows.length; i++) { const r = sh.rows[i], line = i + 1, [bank, op, inn, out, cl] = r; if (!String(bank).trim()) continue;
          const o = money(op), a = money(inn), b2 = money(out), z = money(cl); if (o === null && a === null && b2 === null && z === null) continue;
          const closing = z !== null ? z : (o || 0) + (a || 0) - (b2 || 0); const res = await c.api().saveCfBank(A(), { unit, day, bank: String(bank).trim(), opening: o || 0, inflow: a || 0, outflow: b2 || 0, closing }); if (res && res.error) return res; nBank++; }
      }
      return { ok: true };
    });
    rep.counts.a = nNew + nUpd + nFree ? `Collections and payments: <b>${nNew}</b> new, <b>${nUpd}</b> updated, <b>${nFree}</b> unplanned.` : ""; rep.counts.b = nBank ? `Bank report: <b>${nBank}</b> bank line${nBank > 1 ? "s" : ""} saved.` : ""; report(rep, "Upload finished");
  }

  // ---------------- actions ----------------
  async function onAction(el) {
    const x = el.dataset.cf, id = el.dataset.id;
    if (x === "w-shift") { S.wk = addDays(S.wk, Number(el.dataset.v)); c.render(); }
    else if (x === "w-thisweek") { S.wk = weekStart(c.todayIso); c.render(); }
    else if (x === "w-new") { if (!h.writableUnits().length) return; S.m = { type: "weekline", isNew: true, row: blankLine("in") }; h.drawModal(); }
    else if (x === "w-edit") { const w = S.week.find((q) => q.id === id), it = w && S.items.find((q) => q.id === w.itemId); if (!w || !it) return;
      S.m = { type: "weekline", isNew: false, row: { itemId: it.id, rolled: w.rolled, unit: it.unit, kind: it.kind, party: it.party, ref: it.ref, description: it.description, section: it.section || "operating", typeCode: it.typeCode, bucket: it.bucket, due: w.due || it.expected || "", planned: w.planned, currency: it.currency, note: w.note, startLeft: h.viewOf(it, addDays(S.wk, -1)).left } }; h.drawModal(); }
    else if (x === "w-save") await saveLine();
    else if (x === "w-remove") { const w = S.week.find((q) => q.id === id); if (!w) return; await h.run(() => c.api().deleteCf(A(), "cf_week_lines", id), "Taken out of this week"); }
    else if (x === "w-roll-all") await rollIn(weekData(h.scopeUnits(), S.wk).cand);
    else if (x === "w-roll-one") await rollIn(weekData(h.scopeUnits(), S.wk).cand.filter((q) => q.it.id === id));
    else if (x === "w-trace") { S.m = { type: "trace", itemId: id }; h.drawModal(); }
    else if (x === "w-xl-down") await weekTemplate();
    else if (x === "w-day-down") await dayTemplate();
    else if (x === "w-report") await download(el.dataset.v);
    else if (x === "w-rcrange") { S.rc.range = Number(el.dataset.v); c.render(); }
    else if (x === "w-rcall") { S.rc.all = el.dataset.v === "1"; c.render(); }
    else if (x === "w-goday") { S.scope = el.dataset.unit || S.scope; S.view = "log"; h.setDay(el.dataset.day); }
  }
  return { renderWeek, renderReconcile, renderReports, lineForm, traceView, onAction, uploadWeek, uploadDay, weekStart };
}
