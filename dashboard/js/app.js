import { renderBars, renderTrace, renderCurves, renderWiring, updatePump, panelCellSvg, makeTip, pairPanels, pairSlots } from "./charts.js";
import { MockBench } from "./mock.js";
import { initCalibration, savedCalibration, describeCalibration } from "./calibrate.js";
import { initLoad, loadNoun } from "./load.js";
import { SerialLink } from "./serial.js";
import { buildReplay, replayPort, watchErrors, checkReplay } from "./replay.js";
import { readEntry, gradeMessage, searchMessage, benchLine } from "./manual.js";
import { RecordingPlayer, readRecording } from "./playback.js";

const TRACE_WINDOW_MS = 120000;
const MAX_PANEL_MA = 300;   // these panels are about 200 mA in full sun; anything above this is an open-input spike
const SENSOR_NOT_FOUND = /INA219\s+(X1|X2|Y1|Y2|OUT)\s+0x[0-9a-f]+\s+not found/i;
const SLOT_OF = { X1: 0, X2: 1, Y1: 2, Y2: 3 };
const MAX_RAW_LINES = 20000;
const MAX_TABLE_ROWS = 200;
const MODE_WORDS = { IDLE: "Idle", RUN: "Running", GRADE: "Grading", SWEEP: "Sweeping", SEARCH: "Searching", PROOF: "Proving", PUMPPROOF: "Pump A/B", CAL: "Calibrating" };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Set an element's text and, only when it actually changed, replay its entrance from css/motion.css
// (default: the soft cross-blur; the gain numeral passes "is-landing" for its first appearance).
function setText(el, text, cls = "is-swapping") {
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove("is-swapping", "is-landing"); void el.offsetWidth; el.classList.add(cls);
}

// Per-browser conveniences only (passport counter, bench notes, upload URL). Fail quietly in private windows.
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* unavailable */ } },
};

const state = {
  conn: "none",            // none | mock | serial | manual (typed in by hand) | recording (a file played by js/playback.js; never live)
  link: null,
  mode: "IDLE",
  pairing: null,
  pump: null,
  factors: [1, 1, 1, 1],
  panels: {},              // id -> grade entry
  liveCurrent: {},         // id -> mA
  liveHist: { 1: [], 2: [], 3: [], 4: [] },
  missingSlots: new Set(), // 0..3, set when the Uno reports that INA219 missing
  outMissing: false,       // no output sensor: the power trace would be electrical noise
  traceUnit: "W",
  films: { 2: true, 4: true },   // only known on the mock bench; real panels show no film overlay
  trace: [],               // {t, p, pairing}
  sweeps: {},
  search: null,
  proof: null,
  curveKind: "pv",
  raw: [],
  rows: [],
  lastPower: 0,
  errorTimer: null,
  passports: LS.get("ss.passports", null),   // panel position -> passport id, kept across runs
  benchNotes: LS.get("ss.benchNotes", ""),
  manualNote: LS.get("ss.manualNote", ""),
  uploadUrl: LS.get("ss.uploadUrl", ""),
  runId: null,
  runAt: null,
  autoUpload: LS.get("ss.autoUpload", true),
};

// The one-button demo: SEARCH, then PROOF once the search result arrives, then upload.
const PROOF_CYCLES = { sweep: 20, pump: 10 };
const demo = { active: false, stage: null, cycle: 0 };

const tip = makeTip($("tip"));
const els = {
  connText: $("conn-text"), modeText: $("mode-text"), pairingText: $("pairing-text"), pumpText: $("pump-text"),
  gainNumber: $("gain-number"), gainCi: $("gain-ci"), gainSub: $("gain-sub"),
  factBest: $("fact-best"), factWorst: $("fact-worst"), factAvg: $("fact-avg"), factPred: $("fact-pred"),
  panelRow: $("panel-row"), panelsNote: $("panels-note"),
  trace: $("trace-chart"), wiring: $("wiring-diagram"), bars: $("bars-chart"), curves: $("curves-chart"),
  mockBench: $("mock-bench"), calFactors: $("cal-factors"), dataBody: $("data-table").querySelector("tbody"),
};

// ---------- message handling ----------
let lineTap = null;   // the replay (?replay=1) listens here to check how each line was classified

// Returns how the line was taken: handled | rejected (known type, bad fields) | unknown (type) | ignored (not a message).
function onLine(line) {
  let status = "threw";
  try { status = dispatch(line); return status; } finally { if (lineTap) lineTap(line, status); }
}

function dispatch(line) {
  state.raw.push(line);
  if (state.raw.length > MAX_RAW_LINES) state.raw.splice(0, state.raw.length - MAX_RAW_LINES);
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return "ignored"; }      // boot noise and partial lines
  if (!msg || typeof msg.type !== "string") return "ignored";
  if (!Object.hasOwn(handlers, msg.type)) { addRow(msg); return "unknown"; }   // also "__proto__", "toString"
  try {
    if (handlers[msg.type](msg) === false) return "rejected";
  } catch (err) {
    console.error(`dashboard failed on a ${msg.type} message:`, err, line);
    return "threw";
  }
  addRow(msg);
  return "handled";
}

// Field checks: a known type with a field missing or of the wrong kind is ignored (the handler returns false)
// before it touches the state, so it can't leave NaN in a chart or replace good data. Only fields that
// protocol/PROTOCOL.md defines and that the page uses are checked.
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isPair = (p) => p === "A" || p === "B" || p === "C";
const isPanelId = (id) => id === 1 || id === 2 || id === 3 || id === 4;
const isFactors = (f) => Array.isArray(f) && f.length === 4 && f.every(isNum);
const isGradePanel = (p) => !!p && isPanelId(p.id) && isNum(p.isc_ma) && isNum(p.voc_v) && isNum(p.score)
  && isPair(p.grade) && (p.flags == null || (Array.isArray(p.flags) && p.flags.every((f) => typeof f === "string")));

