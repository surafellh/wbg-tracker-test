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
  const units = c.units.filter((u) => !c.filter.type || u.type === c.filter.type);
  if (!units.length) return `<div class="panel"><div class="empty"><b>No units to show</b></div></div>`;
  const asOf = (w) => (weekEndOf(w) < c.today ? weekEndOf(w) : c.today);
  const series = c.weeks.map((w) => ({ w, ...weekMetrics(c.byWeek[w] || {}, units, asOf(w)) }));
  const cur = series.find((s) => s.w === c.week) || series[series.length - 1];
  const prev = series[series.indexOf(cur) - 1];
  const delta = prev && prev.donePct !== null && cur.donePct !== null ? cur.donePct - prev.donePct : null;

  const filters = `<div class="toolbar dash-filters" role="group" aria-label="Dashboard filters">
    <label class="small muted" for="dType">Show</label><select id="dType"><option value="">All units</option><option ${c.filter.type === "Corporate function" ? "selected" : ""}>Corporate function</option><option ${c.filter.type === "Business unit" ? "selected" : ""}>Business unit</option></select>
    <label class="small muted" for="dRange">Trend</label><select id="dRange">${[8, 12].map((n) => `<option value="${n}" ${c.filter.range === n ? "selected" : ""}>Last ${n} weeks</option>`).join("")}</select>
    <span class="small muted">Week of ${esc(weekLabel(c.week))} · use the arrows above to change week</span>
    ${c.downloads ? `<button class="btn" id="pdfBtn">Performance report (PDF)</button>` : ""}</div>`;

  const tile = (v, k, sub, cls = "") => `<div class="stat ${cls}"><div class="v">${v}</div><div class="k">${k}</div>${sub ? `<div class="small muted" style="margin-top:4px">${sub}</div>` : ""}</div>`;
  const hero = `<div class="dash-hero panel">
      <div class="k small muted">Tasks done this week · all ${units.length === c.units.length ? "units" : esc(c.filter.type.toLowerCase() + "s")}</div>
      <div class="hero-fig">${cur.donePct === null ? "–" : cur.donePct + "%"}</div>
      <div class="small">${cur.done} of ${cur.total} tasks${delta === null ? "" : ` · <span class="delta ${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)} pts</span> vs last week`}</div>
    </div>`;
  const tiles = `<div class="stats dash-tiles">
      ${tile(cur.avg === null ? "–" : cur.avg + "%", "average % complete")}
      ${tile(`${cur.highDone} of ${cur.high}`, "High-priority tasks done", "", "")}
      ${tile(cur.dated ? Math.round((cur.onTime / cur.dated) * 100) + "%" : "–", "finished on or before the due date", cur.dated ? `${cur.onTime} of ${cur.dated} with dates` : "Shows once completion dates are recorded")}
      ${tile(`<span style="color:var(--bad)">${cur.blk + cur.overdue}</span>`, "blocked, delayed or overdue")}
      ${tile(`${cur.reporting} of ${units.length}`, "units with a plan")}
      ${tile(String(c.pending), "changes waiting for approval", c.pending ? `<button class="lnk" data-goto="approvals" style="padding:0">Review</button>` : "")}
    </div>`;

  return `${filters}<div class="dash-top">${hero}${tiles}</div>
    <div class="grid2" style="margin-top:16px">
      <div class="panel"><div class="panel-head"><h2>Weekly trend</h2><span class="small muted">% of tasks done and average % complete, per week</span></div>${trendChart(series, c)}</div>
      <div class="panel"><div class="panel-head"><h2>Escalations</h2><span class="small muted">Found automatically</span></div>${escalations(c)}</div>
    </div>
    <div class="grid2 even" style="margin-top:16px">
      <div class="panel"><div class="panel-head"><h2>Units by average % complete</h2><span class="small muted">${esc(weekLabel(c.week))}</span></div>${rankChart(cur.per, c)}</div>
      <div class="panel"><div class="panel-head"><h2>Status mix by unit</h2><span class="small muted">Share of each unit's tasks</span></div>${statusChart(cur.per, c)}</div>
    </div>
    <div class="panel" style="margin-top:16px"><div class="panel-head"><h2>Average % complete by unit and week</h2><span class="small muted">Stronger colour = further along. – = no plan that week</span></div>${heatmap(units, c, asOf)}</div>`;
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
  const list = c.alerts.filter((a) => a.level !== "info" || a.kind === "waiting").slice(0, 6);
  if (!list.length) return `<div class="empty" style="padding:24px 16px"><b>Nothing to escalate</b>No overdue, long-blocked or missing plans this week.</div>`;
  return `<ul class="esc-list">${list.map((a) => `<li class="esc ${a.level}"><span class="pill ${a.level === "bad" ? "s-bad" : a.level === "warn" ? "s-not" : "s-none"}">${a.level === "bad" ? "Act now" : a.level === "warn" ? "Watch" : "Note"}</span>
    <div><button class="lnk unit-name" data-open-unit="${esc(a.unit)}">${esc(c.unitName(a.unit))}</button><div class="small">${esc(a.text)}</div>
    ${a.tasks.length ? `<div class="small muted">${a.tasks.slice(0, 2).map((t) => esc(t.title.length > 80 ? t.title.slice(0, 77) + "…" : t.title)).join(" · ")}${a.tasks.length > 2 ? ` · +${a.tasks.length - 2} more` : ""}</div>` : ""}</div></li>`).join("")}</ul>
    ${c.alerts.length > list.length ? `<div style="padding:0 16px 12px"><button class="lnk" data-goto="follow" style="padding:0">${c.alerts.length - list.length} more in Follow-up</button></div>` : ""}`;
}
