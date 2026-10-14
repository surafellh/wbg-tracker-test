// "Action for the CEO": what the CEO should do about a unit, from its progress and the Performance Evaluation Manual
// (rating scale 7.3.4, corrective actions 7.10, RACI notes). Pure functions, no screen code.
import { calcPct } from "./rules.js";

export const BANDS = [
  { id: "outstanding", label: "Outstanding", min: 95 }, { id: "veryhigh", label: "Very High", min: 90 }, { id: "high", label: "High", min: 80 },
  { id: "satisfactory", label: "Satisfactory", min: 75 }, { id: "needs", label: "Needs Improvement", min: 50 }, { id: "low", label: "Low", min: 0 },
];
export const bandOf = (pct) => BANDS.find((b) => pct >= b.min) || BANDS[BANDS.length - 1];

const pctOf = (t) => (t.status === "Done" ? 100 : typeof t.pct === "number" ? t.pct : 0);
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// tasks: leaf tasks of the selection. type: "Business unit" | "Corporate function". today: ISO date.
export function assess({ name, type, tasks, today }) {
  const t = tasks.filter((x) => x.kind !== "KPI / OKR");
  if (!t.length) return null;
  const isBU = type !== "Corporate function";
  const fin = t.filter((x) => x.category === "Revenue"), ops = t.filter((x) => x.category !== "Revenue");
  const finPct = avg(fin.map((x) => { const c = calcPct(x); return c == null ? pctOf(x) : c; })), opsPct = avg(ops.map(pctOf));
  const overall = avg(t.map(pctOf));
  // Business units are judged mainly on financial performance (50% of the scorecard); functions on delivery to business units.
  const score = isBU ? (finPct != null && opsPct != null ? Math.round((finPct + opsPct) / 2) : finPct != null ? finPct : opsPct) : overall;
  const band = bandOf(score);
  const blocked = t.filter((x) => x.status === "Blocked"), overdue = t.filter((x) => x.due && x.due < today && x.status !== "Done");
  const highOpen = t.filter((x) => x.priority === "High" && x.status !== "Done");
  return { name, isBU, score, band, overall, finPct, finN: fin.length, opsPct, blocked: blocked.length, overdue: overdue.length, highOpen: highOpen.length, total: t.length };
}

// period: "week" (a check-in, light touch) or "month" (firmer: written plans and notices). Leadership changes and
// restructuring are quarterly decisions and are not proposed here.
export function actions(a, period) {
  const n = a.name, out = [], head = a.isBU ? "the unit head" : "the function head", wk = period !== "month";
  const fin = a.isBU && a.finPct != null && a.finPct < 75 ? `Revenue and profit stand at ${a.finPct}% of target.` : "";
  switch (a.band.id) {
    case "outstanding": case "veryhigh":
      out.push(wk ? `Acknowledge ${n}'s week to ${head}.` : `Recognise ${n} formally under the Incentive System and have ${head} present what is working to the Management Committee.`);
      if (!wk) out.push(a.isBU ? `Raise ${n}'s next revenue and profit targets and assign it a stretch growth mandate.` : `Hold ${n} up as the standard for on-time delivery and response to business units, and extend its practice to other functions.`);
      break;
    case "high":
      out.push(wk ? `No intervention needed.` : `Keep ${n} on its current plan.`);
      out.push(wk ? `Ask ${head} to close the ${plural(a.highOpen, "open high-priority item")}.` : `Instruct ${head} to close the remaining gaps (${plural(a.highOpen, "high-priority item")} still open) before the next review.`);
      break;
    case "satisfactory":
      out.push(wk ? `Ask ${head} which tasks will be closed next week, and by whom.` : `Instruct ${head} to name the tasks that will lift ${n} above 80% and fix the date of the next review in writing.`);
      if (fin) out.push(wk ? fin + ` Ask how the gap will be closed.` : fin + ` Require a revenue catch-up plan.`);
      break;
    case "needs":
      out.push(wk ? `Call ${head} this week and ask for a catch-up plan with dates for the open tasks.` : `Hold a performance meeting with ${head}. Agree an improvement plan and the next review date in writing at the same meeting.`);
      if (!wk) out.push(`Have the root causes identified and recorded before the plan is signed.`);
      if (fin) out.push(wk ? fin + ` Ask for the plan to close it.` : fin + ` Order a revenue recovery plan with weekly figures.`);
      else if (!a.isBU && !wk) out.push(`Require ${n} to show the support it delivered to business units this period and what it will deliver on time from now.`);
      break;
    default:
      if (wk) { out.push(`Meet ${head} this week. Ask for the reasons and a recovery plan for next week.`); if (fin) out.push(fin); }
      else {
        out.push(`Issue a written notice to ${head} with the improvement plan required, and record it in the Performance Portal.`);
        out.push(`Confirm that the support promised (resources, budget, staffing, systems) has actually been provided, and that root causes are identified.`);
        if (fin) out.push(fin);
      }
  }
  if (a.blocked) out.push(wk ? `Ask who clears the ${plural(a.blocked, "blocked task")}.` : `Remove the blockers: ${plural(a.blocked, "task")} blocked. Decide who clears each one.`);
  if (a.overdue >= 3 || (a.total && a.overdue / a.total >= 0.2)) out.push(wk ? `${plural(a.overdue, "task")} past due. Ask ${head} to re-date or close them.` : `${plural(a.overdue, "task")} past due. Require ${head} to re-date or close them and report the reasons.`);
  return out;
}