function slotOfPanel(id) {
  return pairSlots(state.pairing || "A").indexOf(id);
}
function panelMissing(id) {
  const slot = slotOfPanel(id);
  return slot >= 0 && state.missingSlots.has(slot);
}
function smoothMa(id, v) {
  if (!(v >= 0 && v <= MAX_PANEL_MA)) return null;
  const h = state.liveHist[id];
  h.push(v);
  if (h.length > 5) h.shift();
  const sorted = [...h].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}
function noteMissingSensors() {
  const note = $("trace-note");
  const title = $("trace-title");
  if (!note || !title) return;
  if (state.outMissing) {
    setText(title, "Measured current, last two minutes");
    setText(note, "Current from the INA219 boards the Uno found. The output sensor is not on this bench, so its noise is not drawn.");
  }
}
const isPoint = (pt) => Array.isArray(pt) && isNum(pt[0]) && isNum(pt[1]);

const handlers = {
  hello(m) {
    if (isFactors(m.factors)) state.factors = m.factors;
    if (typeof m.mode === "string" && m.mode) state.mode = m.mode;
    if (isPair(m.pairing)) state.pairing = m.pairing;
    if (typeof m.pump === "boolean") state.pump = m.pump;
    renderReadouts(); renderCal(); renderWiringDiagram();
  },
  live(m) {
    if (!m.out || !isNum(m.out.p_w)) return false;     // no fake 0 W point on the trace
    if (typeof m.mode === "string" && m.mode) state.mode = m.mode;
    if (isPair(m.pairing)) state.pairing = m.pairing;
    state.pump = typeof m.pump === "boolean" ? m.pump : state.pump;
    if (Array.isArray(m.panels)) m.panels.forEach((pp) => {
      if (!pp || !isPanelId(pp.id) || !isNum(pp.i_ma)) return;
      if (panelMissing(pp.id)) { delete state.liveCurrent[pp.id]; state.liveHist[pp.id] = []; return; }
      const smoothed = smoothMa(pp.id, pp.i_ma);
      if (smoothed == null) return;                    // open-input spike, not a panel current
      state.liveCurrent[pp.id] = smoothed;
    });
    const powerOk = !state.outMissing && m.out.p_w >= 0 && m.out.p_w <= 8;
    const measuredMa = [1, 2, 3, 4].filter((id) => !panelMissing(id) && isNum(state.liveCurrent[id])).reduce((sum, id) => sum + state.liveCurrent[id], 0);
    if (state.outMissing) {
      state.traceUnit = "mA";
      state.lastPower = 0;
      state.trace.push({ t: Date.now(), p: measuredMa, pairing: state.pairing || "A" });
    } else if (powerOk) {
      state.traceUnit = "W";
      state.lastPower = m.out.p_w;
      state.trace.push({ t: Date.now(), p: m.out.p_w, pairing: state.pairing });
    }
    const cutoff = Date.now() - TRACE_WINDOW_MS - 2000;
    while (state.trace.length && state.trace[0].t < cutoff) state.trace.shift();
    renderReadouts(); renderTraceChart(); renderPanelLive();
    const key = `${state.pairing}|${state.pump}`;
    if (key !== state.diagramKey) renderWiringDiagram();
    else updatePump(els.wiring, { pump: state.pump, power: p, load: loadNoun() });
  },
  grade(m) {
    if (!Array.isArray(m.panels) || !m.panels.length || !m.panels.every(isGradePanel)) return false;
    m.panels.forEach((pp) => { if (!panelMissing(pp.id)) state.panels[pp.id] = pp; });
    state.predicted = isPair(m.predicted) ? m.predicted : null;
    ensurePassports();
    state.runId = newRunId(); state.runAt = new Date().toISOString();
    renderPanels(); renderWiringDiagram(); renderFacts(); renderBarsChart(); renderRunLine();
  },
  sweep(m) {
    if (!isPair(m.pairing) || !isNum(m.pmax_w) || !isNum(m.vmp_v) || !isNum(m.imp_ma)
      || !Array.isArray(m.pts) || !m.pts.length || !m.pts.every(isPoint)) return false;
    state.sweeps[m.pairing] = m;
    renderCurvesChart(); renderBarsChart();
  },
  search(m) {
    const pm = m.pmax_w;
    if (!pm || typeof pm !== "object" || Array.isArray(pm) || !Object.keys(pm).length
      || !Object.entries(pm).every(([k, v]) => isPair(k) && isNum(v)) || !isNum(pm[m.best])) return false;
    state.search = m;
    state.proof = null;          // a new search resets the proof
    renderBarsChart(); renderHeadline(); renderFacts(); renderRunLine();
    if (demo.active && demo.stage === "search") { demo.stage = "proof"; demo.cycle = 0; renderDemo(); sendCommand("PROOF"); }
  },
  proof(m) {
    if ((m.kind !== "sweep" && m.kind !== "pump") || !isPair(m.best) || !isPair(m.base)
      || !isNum(m.cycle) || !isNum(m.gain_pct) || !isNum(m.ci95_pct)) return false;
    state.proof = m;
    renderHeadline(); renderFacts(); renderRunLine();
    if (demo.active && demo.stage === "proof") { demo.cycle = m.cycle; renderDemo(); }
    if (m.cycle >= (PROOF_CYCLES[m.kind] || PROOF_CYCLES.sweep)) {
      if (demo.active) endDemo("done");
      if (state.autoUpload && state.conn !== "recording") uploadRun();   // a replay uploads only when asked (Data, Upload run)
    }
  },
  cal(m) {
    const hasBox = m.box != null; const hasFactors = m.factors != null;
    if ((!hasBox && !hasFactors) || (hasBox && !(isPanelId(m.box) && isNum(m.reading_ma))) || (hasFactors && !isFactors(m.factors))) return false;
    if (hasFactors) state.factors = m.factors;
    if (hasBox) { const span = document.querySelector(`[data-cal="${m.box}"]`); if (span) span.textContent = `${Number(m.reading_ma).toFixed(1)} mA`; }
    renderCal();
  },
  error(m) {
    const msg = typeof m.msg === "string" && m.msg ? m.msg : "error";
    const hit = msg.match(SENSOR_NOT_FOUND);
    if (hit) {
      const which = hit[1].toUpperCase();
      if (which === "OUT") { state.outMissing = true; state.trace = []; state.traceUnit = "mA"; }
      else state.missingSlots.add(SLOT_OF[which]);
      noteMissingSensors();
      renderPanels();
    }
    showError(msg);
    if (demo.active && !hit) endDemo("error");
  },
  log() {},
};

