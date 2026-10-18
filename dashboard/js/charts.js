// Hand-drawn SVG charts. Colour follows the wiring (A, B, C), never the rank.
// Each render function replaces the element's contents and wires up hover.

const PAIR_PANELS = { A: "1+2, 3+4", B: "1+3, 2+4", C: "1+4, 2+3" };
const SLOTS = { A: [1, 2, 3, 4], B: [1, 3, 2, 4], C: [1, 4, 3, 2] };

export const pairPanels = (p) => PAIR_PANELS[p] || "";
export const pairSlots = (p) => SLOTS[p] || SLOTS.A;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtW = (w) => `${w.toFixed(2)} W`;

function size(el) {
  return { W: Math.max(el.clientWidth, 240), H: Math.max(el.clientHeight, 200) };
}

function niceMax(v, minimum) {
  const m = Math.max(v * 1.12, minimum);
  const pow = 10 ** Math.floor(Math.log10(m));
  const n = m / pow;
  const step = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3 : n <= 5 ? 5 : 10;
  return step * pow;
}

// niceMax returns 1, 2, 2.5, 5 or 10 times a power of ten; pick a step that divides it evenly.
function ticks(max) {
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = Math.round((max / pow) * 100) / 100;
  const step = (n === 1 ? 0.25 : n === 1.5 ? 0.5 : n === 2 ? 0.5 : n === 2.5 ? 0.5 : n === 3 ? 1 : n === 5 ? 1 : 2) * pow;
  const out = [];
  for (let v = 0; v <= max + step / 1000; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}
const fmtTick = (t, max, unit, decimals) => (t === 0 ? "0" : `${decimals ? t.toFixed(decimals) : Math.round(t)}${t === max ? " " + unit : ""}`);

// A monocrystalline cell: pseudo-square with clipped corners, three busbars, faint fingers.
export function cellGlyph({ x = 0, y = 0, w = 120, h = 84, name = "", film = false, dim = false, cls = "", id = null, live = null }) {
  const c = Math.min(w, h) * 0.13;
  const poly = `${x + c},${y} ${x + w - c},${y} ${x + w},${y + h - c} ${x + w - c},${y + h} ${x + c},${y + h} ${x},${y + h - c} ${x},${y + c}`;
  let fingers = "";
  for (let fy = y + 6; fy < y + h - 3; fy += 6) {
    fingers += `<line x1="${x + 3}" y1="${fy}" x2="${x + w - 3}" y2="${fy}" stroke="rgba(255,255,255,0.09)" stroke-width="1"/>`;
  }
  const bus = [0.25, 0.5, 0.75].map((f) => `<line x1="${x + w * f}" y1="${y + 2}" x2="${x + w * f}" y2="${y + h - 2}" stroke="rgba(255,255,255,0.42)" stroke-width="1.5"/>`).join("");
  const filmLayer = film ? `<polygon points="${poly}" fill="var(--film)"/>` : "";
  const label = name ? `<text class="cell-name" x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle">${esc(name)}</text>` : "";
  const cellAttr = id == null ? "" : ` data-cell="${Number(id)}"`;
  const liveStyle = live == null ? "" : ` style="--live:${Number(live).toFixed(3)}"`;
  return `<g class="cell-face ${cls}"${cellAttr}${liveStyle} opacity="${dim ? 0.55 : 1}"><polygon class="cell-body" points="${poly}"/>${fingers}${bus}${filmLayer}${label}</g>`;
}

export function panelCellSvg(opts) {
  const id = opts.id == null ? "" : ` data-cell-ma="${Number(opts.id)}"`;
  const shown = opts.ma == null ? "" : `${Math.round(opts.ma)} mA`;
  return `<svg class="panel__cell" viewBox="0 0 120 84" role="img" aria-label="Panel ${esc(opts.name)}">${cellGlyph({ ...opts, name: "", x: 1, y: 1, w: 118, h: 82 })}<text class="cell-ma"${id} x="60" y="48" text-anchor="middle">${esc(shown)}</text></svg>`;
}

// ---------- tooltip ----------
export function makeTip(tipEl) {
  return {
    show(html, ev) {
      tipEl.innerHTML = html;
      tipEl.hidden = false;
      const pad = 12;
      let left = ev.clientX + pad;
      let top = ev.clientY + pad;
      const r = tipEl.getBoundingClientRect();
      if (left + r.width > window.innerWidth - 8) left = ev.clientX - r.width - pad;
      if (top + r.height > window.innerHeight - 8) top = ev.clientY - r.height - pad;
      tipEl.style.left = `${left}px`;
      tipEl.style.top = `${top}px`;
    },
    hide() { tipEl.hidden = true; },
  };
}

// ---------- bars: maximum power per wiring ----------
export function renderBars(el, { pmax, best, predicted, tip }) {
  const { W, H } = size(el);
  const pad = { l: 44, r: 12, t: 22, b: 58 };
  const keys = ["A", "B", "C"];
  const vals = keys.map((k) => (pmax && pmax[k] != null ? pmax[k] : null));
  const has = vals.some((v) => v != null);
  const max = niceMax(Math.max(...vals.map((v) => v || 0)), 0.5);
  const plotH = H - pad.t - pad.b;
  const plotW = W - pad.l - pad.r;
  const y = (v) => pad.t + plotH - (v / max) * plotH;
  const slot = plotW / 3;
  const bw = Math.min(56, slot * 0.5);

  let s = `<svg viewBox="0 0 ${W} ${H}" aria-label="Maximum power by wiring">`;
  s += `<g class="grid">${ticks(max).map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>`;
  s += `<g class="axis"><line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/></g>`;
  s += ticks(max).map((t) => `<text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmtTick(t, max, "W", 1)}</text>`).join("");
  keys.forEach((k, i) => {
    const cx = pad.l + slot * i + slot / 2;
    const v = vals[i];
    const bottom = y(0);
    if (v != null) {
      const top = y(v);
      const r = Math.min(4, (bottom - top) / 2);
      const d = `M${cx - bw / 2},${bottom} V${top + r} a${r},${r} 0 0 1 ${r},-${r} h${bw - 2 * r} a${r},${r} 0 0 1 ${r},${r} V${bottom} Z`;
      s += `<path class="fill--${k} bar" data-k="${k}" d="${d}"/>`;
      s += `<text class="label" x="${cx}" y="${top - 6}" text-anchor="middle">${fmtW(v)}</text>`;
    } else {
      s += `<line x1="${cx - bw / 2}" x2="${cx + bw / 2}" y1="${bottom}" y2="${bottom}" stroke="var(--busbar)" stroke-width="3"/>`;
    }
    const tags = [];
    if (k === best) tags.push("best");
    if (k === predicted) tags.push("predicted");
    s += `<text class="label" x="${cx}" y="${bottom + 16}" text-anchor="middle" fill="var(--pair-${k.toLowerCase()})">${k}</text>`;
    s += `<text class="label--muted" x="${cx}" y="${bottom + 30}" text-anchor="middle">${esc(PAIR_PANELS[k])}</text>`;
    if (tags.length) s += `<text class="label" x="${cx}" y="${bottom + 45}" text-anchor="middle">${tags.join(", ")}</text>`;
  });
  if (!has) s += `<text class="empty" x="${pad.l + plotW / 2}" y="${pad.t + plotH / 2}" text-anchor="middle">No sweeps yet</text>`;
  s += "</svg>";
  el.innerHTML = s;
  if (tip) {
    el.querySelectorAll(".bar").forEach((b) => {
      const k = b.dataset.k;
      b.addEventListener("mousemove", (ev) => tip.show(`Wiring ${k} (${PAIR_PANELS[k]}): ${fmtW(pmax[k])} at maximum power`, ev));
      b.addEventListener("mouseleave", () => tip.hide());
    });
  }
}

// ---------- trace: live output power, coloured by wiring ----------
export function renderTrace(el, { points, now, windowMs = 120000, tip, unit = "W" }) {
  const { W, H } = size(el);
  const pad = { l: 44, r: 14, t: 14, b: 26 };
  const plotH = H - pad.t - pad.b;
  const plotW = W - pad.l - pad.r;
  const t0 = now - windowMs;
  const vis = points.filter((p) => p.t >= t0);
  const max = niceMax(Math.max(0, ...vis.map((p) => p.p)), unit === "mA" ? 5 : 1);
  const fmtPoint = (v) => (unit === "mA" ? `${v.toFixed(0)} mA` : fmtW(v));
  const x = (t) => pad.l + ((t - t0) / windowMs) * plotW;
  const y = (v) => pad.t + plotH - (v / max) * plotH;

  let s = `<svg viewBox="0 0 ${W} ${H}" aria-label="${unit === "mA" ? "Measured current over the last two minutes" : "Output power over the last two minutes"}">`;
  s += `<g class="grid">${ticks(max).map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>`;
  s += `<g class="axis"><line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/></g>`;
  s += ticks(max).map((t) => `<text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmtTick(t, max, unit, unit === "mA" ? 0 : 1)}</text>`).join("");
  for (let k = 0; k <= 4; k++) {
    const t = t0 + (windowMs * k) / 4;
    const label = k === 4 ? "now" : `−${Math.round((windowMs * (4 - k)) / 4000)} s`;
    s += `<text x="${x(t)}" y="${H - 8}" text-anchor="${k === 4 ? "end" : k === 0 ? "start" : "middle"}">${label}</text>`;
  }
  // one polyline per run of the same wiring
  let run = [];
  let runPair = null;
  const flush = () => {
    if (run.length > 1) s += `<polyline class="series series--${runPair}" points="${run.map((p) => `${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join(" ")}"/>`;
    else if (run.length === 1) s += `<circle class="fill--${runPair}" cx="${x(run[0].t)}" cy="${y(run[0].p)}" r="2"/>`;
    run = [];
  };
  vis.forEach((p) => {
    if (p.pairing !== runPair || (run.length && p.t - run[run.length - 1].t > 1500)) { flush(); runPair = p.pairing; }
    run.push(p);
  });
  flush();
  if (vis.length) {
    const last = vis[vis.length - 1];
    s += `<circle class="marker fill--${last.pairing}" cx="${x(last.t)}" cy="${y(last.p)}" r="4"/>`;
  } else {
    s += `<text class="empty" x="${pad.l + plotW / 2}" y="${pad.t + plotH / 2}" text-anchor="middle">Waiting for live readings</text>`;
  }
  s += `<line id="trace-cross" class="crosshair" y1="${pad.t}" y2="${pad.t + plotH}" x1="-10" x2="-10"/>`;
  s += `<rect class="hit" x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="transparent"/>`;
  s += "</svg>";
  el.innerHTML = s;
  if (tip && vis.length) {
    const hit = el.querySelector(".hit");
    const cross = el.querySelector("#trace-cross");
    hit.addEventListener("mousemove", (ev) => {
      const r = el.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const t = t0 + ((px - pad.l) / plotW) * windowMs;
      let best = vis[0];
      for (const p of vis) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      cross.setAttribute("x1", x(best.t)); cross.setAttribute("x2", x(best.t));
      tip.show(`${fmtPoint(best.p)} on wiring ${best.pairing}, ${((now - best.t) / 1000).toFixed(0)} s ago`, ev);
    });
    hit.addEventListener("mouseleave", () => { tip.hide(); cross.setAttribute("x1", -10); cross.setAttribute("x2", -10); });
  }
}

// ---------- curves: P-V or I-V for each wiring ----------
export function renderCurves(el, { sweeps, kind = "pv", tip }) {
  const { W, H } = size(el);
  const pad = { l: 46, r: 14, t: 18, b: 30 };
  const plotH = H - pad.t - pad.b;
  const plotW = W - pad.l - pad.r;
  const keys = ["A", "B", "C"].filter((k) => sweeps[k] && sweeps[k].pts && sweeps[k].pts.length);
  const series = keys.map((k) => ({
    k,
    pts: sweeps[k].pts.map(([v, i]) => ({ v, i, p: (v * i) / 1000 })),
    sweep: sweeps[k],
  }));
  const maxV = niceMax(Math.max(0, ...series.flatMap((s) => s.pts.map((p) => p.v))), 1);
  const maxY = niceMax(Math.max(0, ...series.flatMap((s) => s.pts.map((p) => (kind === "pv" ? p.p : p.i)))), 1);
  const x = (v) => pad.l + (v / maxV) * plotW;
  const y = (val) => pad.t + plotH - (val / maxY) * plotH;
  const unit = kind === "pv" ? "W" : "mA";

  let s = `<svg viewBox="0 0 ${W} ${H}" aria-label="${kind === "pv" ? "Power against voltage" : "Current against voltage"} for each wiring">`;
  s += `<g class="grid">${ticks(maxY).map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>`;
  s += `<g class="axis"><line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/><line x1="${pad.l}" x2="${pad.l}" y1="${pad.t}" y2="${y(0)}"/></g>`;
  s += ticks(maxY).map((t) => `<text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmtTick(t, maxY, unit, kind === "pv" ? 1 : 0)}</text>`).join("");
  s += ticks(maxV).map((t) => `<text x="${x(t)}" y="${H - 10}" text-anchor="middle">${fmtTick(t, maxV, "V", maxV < 5 ? 1 : 0)}</text>`).join("");
  series.forEach((sr) => {
    const path = sr.pts.map((p, i) => `${i ? "L" : "M"}${x(p.v).toFixed(1)},${y(kind === "pv" ? p.p : p.i).toFixed(1)}`).join("");
    s += `<path class="series series--${sr.k}" d="${path}"/>`;
  });
  // markers and direct labels, nudged apart when two maximum points nearly coincide
  const placed = [];
  series.forEach((sr) => {
    const sw = sr.sweep;
    const mx = x(sw.vmp_v);
    const my = y(kind === "pv" ? sw.pmax_w : sw.imp_ma);
    s += `<circle class="marker fill--${sr.k}" cx="${mx}" cy="${my}" r="4.5"/>`;
    const txt = kind === "pv" ? `${sr.k} ${fmtW(sw.pmax_w)}` : `${sr.k} ${Math.round(sw.imp_ma)} mA at ${sw.vmp_v.toFixed(1)} V`;
    const anchor = mx > pad.l + plotW * 0.7 ? "end" : "start";
    let ly = my - 8;
    for (const o of placed) if (Math.abs(o.x - mx) < 90 && Math.abs(o.y - ly) < 14) ly = o.y + 14;
    placed.push({ x: mx, y: ly });
    s += `<text class="label" x="${mx + (anchor === "end" ? -8 : 8)}" y="${ly}" text-anchor="${anchor}">${esc(txt)}</text>`;
  });
  if (!series.length) s += `<text class="empty" x="${pad.l + plotW / 2}" y="${pad.t + plotH / 2}" text-anchor="middle">No sweeps yet</text>`;
  s += `<rect class="hit" x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="transparent"/>`;
  s += "</svg>";
  el.innerHTML = s;
  if (tip && series.length) {
    const hit = el.querySelector(".hit");
    hit.addEventListener("mousemove", (ev) => {
      const r = el.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const py = ((ev.clientY - r.top) / r.height) * H;
      let bestD = Infinity; let bestP = null; let bestK = null;
      series.forEach((sr) => sr.pts.forEach((p) => {
        const d = Math.hypot(x(p.v) - px, y(kind === "pv" ? p.p : p.i) - py);
        if (d < bestD) { bestD = d; bestP = p; bestK = sr.k; }
      }));
      if (bestP) tip.show(`Wiring ${bestK}: ${bestP.v.toFixed(2)} V, ${Math.round(bestP.i)} mA, ${fmtW(bestP.p)}`, ev);
    });
    hit.addEventListener("mouseleave", () => tip.hide());
  }
}

// ---------- wiring diagram: 2S2P with the active slot assignment ----------
function pumpCaption({ pump, power, measuredMa, load }) {
  if (pump === false) return `${load} off`;
  if (pump && typeof power === "number" && power > 0.15) return `${load} ${power.toFixed(2)} W`;
  if (pump && power == null && typeof measuredMa === "number") return `${Math.round(measuredMa)} mA`;
  if (pump) return `${load} stalled`;
  return load;
}

export function renderWiring(el, { pairing, grades = {}, films = {}, pump, power, load = "pump", liveLevels = {}, measuredMa = null }) {
  const slots = pairSlots(pairing);
  const W = 360; const H = 230;
  const busTop = 30; const busBot = 206;
  const strings = [{ x: 96, top: slots[0], bot: slots[1], name: "String X" }, { x: 226, top: slots[2], bot: slots[3], name: "String Y" }];
  const cw = 56; const ch = 44;
  const yTop = 58; const yBot = 126;
  const color = pairing ? `var(--pair-${pairing.toLowerCase()})` : "var(--ink-3)";
  let s = `<svg viewBox="0 0 ${W} ${H}" aria-label="Wiring diagram for wiring ${esc(pairing || "")}">`;
  s += `<text class="label" x="14" y="18" fill="${color}">${pairing ? `Wiring ${pairing}` : "No wiring selected"}</text>`;
  s += `<text class="diagram-label" x="${W - 14}" y="18" text-anchor="end">${pairing ? esc(PAIR_PANELS[pairing]) : ""}</text>`;
  // buses
  s += `<line class="wire" x1="40" x2="318" y1="${busTop}" y2="${busTop}"/><text class="diagram-label" x="14" y="${busTop + 4}">out</text>`;
  s += `<line class="wire" x1="40" x2="318" y1="${busBot}" y2="${busBot}"/><text class="diagram-label" x="14" y="${busBot + 4}">0 V</text>`;
  strings.forEach((st) => {
    const cx = st.x;
    s += `<text class="diagram-label" x="${cx}" y="${yTop - 10}" text-anchor="middle">${st.name}</text>`;
    // wires with shunt marks (the INA219s sit at the top and bottom of each string)
    s += `<line class="wire" x1="${cx}" x2="${cx}" y1="${busTop}" y2="${yTop}"/>`;
    s += `<rect class="node" x="${cx - 6}" y="${(busTop + yTop) / 2 - 3}" width="12" height="6" rx="1"/>`;
    s += `<line class="wire" x1="${cx}" x2="${cx}" y1="${yTop + ch}" y2="${yBot}"/>`;
    s += `<line class="wire" x1="${cx}" x2="${cx}" y1="${yBot + ch}" y2="${busBot}"/>`;
    s += `<rect class="node" x="${cx - 6}" y="${(yBot + ch + busBot) / 2 - 3}" width="12" height="6" rx="1"/>`;
    [[st.top, yTop], [st.bot, yBot]].forEach(([panel, yy]) => {
      s += cellGlyph({ x: cx - cw / 2, y: yy, w: cw, h: ch, name: `P${panel}`, film: !!films[panel], dim: grades[panel] === "C", id: panel, live: liveLevels[panel] ?? 0 });
    });
  });
  // output branch and pump
  const px = 318; const py = (busTop + busBot) / 2;
  s += `<line class="wire" x1="${px}" x2="${px}" y1="${busTop}" y2="${py - 16}"/><line class="wire" x1="${px}" x2="${px}" y1="${py + 16}" y2="${busBot}"/>`;
  s += `<circle class="pump-ring" cx="${px}" cy="${py}" r="15"/>`;
  const spinning = pump && power > 0.15;
  const period = spinning ? Math.max(0.35, 2.2 - power / 2.5).toFixed(2) : 1;
  s += `<g class="pump-vane ${spinning ? "is-spinning" : ""}" style="--spin:${period}s">${[0, 120, 240].map((a) => `<line x1="${px}" y1="${py}" x2="${(px + 11 * Math.cos((a * Math.PI) / 180)).toFixed(1)}" y2="${(py + 11 * Math.sin((a * Math.PI) / 180)).toFixed(1)}"/>`).join("")}</g>`;
  s += `<text class="diagram-label" x="${px}" y="${py + 34}" text-anchor="middle">${esc(pumpCaption({ pump, power, measuredMa, load }))}</text>`;
  s += "</svg>";
  el.innerHTML = s;
}

export function updatePump(el, { pump, power, load = "pump", measuredMa = null }) {
  const vane = el.querySelector(".pump-vane");
  const label = el.querySelector(".diagram-label:last-of-type");
  if (!vane) return;
  const spinning = pump && typeof power === "number" && power > 0.15;
  vane.classList.toggle("is-spinning", !!spinning);
  if (spinning) vane.style.setProperty("--spin", `${Math.max(0.35, 2.2 - power / 2.5).toFixed(2)}s`);
  if (label) label.textContent = pumpCaption({ pump, power, measuredMa, load });
}
