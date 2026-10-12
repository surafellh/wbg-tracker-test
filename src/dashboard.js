// Executive dashboard: headline figures, trends and unit comparisons drawn as plain SVG / HTML (no chart library).
// Colours come from the --viz-* tokens in style.css (validated for colour-blind separation in light and dark mode).

const real = (p) => ((p && p.tasks) || []).filter((t) => t.kind !== "KPI / OKR");
// A task with no status or no % counts as 0, so the average cannot look better than the work really is.
const pctOf = (t) => (t.status === "Done" ? 100 : typeof t.pct === "number" ? t.pct : 0);
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
import { weekEndOf } from "./rules.js";

export function unitMetrics(plan, asOf) {
  const t = real(plan);
  const done = t.filter((x) => x.status === "Done");
  const nums = t.map(pctOf).filter((v) => v !== null);
  const dated = done.filter((x) => x.due && x.completedAt);
  return {
    total: t.length, done: done.length, avg: avg(nums),
    high: t.filter((x) => x.priority === "High").length, highDone: done.filter((x) => x.priority === "High").length,
    prog: t.filter((x) => x.status === "In progress").length,
    ns: t.filter((x) => x.status === "Not started" || !x.status).length,
    blk: t.filter((x) => x.status === "Blocked" || x.status === "Delayed").length,
    overdue: t.filter((x) => x.due && x.due < asOf && x.status !== "Done").length,
    onTime: dated.filter((x) => x.completedAt <= x.due).length, dated: dated.length,
    updated: !!(plan && plan.updatedAt && plan.updatedBy),
  };
}
function weekMetrics(byUnit, units, asOf) {
  const per = units.map((u) => ({ u, m: unitMetrics(byUnit[u.id], asOf) }));
  const s = per.reduce((a, { m }) => { Object.keys(m).forEach((k) => { if (typeof m[k] === "number") a[k] = (a[k] || 0) + m[k]; }); return a; }, {});
  const nums = per.flatMap(({ u }) => real(byUnit[u.id]).map(pctOf).filter((v) => v !== null));
  return { per, total: s.total || 0, done: s.done || 0, high: s.high || 0, highDone: s.highDone || 0, blk: s.blk || 0, overdue: s.overdue || 0, onTime: s.onTime || 0, dated: s.dated || 0,
    donePct: s.total ? Math.round((s.done / s.total) * 100) : null, avg: avg(nums), reporting: per.filter(({ m }) => m.total).length };
}

const heatBin = (v) => (v === null ? -1 : v < 20 ? 0 : v < 40 ? 1 : v < 60 ? 2 : v < 80 ? 3 : 4);