// ---------- rendering ----------
function renderReadouts() {
  setText(els.modeText, MODE_WORDS[state.mode] || state.mode);
  setText(els.pairingText, state.pairing ? `${state.pairing} (${pairPanels(state.pairing)})` : "—");
  els.pairingText.dataset.pair = state.pairing || "";
  els.pumpText.textContent = state.pump == null ? "—" : state.pump ? (state.lastPower > 0.15 ? `On, ${state.lastPower.toFixed(2)} W` : "On, stalled") : "Off";
  document.querySelectorAll(".btn--pair").forEach((b) => b.classList.toggle("is-active", b.dataset.pair === state.pairing));
}

function renderHeadline() {
  const pr = state.proof; const se = state.search;
  const gainCls = els.gainNumber.classList.contains("is-empty") ? "is-landing" : "is-swapping";
  if (pr) {
    const sign = pr.gain_pct >= 0 ? "+" : "−";
    setText(els.gainNumber, `${sign}${Math.abs(pr.gain_pct).toFixed(1)}%`, gainCls);
    els.gainNumber.classList.remove("is-empty");
    setText(els.gainCi, `±${Number(pr.ci95_pct).toFixed(1)} percentage points (95% confidence), ${pr.cycle} ${pr.cycle === 1 ? "cycle" : "cycles"}`);
    setText(els.gainSub, pr.kind === "pump"
      ? `More power into our ${loadNoun()} on wiring ${pr.best} than on wiring ${pr.base}. Load-dependent; the sweep figure is the claim.`
      : `More power from wiring ${pr.best} than from wiring ${pr.base}, each at its own maximum power point.`);
  } else if (se && se.pmax_w) {
    const vals = Object.values(se.pmax_w);
    const worst = Math.min(...vals); const best = se.pmax_w[se.best];
    const gain = worst > 0 ? (best / worst - 1) * 100 : 0;
    setText(els.gainNumber, `+${gain.toFixed(1)}%`, gainCls);
    els.gainNumber.classList.remove("is-empty");
    if (state.conn === "manual") {
      setText(els.gainCi, "From hand-measured power of each wiring. No proof cycles, so no confidence interval.");
      setText(els.gainSub, `Wiring ${se.best} made ${best.toFixed(2)} W, measured by hand; the worst wiring made ${worst.toFixed(2)} W.`);
    } else {
      setText(els.gainCi, "From one sweep of each wiring. Press Prove for a confidence interval.");
      setText(els.gainSub, `Wiring ${se.best} makes ${best.toFixed(2)} W at its maximum power point; the worst wiring makes ${worst.toFixed(2)} W.`);
    }
  } else {
    setText(els.gainNumber, "—");
    els.gainNumber.classList.add("is-empty");
    setText(els.gainCi, "");
    setText(els.gainSub, state.conn === "manual" ? "No wiring power was entered, so there is no gain to show." : "Run a search to measure the three wirings.");
  }
}

function renderFacts() {
  const se = state.search;
  if (se && se.pmax_w) {
    const vals = Object.values(se.pmax_w);
    const best = se.pmax_w[se.best];
    const worstKey = Object.keys(se.pmax_w).reduce((a, b) => (se.pmax_w[b] < se.pmax_w[a] ? b : a));
    const worst = se.pmax_w[worstKey];
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    setText(els.factBest, `${se.best}, panels ${pairPanels(se.best)}: ${best.toFixed(2)} W`);
    els.factBest.dataset.pair = se.best;
    const pr = state.proof;
    setText(els.factWorst, pr && pr.kind === "sweep"
      ? `+${Number(pr.gain_pct).toFixed(1)}% vs ${pr.base} (${pr.cycle} cycles)`
      : `+${((best / worst - 1) * 100).toFixed(1)}% vs ${worstKey} (${worst.toFixed(2)} W)`);
    setText(els.factAvg, `+${((best / avg - 1) * 100).toFixed(1)}% vs the ${avg.toFixed(2)} W average`);
    const by = state.conn === "manual" ? "the hand-measured power" : "the sweeps";
    setText(els.factPred, se.predicted ? `${se.predicted}, ${se.match ? `matched by ${by}` : `but ${by} chose ${se.best}`}` : "—");
    els.factPred.dataset.pair = se.predicted || "";
  } else {
    setText(els.factBest, "—"); setText(els.factWorst, "—"); setText(els.factAvg, "—");
    setText(els.factPred, state.predicted ? `${state.predicted}, from the current scores` : "—");
    els.factPred.dataset.pair = state.predicted || "";
  }
}

function flagWords(flags) {
  const words = { weak: "weak output", low_voc: "low voltage, possible failed cell group", dark: "no light or disconnected" };
  return (flags || []).map((f) => words[f] || f).join("; ");
}

function renderPanels() {
  const ids = [1, 2, 3, 4].filter((id) => !panelMissing(id));
  els.panelRow.innerHTML = ids.map((id) => {
    const p = state.panels[id];
    const flagged = p && p.flags && p.flags.length;
    return `<article class="panel ${flagged ? "is-flagged" : ""}" data-id="${id}">
      ${panelCellSvg({ name: `Panel ${id}`, film: !!state.films[id] && state.conn === "mock", dim: p && p.grade === "C" })}
      <div>
        <div class="panel__head"><span class="panel__name">Panel ${id}</span><span class="panel__grade ${p ? `g-${p.grade}` : ""}">${p ? esc(p.grade) : "–"}</span></div>
        <div class="panel__id">${state.passports ? esc(state.passports[id] || "") : "no passport yet"}</div>
        <div class="panel__rows">
          <div><span class="v">${p ? `${p.isc_ma.toFixed(0)} mA` : "—"}</span><span class="k">short-circuit current</span></div>
          <div><span class="v">${p ? `${p.voc_v.toFixed(2)} V` : "—"}</span><span class="k">open-circuit voltage</span></div>
          <div><span class="v">${p ? `${p.score.toFixed(0)}%` : "—"}</span><span class="k">of the strongest panel</span>
            <div class="panel__score"><i style="width:${p ? Math.max(0, Math.min(100, p.score)) : 0}%"></i></div></div>
        </div>
        <div class="panel__now">now <b data-live="${id}">${state.liveCurrent[id] != null ? `${state.liveCurrent[id].toFixed(0)} mA` : "—"}</b></div>
        <div class="panel__flags">${p ? esc(flagWords(p.flags)) : ""}</div>
      </div>
    </article>`;
  }).join("");
}

function renderPanelLive() {
  document.querySelectorAll("[data-live]").forEach((span) => {
    const v = state.liveCurrent[span.dataset.live];
    span.textContent = v != null ? `${v.toFixed(0)} mA` : "—";
  });
}

function renderTraceChart() {
  renderTrace(els.trace, { points: state.trace, now: Date.now(), windowMs: TRACE_WINDOW_MS, tip, unit: state.traceUnit });
}

function renderBarsChart() {
  const pmax = state.search ? state.search.pmax_w : Object.fromEntries(Object.entries(state.sweeps).map(([k, s]) => [k, s.pmax_w]));
  renderBars(els.bars, { pmax, best: state.search ? state.search.best : null, predicted: state.search ? state.search.predicted : state.predicted, tip });
}

function renderCurvesChart() {
  const curves = $("curves");
  const any = Object.keys(state.sweeps).length > 0;
  if (curves) curves.hidden = !any;
  renderCurves(els.curves, { sweeps: state.sweeps, kind: state.curveKind, tip });
}

function renderWiringDiagram() {
  const grades = Object.fromEntries(Object.values(state.panels).map((p) => [p.id, p.grade]));
  state.diagramKey = `${state.pairing}|${state.pump}`;
  renderWiring(els.wiring, { pairing: state.pairing, grades, films: state.conn === "mock" ? state.films : {}, pump: state.pump, power: state.lastPower, load: loadNoun() });
}

function renderCal() {
  els.calFactors.textContent = `Factors: ${state.factors.map((f) => Number(f).toFixed(2)).join(", ")}`;
}

function renderAll() {
  renderReadouts(); renderHeadline(); renderFacts(); renderPanels(); renderTraceChart(); renderWiringDiagram(); renderBarsChart(); renderCurvesChart(); renderCal();
}

function showError(msg) {
  setText(els.modeText, `Error: ${msg}`);
  els.modeText.style.color = "var(--alert)";
  clearTimeout(state.errorTimer);
  state.errorTimer = setTimeout(() => { els.modeText.style.color = ""; renderReadouts(); }, 6000);
}

function summarize(m) {
  switch (m.type) {
    case "live": return `${m.pairing}, ${m.out ? `${m.out.v} V, ${m.out.i_ma} mA, ${m.out.p_w} W` : ""}, pump ${m.pump ? "on" : "off"}`;
    case "grade": return (m.panels || []).map((p) => `P${p.id} ${p.isc_ma} mA ${p.voc_v} V ${p.grade}`).join("; ") + `; predicted ${m.predicted}`;
    case "sweep": return `${m.pairing}: ${m.pmax_w} W at ${m.vmp_v} V, Voc ${m.voc_v} V, Isc ${m.isc_ma} mA, ${m.n} samples`;
    case "search": return `best ${m.best}, predicted ${m.predicted}, ${Object.entries(m.pmax_w || {}).map(([k, v]) => `${k} ${v} W`).join(", ")}`;
    case "proof": return `${m.kind} cycle ${m.cycle}: ${m.best} ${m.p_best_w} W vs ${m.base} ${m.p_base_w} W, gain ${m.gain_pct}% ± ${m.ci95_pct}`;
    case "cal": return m.box ? `box ${m.box}: ${m.reading_ma} mA` : `factors ${(m.factors || []).join(", ")}`;
    case "error": case "log": return m.msg;
    case "hello": return `fw ${m.fw}, ${m.panels} panels, factors ${(m.factors || []).join(", ")}`;
    default: return JSON.stringify(m).slice(0, 120);
  }
}