export function renderDashboard(c) {
  const { esc, fmt, weekLabel } = c.h;
  const sel = c.filter.units || [], per0 = c.filter.period || "week";
  const units = c.units.filter((u) => (!c.filter.type || u.type === c.filter.type) && (!sel.length || sel.includes(u.id)));
  if (!units.length) return `<div class="panel"><div class="empty"><b>No units to show</b></div></div>`;
  const asOf = (w) => (weekEndOf(w) < c.today ? weekEndOf(w) : c.today);
  const series = c.weeks.map((w) => ({ w, ...weekMetrics(c.byWeek[w] || {}, units, asOf(w)) }));
  let cur = series.find((s) => s.w === c.week) || series[series.length - 1];
  const prev = per0 === "week" ? series[series.indexOf(cur) - 1] : null;
  const winWeeks = per0 === "week" ? [c.week] : per0 === "quarter" ? c.weeks : c.weeks.filter((w) => { const a = c.h.toEth(w), b = c.h.toEth(c.week); return a.y === b.y && a.m === b.m; });
  if (per0 !== "week") {
    const byU = {};
    units.forEach((u) => { const m = new Map(); let last = null; winWeeks.forEach((w) => { const p = (c.byWeek[w] || {})[u.id]; if (!p) return; last = p; real(p).forEach((t) => m.set(t.ref || t.id, t)); }); if (last) byU[u.id] = { ...last, tasks: [...m.values()] }; });
    cur = { w: c.week, ...weekMetrics(byU, units, asOf(c.week)) };
  }
  const perLabel = per0 === "week" ? "this week" : per0 === "month" ? "this month" : "this quarter (last 13 weeks)";
  const delta = prev && prev.donePct !== null && cur.donePct !== null ? cur.donePct - prev.donePct : null;

  const nSel = sel.length, selLbl = !nSel ? "All units and functions" : nSel === 1 ? esc(c.unitName(sel[0])) : nSel + " selected";
  const grp = (t, lbl) => { const us = c.units.filter((u) => (u.type || "") === t); return us.length ? `<div class="dpop-g">${lbl}</div>${us.map((u) => `<label><input type="checkbox" data-dunit="${esc(u.id)}" ${sel.includes(u.id) ? "checked" : ""}>${esc(u.name)}</label>`).join("")}` : ""; };
  const types = [...new Set(c.units.map((u) => u.type || ""))];
  const filters = `<div class="dash-bar" role="group" aria-label="Dashboard filters">
    <div class="dpop-wrap"><button class="btn" id="dPopBtn" aria-expanded="${!!c.filter.pop}">${selLbl} <span aria-hidden="true">▾</span></button>
      ${c.filter.pop ? `<div class="dpop" id="dPop"><div class="dpop-top"><button class="lnk" data-dgrp="all">All</button><button class="lnk" data-dgrp="Business unit">All business units</button><button class="lnk" data-dgrp="Corporate function">All functions</button></div>${types.map((t) => grp(t, esc(t || "Other"))).join("")}
        <div class="dpop-g">Show</div><div class="dpop-sel"><select id="dCat" aria-label="Category"><option value="">All categories</option>${["Operational", "Revenue"].map((k) => `<option ${c.filter.category === k ? "selected" : ""}>${k}</option>`).join("")}</select>
        <select id="dLevel" aria-label="Count"><option value="deliverables" ${c.filter.level === "deliverables" ? "selected" : ""}>Count deliverables</option><option value="tasks" ${c.filter.level === "tasks" ? "selected" : ""}>Count all tasks</option></select></div></div>` : ""}</div>
    <div class="seg" role="tablist">${[["week", "Weekly"], ["month", "Monthly"], ["quarter", "Quarterly"]].map(([k, l]) => `<button role="tab" data-dper="${k}" aria-selected="${per0 === k}">${l}</button>`).join("")}</div>
    ${c.downloads ? `<button class="btn" id="pdfBtn" title="Performance report (PDF)">PDF</button>` : ""}</div>`;

  const pct = (n, t) => (t ? Math.round((n / t) * 100) : 0);
  const kpi = (k, v, of, p, pill) => `<div class="kpi"><div class="k">${k}</div><div class="v num">${v}${of ? ` <small>of ${of}</small>` : ""}</div><div class="kbar"><i style="width:${Math.min(100, p || 0)}%"></i></div>${pill ? `<span class="kpill">${pill}</span>` : ""}</div>`;
  const kpis = `<div class="kpis">
    ${kpi("Tasks done", cur.done, cur.total, cur.donePct, cur.donePct === null ? "No tasks" : `${cur.donePct}% done${delta === null ? "" : ` · ${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)} pts`}`)}
    ${kpi("Average % complete", cur.avg === null ? "–" : cur.avg + "%", "", cur.avg || 0, "Every task counts")}
    ${kpi("Units with a plan", cur.reporting, units.length, pct(cur.reporting, units.length), `${pct(cur.reporting, units.length)}% submitted`)}
    ${kpi("Blocked or overdue", `<span style="color:${cur.blk + cur.overdue ? "var(--bad)" : "inherit"}">${cur.blk + cur.overdue}</span>`, "", pct(cur.blk + cur.overdue, cur.total), `${cur.blk} blocked · ${cur.overdue} overdue`)}
  </div>`;

  const bullets = (() => {
    const rows = [...cur.per].sort((x, y) => (y.m.avg ?? -1) - (x.m.avg ?? -1) || x.u.name.localeCompare(y.u.name));
    return `<div class="bul">${rows.map(({ u, m }) => `<button class="bul-row" data-open-unit="${esc(u.id)}"><span class="bul-name">${esc(u.name)}</span><span class="bul-track"><i style="width:${m.avg === null ? 0 : Math.max(m.avg, 2)}%"></i></span><span class="bul-val num">${m.total ? `${m.avg ?? 0}% · ${m.done}/${m.total}` : "No plan"}</span></button>`).join("")}</div>`;
  })();

  const planned = (() => {
    const rows = series.slice(-8), max = Math.max(5, ...rows.map((r) => r.total)), W = 520, H = 250, L = 30, T = 18, B = 28, iw = W - L - 8, ih = H - T - B, bw = Math.min(34, (iw / rows.length) * 0.62);
    const cx = (i) => L + (i + 0.5) * (iw / rows.length), y = (v) => T + ih - (v / max) * ih;
    const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
    const g = ticks.map((v) => `<line x1="${L}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}" class="gridline"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="axis">${v}</text>`).join("");
    const bars = rows.map((r, i) => `<g data-tip="${esc(`<b>Week of ${fmt(r.w)}</b><br>Done: ${r.done} of ${r.total} planned`)}"><rect x="${cx(i) - bw / 2}" y="${y(r.total)}" width="${bw}" height="${Math.max(0, ih - (y(r.total) - T))}" rx="4" class="pl-plan"/><rect x="${cx(i) - bw / 2}" y="${y(r.done)}" width="${bw}" height="${Math.max(0, ih - (y(r.done) - T))}" rx="4" class="pl-done${r.w === c.week ? " cur" : ""}"/></g><text x="${cx(i)}" y="${H - 8}" text-anchor="middle" class="axis${r.w === c.week ? " cur" : ""}">${esc(fmt(r.w))}</text>${r.w === c.week && r.total ? `<text x="${cx(i)}" y="${y(r.total) - 5}" text-anchor="middle" class="endlbl">${r.done}/${r.total}</text>` : ""}`).join("");
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Tasks done against planned, last 8 weeks">${g}${bars}</svg><div class="legend"><span><i class="key-sq" style="background:var(--track)"></i>Planned</span><span><i class="key-sq" style="background:var(--bar)"></i>Done</span></div>`;
  })();

  const tblType = c.filter.tbl || (types.includes("Business unit") ? "Business unit" : types[0] || "");
  const tbl = (() => {
    const rows = cur.per.filter(({ u }) => (u.type || "") === tblType);
    return `<div class="seg" role="tablist" style="margin:12px 16px 4px">${types.map((t) => `<button role="tab" data-dtbl="${esc(t)}" aria-selected="${t === tblType}">${esc(t === "Business unit" ? "Business units" : t === "Corporate function" ? "Functions" : t || "Other")}</button>`).join("")}</div>
    <div class="scroll"><table class="dtbl"><thead><tr><th>Unit</th><th>Plan complete</th><th>Done</th><th>Blocked / overdue</th><th>Last update</th></tr></thead><tbody>${rows.map(({ u, m }) => {
      const p = (c.byWeek[c.week] || {})[u.id], bo = m.blk + m.overdue;
      return `<tr class="clickable" data-open-unit="${esc(u.id)}" tabindex="0"><td><b>${esc(u.name)}</b></td><td>${m.total ? `<span class="prog"><span class="bar"><i style="width:${m.avg ?? 0}%"></i></span><span class="num small">${m.avg ?? 0}%</span></span>` : '<span class="pill s-bad">No plan</span>'}</td><td class="num">${m.done}/${m.total}</td><td class="num" style="color:${bo ? "var(--bad)" : "inherit"}">${bo}</td><td class="small muted">${p && p.updatedAt ? esc(fmt(p.updatedAt.slice(0, 10))) : "–"}</td></tr>`;
    }).join("") || `<tr><td colspan="5" class="muted" style="padding:16px">Nothing in this group.</td></tr>`}</tbody></table></div>`;
  })();

  const asksPanel = (() => {
    const items = [];
    units.forEach((u) => { for (let i = winWeeks.length - 1; i >= 0; i--) { const p = (c.byWeek[winWeeks[i]] || {})[u.id]; if (p && (p.blockers || p.asks)) { if (p.blockers) items.push({ k: "Blocker", t: p.blockers, u }); if (p.asks) items.push({ k: "Ask", t: p.asks, u }); break; } } });
    return `<div class="panel"><div class="panel-head"><h2>Blockers and asks</h2><span class="small muted">Latest from each unit</span></div>${items.length ? `<ul class="ba">${items.slice(0, 8).map((x) => `<li><span class="pill ${x.k === "Blocker" ? "s-bad" : "s-prog"}">${x.k}</span><div><div class="ba-t">${esc(x.t.length > 160 ? x.t.slice(0, 157) + "…" : x.t)}</div><button class="lnk unit-name small muted" data-open-unit="${esc(x.u.id)}">${esc(x.u.name)}</button></div></li>`).join("")}</ul>${items.length > 8 ? `<div class="small muted" style="padding:0 16px 12px">+${items.length - 8} more</div>` : ""}` : `<div class="empty" style="padding:20px 16px"><b>None right now</b></div>`}</div>`;
  })();

  const title = !nSel ? "Wagwago Business Group" : nSel === 1 ? esc(c.unitName(sel[0])) : nSel + " units selected";
  const sub = per0 === "week" ? `Week of ${esc(weekLabel(c.week))} · ${esc(c.h.ethWeek(c.week))}` : per0 === "month" ? esc(c.h.ethMonth(c.week)) : `13 weeks to ${esc(fmt(c.week))}`;
  return `<div class="dh"><div><h1>${title}</h1><p>${sub}</p></div>${filters}</div>
    ${kpis}
    <div class="dgrid"><div class="panel"><div class="panel-head"><h2>Completion by unit</h2><span class="small muted">Average % complete · tasks done</span></div>${bullets}</div>
      <div class="panel"><div class="panel-head"><h2>Tasks done against planned</h2><span class="small muted">Last 8 weeks</span></div><div class="pad">${planned}</div></div></div>
    <div class="dgrid dgrid-b"><div class="panel"><div class="panel-head" style="border:0;padding-bottom:0"><h2>Units</h2><span class="small muted">Click a row to open its plan</span></div>${tbl}</div>
      <div class="dstack"><div class="panel"><div class="panel-head"><h2>Needs attention</h2><span class="small muted">Found automatically</span></div>${escalations(c)}</div>${asksPanel}</div></div>
    <details class="more"><summary>More charts</summary>
      <div class="grid2" style="margin-top:12px"><div class="panel"><div class="panel-head"><h2>Weekly trend</h2><span class="small muted">% done and average % complete</span></div>${trendChart(series, c)}</div>
      <div class="panel"><div class="panel-head"><h2>Completed by week</h2><span class="small muted">By completion date</span></div>${completedChart(units, c)}</div></div>
      <div class="grid2 even" style="margin-top:12px"><div class="panel"><div class="panel-head"><h2>Status mix by unit</h2></div>${statusChart(cur.per, c)}</div>
      <div class="panel"><div class="panel-head"><h2>Average % complete by unit and week</h2></div>${heatmap(units, c, asOf)}</div></div></details>`;
}