function addRow(m) {
  if (m.type === "live" && state.rows.length && state.rows[state.rows.length - 1].type === "live") {
    state.rows[state.rows.length - 1] = { ...m, at: new Date() };   // collapse the stream of live lines
  } else {
    state.rows.push({ ...m, at: new Date() });
    if (state.rows.length > MAX_TABLE_ROWS) state.rows.shift();
  }
  if ($("data-sheet").open) renderTable();
}

function renderTable() {
  els.dataBody.innerHTML = state.rows.map((m) => `<tr><td>${m.at.toLocaleTimeString()}</td><td>${esc(m.type)}</td><td>${esc(summarize(m))}</td></tr>`).join("");
}

// ---------- passports and runs (docs/website-plan.md) ----------
function ensurePassports() {
  if (state.passports) return;
  let next = LS.get("ss.passportNext", 1);
  state.passports = {};
  for (let id = 1; id <= 4; id++) state.passports[id] = `SS-${String(next++).padStart(4, "0")}`;
  LS.set("ss.passportNext", next);
  LS.set("ss.passports", state.passports);
}

function newRunId() {
  const d = new Date(); const p = (n) => String(n).padStart(2, "0");
  return `run-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function benchDescription() {
  if (state.conn === "manual") return benchLine(state.manualNote || state.benchNotes);   // always says hand-entered
  if (state.conn === "recording") return `replayed from a recording (${recordingName}), not a live measurement${state.benchNotes ? `; ${state.benchNotes}` : ""}`;
  if (state.benchNotes) return state.benchNotes;
  if (state.conn === "mock" && mock && mock.calib) return `simulated: mock bench calibrated to measured panels (${describeCalibration(mock.calib)})`;
  if (state.conn === "mock" && mock) {
    const filmed = Object.keys(mock.film).filter((k) => mock.film[k]);
    return `mock bench, ${Math.round(mock.light * 100)}% of sun, ${Math.round(mock.filmT * 100)}% film on ${filmed.length ? "panels " + filmed.join(" and ") : "no panel"}`;
  }
  return "";
}

function buildPassports() {
  if (!state.passports) return [];
  const strongest = Math.max(0, ...Object.values(state.panels).map((p) => p.isc_ma));
  return [1, 2, 3, 4].filter((id) => state.panels[id]).map((id) => {
    const p = state.panels[id];
    return {
      passport_id: state.passports[id],
      panel_label: `P${id}`,
      measured_at: state.runAt,
      run_id: state.runId,
      isc_ma: p.isc_ma, isc_raw_ma: p.isc_raw_ma, voc_v: p.voc_v,
      score_pct: p.score, grade: p.grade, flags: p.flags || [],
      reference: { kind: "relative", strongest_isc_ma: strongest, box_factor: state.factors[id - 1], light: benchDescription() },
      rated: { isc_ma: null, voc_v: null, model: null },
      verified: state.search ? { best_pairing: state.search.best, pmax_w: state.search.pmax_w } : null,
    };
  });
}

function buildRun() {
  return {
    run_id: state.runId, measured_at: state.runAt, bench: benchDescription(), link: state.conn,
    factors: state.factors, panels: Object.values(state.panels), predicted: state.predicted,
    search: state.search, proof: state.proof, sweeps: state.sweeps, passports: buildPassports(),
  };
}

function renderRunLine() {
  const line = $("run-line");
  if (!state.runId) { line.textContent = "No run yet. Press Grade or Search."; return; }
  const n = buildPassports().length;
  line.textContent = `${state.runId}: ${n} passports${state.search ? `, best wiring ${state.search.best}` : ""}${state.proof ? `, gain ${state.proof.gain_pct}% ± ${state.proof.ci95_pct}` : ""}.`;
}

function renderPassportInputs() {
  document.querySelectorAll("[data-passport]").forEach((inp) => { inp.value = state.passports ? state.passports[inp.dataset.passport] || "" : ""; });
  $("bench-notes").value = state.benchNotes;
  $("upload-url").value = state.uploadUrl;
}

function startDemo() {
  if (!state.link || demo.active) return;
  demo.active = true; demo.stage = "search"; demo.cycle = 0;
  renderDemo();
  sendCommand("SEARCH");
}

function endDemo(why) {
  demo.active = false; demo.stage = null;
  renderDemo(why);
}

function renderDemo(why) {
  const btn = $("btn-demo");
  const status = $("deck-status");
  btn.classList.toggle("is-running", demo.active);
  btn.disabled = !state.link;
  if (demo.active) {
    setText(btn, demo.stage === "search" ? "Measuring and searching…" : `Proving, cycle ${demo.cycle} of ${PROOF_CYCLES.sweep}…`);
    setText(status, "Stop ends the demo early.");
    status.classList.remove("is-bad");
  } else {
    setText(btn, "Run the demo");
    if (why === "done") setText(status, "Demo finished: grades, best wiring and the proven gain are on screen.");
    else if (why === "error") { setText(status, "Demo stopped on an error; see the Mode readout."); status.classList.add("is-bad"); }
    else if (why === "stopped") setText(status, "Demo stopped.");
    else setText(status, "Grade, search and prove in one go, then upload.");
  }
}

async function uploadRun() {
  const status = $("upload-status");
  const deck = $("deck-status");
  status.classList.remove("is-bad");
  if (!state.runId) { status.textContent = "Nothing to upload yet."; return; }
  // default: the local server from tools/serve.py, when this page is served by it
  const url = state.uploadUrl || (location.protocol.startsWith("http") ? "/api/runs" : "");
  if (!url) { status.textContent = "No upload address set. Export instead."; return; }
  status.textContent = "Uploading…";
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildRun()) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const info = await res.json().catch(() => ({}));
    const siteUrl = info.site ? new URL(info.site, new URL(url, location.href)).href : "";
    status.innerHTML = `Uploaded ${esc(state.runId)}${siteUrl ? ` — <a href="${esc(siteUrl)}" target="_blank" rel="noopener">open the passports</a>` : ""}.`;
    if (!demo.active) { deck.textContent = state.conn === "recording" ? "Replayed run uploaded, labelled as a recording; passports are on the site." : "Run uploaded; passports are on the site."; deck.classList.remove("is-bad"); }
  } catch (err) {
    status.classList.add("is-bad");
    status.textContent = `Upload failed: ${err.message || err}. Export the JSON instead.`;
    if (!demo.active) { deck.textContent = "Run not uploaded; export it from Data."; deck.classList.add("is-bad"); }
  }
}

// ---------- links ----------
let mock = null;
let serial = null;

function setConn(kind, text) {
  state.conn = kind;
  document.body.dataset.conn = kind;
  els.connText.textContent = text;
  els.mockBench.hidden = kind !== "mock";
  document.querySelectorAll("[data-cmd]").forEach((b) => { b.disabled = kind === "none" || kind === "manual" || kind === "recording"; });
  document.querySelectorAll("[data-manual]").forEach((el) => {   // section notes that would be false for typed-in readings
    if (el.dataset.bench == null) el.dataset.bench = el.textContent;
    el.textContent = kind === "manual" ? el.dataset.manual : el.dataset.bench;
  });
  if (demo.active) endDemo("stopped"); else renderDemo();
  $("btn-mock").textContent = kind === "mock" ? "Stop mock bench" : "Use mock bench";
  $("btn-connect").textContent = kind === "serial" ? "Disconnect" : "Connect Uno";
}

function resetData() {
  state.panels = {}; state.liveCurrent = {}; state.liveHist = { 1: [], 2: [], 3: [], 4: [] }; state.missingSlots = new Set(); state.outMissing = false; state.traceUnit = "W"; state.trace = []; state.sweeps = {}; state.search = null; state.proof = null; state.predicted = null; state.lastPower = 0; state.mode = "IDLE"; state.pairing = null; state.pump = null;
  renderAll();
}

function startMock() {
  stopRecording();
  stopSerial();
  mock = new MockBench(onLine);
  mock.light = Number($("mock-light").value);
  mock.filmT = Number($("mock-film").value);
  document.querySelectorAll("[data-film]").forEach((c) => { mock.film[Number(c.dataset.film)] = c.checked; });
  mock.calib = savedCalibration();
  if (mock.calib) mock.film = { 1: false, 2: false, 3: false, 4: false };   // real panels: the readings already include any film
  state.films = { ...mock.film };
  state.link = mock;
  resetData();
  setConn("mock", mock.calib ? "Mock bench simulating your measured panels" : "Mock bench (simulated panels)");
  mock.connect();
}

function stopMock() {
  if (mock && state.link === mock) state.link = null;     // compare before dropping the reference
  if (mock) { mock.disconnect(); mock = null; }
}

// `port` is the replay's stand-in port; without it the browser asks the user to pick the board's port.
async function startSerial(port) {
  if (!port && !SerialLink.supported()) { els.connText.textContent = "Web Serial needs Chrome or Edge"; return; }
  stopRecording();
  stopMock();
  serial = new SerialLink(onLine, (status, detail) => {
    if (status === "connected") setConn("serial", `Arduino Uno on ${detail}`);
    else if (status === "lost") { setConn("none", `Link lost: ${detail}`); state.link = null; }
    else setConn("none", "Not connected");
  });
  state.link = serial;
  resetData();
  try {
    await serial.connect(port);
    await serial.send("STATUS");
  } catch (err) {
    state.link = null;
    setConn("none", err && err.name === "NotFoundError" ? "No port chosen" : `Could not open the port: ${err.message || err}`);
  }
}

function stopSerial() {
  if (serial && state.link === serial) state.link = null;
  if (serial) { serial.disconnect(); serial = null; }
}

async function sendCommand(cmd) {
  if (!state.link) { showError("not connected"); return; }
  try { await state.link.send(cmd); } catch (err) { showError(err.message || String(err)); }
}

// ---------- controls ----------
document.querySelectorAll("[data-cmd]").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.cmd === "STOP" && demo.active) endDemo("stopped");
  sendCommand(b.dataset.cmd);
}));
$("btn-demo").addEventListener("click", startDemo);
$("auto-upload").checked = state.autoUpload;
$("auto-upload").addEventListener("change", (e) => { state.autoUpload = e.target.checked; LS.set("ss.autoUpload", state.autoUpload); });
$("btn-connect").addEventListener("click", () => { if (state.conn === "serial") { stopSerial(); setConn("none", "Not connected"); } else startSerial(); });
$("btn-mock").addEventListener("click", () => { if (state.conn === "mock") { stopMock(); setConn("none", "Not connected"); } else startMock(); });
$("btn-cal").addEventListener("click", () => $("cal-sheet").showModal());
$("btn-data").addEventListener("click", () => { renderTable(); renderPassportInputs(); renderRunLine(); $("data-sheet").showModal(); });
document.querySelectorAll("[data-passport]").forEach((inp) => inp.addEventListener("change", () => {
  ensurePassports();
  state.passports[inp.dataset.passport] = inp.value.trim() || state.passports[inp.dataset.passport];
  LS.set("ss.passports", state.passports);
  renderPanels(); renderPassportInputs();
}));
$("bench-notes").addEventListener("change", (e) => { state.benchNotes = e.target.value.trim(); LS.set("ss.benchNotes", state.benchNotes); });
$("upload-url").addEventListener("change", (e) => { state.uploadUrl = e.target.value.trim(); LS.set("ss.uploadUrl", state.uploadUrl); });
$("btn-export-passports").addEventListener("click", () => {
  if (!state.runId) { $("upload-status").textContent = "Nothing to export yet. Press Grade or Search."; return; }
  download(`${state.runId}-passports.json`, JSON.stringify(buildRun(), null, 2), "application/json");
});
$("btn-upload").addEventListener("click", uploadRun);

// ---------- readings entered by hand (js/manual.js) ----------
// The typed numbers become grade and search messages that go through onLine() like serial lines.
function manualFields() {
  const val = (f) => document.querySelector(`[data-field="${f}"]`).value;
  return {
    isc: Object.fromEntries([1, 2, 3, 4].map((id) => [id, val(`isc-${id}`)])),
    voc: Object.fromEntries([1, 2, 3, 4].map((id) => [id, val(`voc-${id}`)])),
    pmax: Object.fromEntries(["A", "B", "C"].map((k) => [k, val(`pmax-${k}`)])),
  };
}
function showManualErrors(errors) {
  const bad = new Set(errors.map((e) => e.field));
  document.querySelectorAll("#manual-form [data-field]").forEach((inp) => inp.setAttribute("aria-invalid", bad.has(inp.dataset.field) ? "true" : "false"));
  $("manual-errors").innerHTML = [...new Set(errors.map((e) => e.msg))].map((m) => `<li>${esc(m)}</li>`).join("");
}
function useManualReadings() {
  const entry = readEntry(manualFields());
  if (entry.errors.length) { showManualErrors(entry.errors); document.querySelector(`[data-field="${entry.errors[0].field}"]`).focus(); return; }
  state.manualNote = $("manual-note").value.trim(); LS.set("ss.manualNote", state.manualNote);
  stopRecording(); stopMock(); stopSerial();
  setConn("manual", "Readings entered by hand (no bench)");
  resetData();
  state.factors = [1, 1, 1, 1]; renderCal();            // no lamp box: raw reading = corrected reading
  const grade = gradeMessage(entry.panels);
  const msgs = [{ type: "log", msg: "readings entered by hand from a multimeter; not measured by the bench" }, grade];
  if (entry.pmax) msgs.push(searchMessage(entry.pmax, grade.predicted));
  const refused = msgs.map((m) => [m.type, onLine(JSON.stringify(m))]).filter(([, st]) => st !== "handled");
  if (refused.length) { showManualErrors([{ field: "", msg: `The dashboard refused the ${refused.map(([t]) => t).join(" and ")} message built from these readings; don't upload this run.` }]); return; }
  showManualErrors([]);
  $("manual-sheet").close();
  const deck = $("deck-status"); deck.classList.remove("is-bad");
  setText(deck, `Hand-entered readings graded${entry.pmax ? `; best wiring ${state.search.best}` : ""}. Open Data to upload.`);
}
$("btn-manual").addEventListener("click", () => {
  $("manual-note").value = state.manualNote;
  $("manual-saved").textContent = benchLine(state.manualNote);
  showManualErrors([]);
  $("manual-sheet").showModal();
});
$("manual-note").addEventListener("input", (e) => { $("manual-saved").textContent = benchLine(e.target.value); });
$("btn-manual-use").addEventListener("click", useManualReadings);
$("manual-form").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); useManualReadings(); } });
window.secondString = { buildRun, buildPassports };   // for checking in the console
document.querySelectorAll(".seg__btn").forEach((b) => b.addEventListener("click", () => {
  state.curveKind = b.dataset.curve;
  document.querySelectorAll(".seg__btn").forEach((x) => x.classList.toggle("is-on", x === b));
  renderCurvesChart();
}));

// The mock bench can simulate four measured panels (js/calibrate.js); a change restarts it with them.
const calibration = initCalibration({ onChange: () => { if (state.conn === "mock") startMock(); } });
$("btn-calib").addEventListener("click", () => calibration.open());
initLoad(() => { renderWiringDiagram(); renderHeadline(); });

$("mock-light").addEventListener("input", (e) => { const v = Number(e.target.value); $("mock-light-out").textContent = `${Math.round(v * 100)}% of sun`; if (mock) mock.light = v; });
$("mock-film").addEventListener("input", (e) => { const v = Number(e.target.value); $("mock-film-out").textContent = `${Math.round(v * 100)}%`; if (mock) mock.filmT = v; });
document.querySelectorAll("[data-film]").forEach((c) => c.addEventListener("change", () => {
  if (mock) mock.film[Number(c.dataset.film)] = c.checked;
  state.films[Number(c.dataset.film)] = c.checked;
  renderPanels(); renderWiringDiagram();
}));

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
$("btn-dl-jsonl").addEventListener("click", () => download(`second-string-${stamp()}.jsonl`, state.raw.join("\n") + "\n", "application/x-ndjson"));
$("btn-dl-csv").addEventListener("click", () => {
  const rows = ["received_iso,t_ms,mode,pairing,pump,out_v,out_i_ma,out_p_w"];
  state.raw.forEach((line) => {
    let m; try { m = JSON.parse(line); } catch (_) { return; }
    if (m && m.type === "live" && m.out) rows.push([new Date().toISOString(), m.t, m.mode, m.pairing, m.pump, m.out.v, m.out.i_ma, m.out.p_w].join(","));
  });
  download(`second-string-live-${stamp()}.csv`, rows.join("\n") + "\n", "text/csv");
});