function trendChart(series, c) {
  const { esc, fmt } = c.h;
  const W = Math.max(300, Math.min(c.width, 820)), H = 280, L = 36, R = 64, T = 14, B = 30;
  const iw = W - L - R, ih = H - T - B, n = series.length;
  const x = (i) => L + (n === 1 ? iw / 2 : (i * iw) / (n - 1)), y = (v) => T + ih - (v / 100) * ih;
  const lines = [["donePct", "var(--viz-2)", "Tasks done"], ["avg", "var(--viz-1)", "Average % complete"]];
  const path = (k) => { let d = "", pen = false; series.forEach((s, i) => { if (s[k] === null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(s[k]).toFixed(1)}`; pen = true; }); return d; };
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${L}" x2="${L + iw}" y1="${y(v)}" y2="${y(v)}" class="gridline"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="axis">${v}%</text>`).join("");
  const step = Math.ceil(n / Math.max(2, Math.floor(iw / 70)));
  const xl = series.map((s, i) => (i % step === 0 || i === n - 1) ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="axis${s.w === c.week ? " cur" : ""}">${esc(fmt(s.w))}</text>` : "").join("");
  const last = series[n - 1];
  const ends = lines.map(([k, col]) => last[k] === null ? null : { k, y: y(last[k]), col, v: last[k] }).filter(Boolean);
  const collide = ends.length === 2 && Math.abs(ends[0].y - ends[1].y) < 14;
  const endLabels = collide ? "" : ends.map((e) => `<text x="${x(n - 1) + 10}" y="${e.y + 4}" class="endlbl">${e.v}%</text>`).join("");
  const dots = lines.map(([k, col]) => series.map((s, i) => s[k] === null ? "" : `<circle cx="${x(i)}" cy="${y(s[k])}" r="${i === n - 1 || s.w === c.week ? 4.5 : 3}" fill="${col}" class="ring"/>`).join("")).join("");
  const colW = n > 1 ? iw / (n - 1) : iw;
  const hits = series.map((s, i) => `<rect class="hit" x="${x(i) - colW / 2}" y="${T}" width="${colW}" height="${ih}" data-x="${x(i)}" data-tip="${esc(`<b>Week of ${fmt(s.w)}</b><br>Tasks done: ${s.donePct === null ? "no plans" : s.donePct + "% (" + s.done + " of " + s.total + ")"}<br>Average % complete: ${s.avg === null ? "–" : s.avg + "%"}<br>Units with a plan: ${s.reporting}`)}"/>`).join("");
  const svg = `<svg class="chart trend" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly trend of tasks done and average percent complete">
    ${grid}<line class="xhair" x1="0" x2="0" y1="${T}" y2="${T + ih}" style="display:none"/>
    ${lines.map(([k, col]) => `<path d="${path(k)}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join("")}
    ${dots}${endLabels}${xl}${hits}</svg>`;
  const legend = `<div class="legend">${lines.map(([, col, lbl]) => `<span><i class="key-line" style="background:${col}"></i>${lbl}</span>`).join("")}</div>`;
  const table = `<details class="viz-table"><summary class="small muted">Show the numbers</summary><div class="scroll"><table><thead><tr><th>Week</th><th>Tasks</th><th>Done</th><th>% done</th><th>Avg. complete</th><th>Units with a plan</th></tr></thead><tbody>${series.map((s) => `<tr><td>${esc(fmt(s.w))}</td><td class="num">${s.total}</td><td class="num">${s.done}</td><td class="num">${s.donePct ?? "–"}${s.donePct === null ? "" : "%"}</td><td class="num">${s.avg ?? "–"}${s.avg === null ? "" : "%"}</td><td class="num">${s.reporting}</td></tr>`).join("")}</tbody></table></div></details>`;
  return `<div class="chart-wrap">${legend}${svg}${table}</div>`;
}

// Tasks finished in each week, counted by their completion date (Saturday to Friday), once per task.
function completedChart(units, c) {
  const { esc, fmt } = c.h;
  const rows = c.weeks.map((w) => {
    const end = weekEndOf(w), seen = new Set(); let n = 0;
    units.forEach((u) => real((c.byWeek[w] || {})[u.id]).forEach((t) => {
      if (t.status !== "Done" || !t.completedAt || t.completedAt < w || t.completedAt > end) return;
      const key = u.id + "|" + (t.ref || t.id); if (!seen.has(key)) { seen.add(key); n++; }
    }));
    return { w, n };
  });
  const max = Math.max(1, ...rows.map((r) => r.n)), W = Math.max(300, Math.min(c.width * 1.5, 900)), H = 220, L = 34, R = 10, T = 16, B = 30, iw = W - L - R, ih = H - T - B;
  const bw = Math.min(46, (iw / rows.length) * 0.65), cx = (i) => L + (i + 0.5) * (iw / rows.length), y = (v) => T + ih - (v / max) * ih;
  const ticks = [0, Math.ceil(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const grid = ticks.map((v) => `<line x1="${L}" x2="${L + iw}" y1="${y(v)}" y2="${y(v)}" class="gridline"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="axis">${v}</text>`).join("");
  const step = Math.ceil(rows.length / Math.max(2, Math.floor(iw / 70)));
  const bars = rows.map((r, i) => `<rect x="${cx(i) - bw / 2}" y="${y(r.n)}" width="${bw}" height="${Math.max(r.n ? 2 : 0, ih - (y(r.n) - T))}" rx="3" fill="${r.w === c.week ? "var(--viz-1)" : "var(--viz-2)"}" data-tip="${esc(`<b>Week of ${fmt(r.w)}</b><br>Completed: ${r.n}`)}"/>${r.n ? `<text x="${cx(i)}" y="${y(r.n) - 5}" text-anchor="middle" class="endlbl">${r.n}</text>` : ""}`).join("");
  const xl = rows.map((r, i) => (i % step === 0 || i === rows.length - 1) ? `<text x="${cx(i)}" y="${H - 8}" text-anchor="middle" class="axis${r.w === c.week ? " cur" : ""}">${esc(fmt(r.w))}</text>` : "").join("");
  const total = rows.reduce((a, r) => a + r.n, 0);
  return `<div class="chart-wrap"><svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tasks completed in each week">${grid}${bars}${xl}</svg>
    <div class="small muted">${total} task${total === 1 ? "" : "s"} completed in these ${rows.length} weeks. The selected week is highlighted. Tasks need a completion date to be counted.</div>
    <details class="viz-table"><summary class="small muted">Show the numbers</summary><div class="scroll"><table><thead><tr><th>Week</th><th>Completed</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(fmt(r.w))}</td><td class="num">${r.n}</td></tr>`).join("")}</tbody></table></div></details></div>`;
}

function rankChart(per, c) {
  const { esc } = c.h;
  const rows = [...per].sort((a, b) => (b.m.avg ?? -1) - (a.m.avg ?? -1) || a.u.name.localeCompare(b.u.name));
  return `<div class="hbars">${rows.map(({ u, m }) => {
    const tip = esc(`<b>${esc(u.name)}</b><br>Average % complete: ${m.avg === null ? "–" : m.avg + "%"}<br>Done: ${m.done} of ${m.total}<br>High priority done: ${m.highDone} of ${m.high}`);
    return `<div class="hbar-row" data-tip="${tip}" data-open-unit="${esc(u.id)}" tabindex="0" role="button" aria-label="${esc(u.name)}: ${m.avg === null ? "no plan" : m.avg + "% average complete"}">
      <span class="hbar-name">${esc(u.name)}</span>
      <span class="hbar-track">${m.avg === null ? "" : `<i style="width:${Math.max(m.avg, 1)}%"></i>`}</span>
      <span class="hbar-val num">${m.avg === null ? `<span class="muted">${m.total ? "No % yet" : "No plan"}</span>` : `${m.avg}%`} <span class="muted small">${m.total ? `${m.done}/${m.total}` : ""}</span></span></div>`;
  }).join("")}</div>`;
}

const STATUS_SEG = [["done", "Done", "var(--viz-s1)"], ["prog", "In progress", "var(--viz-s2)"], ["ns", "Not started / no status", "var(--viz-s3)"], ["blk", "Blocked / delayed", "var(--viz-s4)"]];
function statusChart(per, c) {
  const { esc } = c.h;
  const rows = per.filter(({ m }) => m.total).sort((a, b) => b.m.done / b.m.total - a.m.done / a.m.total);
  const legend = `<div class="legend">${STATUS_SEG.map(([, l, col]) => `<span><i class="key-sq" style="background:${col}"></i>${l}</span>`).join("")}</div>`;
  if (!rows.length) return `<div class="empty"><b>No tasks this week</b></div>`;
  return `<div class="chart-wrap">${legend}<div class="hbars">${rows.map(({ u, m }) => `<div class="hbar-row">
      <span class="hbar-name">${esc(u.name)}</span>
      <span class="stack">${STATUS_SEG.map(([k, l, col]) => m[k] ? `<i style="flex:${m[k]};background:${col}" data-tip="${esc(`<b>${esc(u.name)}</b><br>${l}: ${m[k]} of ${m.total} (${Math.round((m[k] / m.total) * 100)}%)`)}"></i>` : "").join("")}</span>
      <span class="hbar-val num">${Math.round((m.done / m.total) * 100)}% <span class="muted small">done</span></span></div>`).join("")}</div></div>`;
}

function heatmap(units, c, asOf) {
  const { esc, fmt } = c.h;
  const weeks = c.weeks;
  const head = `<div class="hm-row hm-head"><span></span>${weeks.map((w) => `<span class="${w === c.week ? "cur" : ""}">${esc(fmt(w))}</span>`).join("")}</div>`;
  const body = units.map((u) => `<div class="hm-row"><span class="hm-name">${esc(u.name)}</span>${weeks.map((w) => {
    const m = unitMetrics((c.byWeek[w] || {})[u.id], asOf(w)), b = heatBin(m.total ? m.avg : null);
    return `<span class="hm-cell b${b}" data-tip="${esc(`<b>${esc(u.name)}</b> · week of ${fmt(w)}<br>${m.total ? `Average complete: ${m.avg ?? "–"}%<br>Done: ${m.done} of ${m.total}` : "No plan"}`)}">${m.total ? (m.avg ?? "–") : "–"}</span>`;
  }).join("")}</div>`).join("");
  const scale = `<div class="legend hm-scale"><span>Average % complete:</span>${["0–19", "20–39", "40–59", "60–79", "80–100"].map((l, i) => `<span><i class="key-sq hm-cell b${i}"></i>${l}</span>`).join("")}</div>`;
  return `<div class="chart-wrap">${scale}<div class="scroll"><div class="heatmap" style="--cols:${weeks.length}">${head}${body}</div></div></div>`;
}

function escalations(c) {
  const { esc } = c.h;
  const list = c.alerts.filter((a) => a.level !== "info" || a.kind === "waiting").slice(0, 4);
  if (!list.length) return `<div class="empty" style="padding:24px 16px"><b>Nothing to escalate</b>No overdue, long-blocked or missing plans this week.</div>`;
  return `<ul class="esc-list">${list.map((a) => `<li class="esc ${a.level}"><span class="pill ${a.level === "bad" ? "s-bad" : a.level === "warn" ? "s-not" : "s-none"}">${a.level === "bad" ? "Act now" : a.level === "warn" ? "Watch" : "Note"}</span>
    <div><button class="lnk unit-name" data-open-unit="${esc(a.unit)}">${esc(c.unitName(a.unit))}</button><div class="small">${esc(a.text)}</div>
    ${a.tasks.length ? `<div class="small muted">${a.tasks.slice(0, 2).map((t) => esc(t.title.length > 80 ? t.title.slice(0, 77) + "…" : t.title)).join(" · ")}${a.tasks.length > 2 ? ` · +${a.tasks.length - 2} more` : ""}</div>` : ""}</div></li>`).join("")}</ul>
    ${c.alerts.length > list.length ? `<div class="small muted" style="padding:0 16px 12px">+${c.alerts.length - list.length} more</div>` : ""}`;
}