// re-draw charts when the window changes size
let resizeTimer = null;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { renderTraceChart(); renderBarsChart(); renderCurvesChart(); }, 80); }).observe(document.querySelector(".bench"));

// ---------- recordings: a bench session from a file, through the serial parser (js/playback.js) ----------
// Mock and serial are stopped while a recording plays, and starting either stops the recording. After the file
// ends its data stays on screen, still labelled as a recording, until another source starts.
const player = new RecordingPlayer(onLine);
let recordingName = "";
const SPEED_WORDS = { 0: "as fast as possible", 1: "1×", 4: "4×" };

async function playRecording(file) {
  const status = $("rec-status");
  const deck = $("deck-status");
  status.classList.remove("is-bad");
  let rec;
  try { rec = readRecording(await file.text(), file.name); } catch (err) {
    status.textContent = err.message || String(err);
    status.classList.add("is-bad");
    return null;
  }
  stopSerial(); stopMock();
  state.link = null;                 // commands go nowhere while a recording plays
  await player.stop();
  recordingName = file.name;
  resetData();
  setConn("recording", `Recording: ${file.name} (not live)`);
  $("btn-rec-stop").hidden = false;
  const what = rec.kind === "run" ? `${rec.messages} messages rebuilt from an exported run (no live power in run files)`
    : `${rec.lines} lines, ${rec.messages} messages${rec.skipped ? `; ${rec.skipped} mock bench lines left out` : ""}`;
  const words = () => `Playing ${file.name} at ${SPEED_WORDS[player.speed]}: ${what}.`;
  setText(deck, words()); deck.classList.remove("is-bad");
  status.textContent = words();
  player.onSpeed = () => { if (player.playing) { setText(deck, words()); status.textContent = words(); } };
  await player.play(rec, (why, detail) => {
    $("btn-rec-stop").hidden = true;
    const end = why === "done" ? `Recording ${file.name} finished; the data on screen is from it, not live. Recordings are not uploaded automatically.` : `Recording stopped: ${detail}.`;
    setText(deck, end); deck.classList.toggle("is-bad", why !== "done");
    status.textContent = end;
  });
  if ($("data-sheet").open) $("data-sheet").close();
  return rec;
}

function stopRecording() {
  if (!player.playing) return;
  player.stop();
  $("btn-rec-stop").hidden = true;
  const msg = `Playback of ${recordingName} stopped; the data on screen is from it, not live.`;
  setText($("deck-status"), msg);
  $("rec-status").textContent = msg;
}

player.speed = Number($("rec-speed").value);
$("rec-speed").addEventListener("change", (e) => { player.speed = Number(e.target.value); if (player.onSpeed) player.onSpeed(); });
$("rec-file").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";                // choosing the same file again plays it again
  if (file) playRecording(file);
});
$("btn-rec-stop").addEventListener("click", stopRecording);
window.secondString.playRecording = playRecording;

// ---------- replay (?replay=1): recorded lines through the real serial path, no board ----------
// ?replay=auto starts it on load; &speed=0 skips the 115200-baud pacing. Replays never upload runs.
const params = new URLSearchParams(location.search);
const replayMode = params.has("replay");

async function startReplay() {
  const btn = $("btn-replay");
  const status = $("deck-status");
  btn.disabled = true;
  status.classList.remove("is-bad");
  setText(status, "Replaying protocol samples through the serial parser…");
  state.autoUpload = false; $("auto-upload").checked = false;     // not saved: the next normal load uploads again
  const watch = watchErrors();
  const got = [];
  let report = null;
  try {
    const plan = await buildReplay(new URL("../protocol/samples/", location.href));
    const port = replayPort(plan.chunks, { speed: Number(params.get("speed") ?? 1) });
    stopSerial();
    lineTap = (line, st) => got.push({ line, status: st });
    await startSerial(port);
    if (state.conn === "serial") els.connText.textContent = "Replay of protocol samples (no board)";
    // the stream ends, or the link drops (which the check then reports)
    await Promise.race([port.finished, new Promise((r) => { const poll = () => (state.conn === "serial" ? setTimeout(poll, 100) : r()); poll(); })]);
    await new Promise((r) => setTimeout(r, 200));
    lineTap = null;
    report = checkReplay(plan, got, { errors: watch.stop(), sent: port.sent, conn: state.conn, doc: document });
    console.info(`[replay] ${report.ok ? "PASS" : "FAIL"}: ${report.lines} of ${report.expectedLines} lines from ${report.bytes} bytes`, report.counts);
    report.problems.forEach((p) => console.error(`[replay] ${p}`));
    setText(status, report.ok
      ? `Replay passed: ${report.lines} lines through the serial parser (${report.counts.handled || 0} messages, ${(report.lines - (report.counts.handled || 0))} bad lines ignored).`
      : `Replay failed: ${report.problems.length} problems; see the console.`);
    status.classList.toggle("is-bad", !report.ok);
  } catch (err) {
    console.error("[replay] could not run:", err);
    setText(status, `Replay could not run: ${err.message || err}`);
    status.classList.add("is-bad");
  } finally {
    lineTap = null;
    watch.stop();
    btn.disabled = false;
  }
  return report;
}
window.secondString.replay = startReplay;

// ---------- boot ----------
renderAll();
setConn("none", "Not connected");
if (replayMode) {
  $("btn-replay").hidden = false;
  $("btn-replay").addEventListener("click", startReplay);
  if (params.get("replay") === "auto") startReplay();
} else {
  startMock();
  setTimeout(() => { if (state.conn === "mock") sendCommand("SEARCH"); }, 1200);
}
