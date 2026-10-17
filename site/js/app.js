// Second String site: passport index, passport pages with QR codes, the Array Builder, an impact stub.
// Plain script, hash-routed, no build step; works from a static host or a local http.server.
(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
  const num = (x, digits) => (x != null && x !== "" && Number.isFinite(Number(x)) ? Number(x).toFixed(digits) : "—");
  const PAIR_PANELS = { A: "1+2, 3+4", B: "1+3, 2+4", C: "1+4, 2+3" };
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* unavailable or full */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* unavailable */ } },
  };

  // ---------- data ----------
  // Keep only what the pages can draw: a run_id string and passports that are objects with a passport_id string.
  // Anything else (a hand-edited file, an older export) is dropped here instead of crashing a page later.
  function normalizeRun(run) {
    if (!run || typeof run !== "object" || !Array.isArray(run.passports)) throw new Error("not a run export: no passports array");
    if (typeof run.run_id !== "string" || !run.run_id) throw new Error("not a run export: no run_id");
    const passports = run.passports
      .filter((p) => p && typeof p === "object" && typeof p.passport_id === "string" && p.passport_id)
      .map((p) => ({ ...p, flags: Array.isArray(p.flags) ? p.flags.filter((f) => typeof f === "string") : [] }));
    if (!passports.length) throw new Error("not a run export: no passport has a passport_id");
    return { ...run, passports };
  }
  let runs = [];
  const stored = LS.get("ss.site.runs", []);
  (Array.isArray(stored) ? stored : []).forEach((r) => { try { runs.push(normalizeRun(r)); } catch (_) { /* stored by an older version: drop it */ } });
  function saveRuns() { LS.set("ss.site.runs", runs); }
  function addRun(raw) {
    const run = normalizeRun(raw);
    runs = runs.filter((r) => r.run_id !== run.run_id);
    runs.push(run);
    runs.sort((a, b) => String(a.measured_at).localeCompare(String(b.measured_at)));
    saveRuns();
  }
  function passports() {
    // latest passport per ID
    const map = new Map();
    runs.forEach((r) => r.passports.forEach((p) => { map.set(p.passport_id, { ...p, run: r }); }));
    return [...map.values()].sort((a, b) => String(a.passport_id).localeCompare(String(b.passport_id)));
  }
  function passport(id) { return passports().find((p) => p.passport_id === id); }
  // true until the first pull of runs (the local API, then data/runs/index.json) has finished; empty states say "Loading…" meanwhile
  let loading = true, loadingShown = false;
  const emptyNote = (html) => { if (loading) loadingShown = true; return loading ? `<p class="muted">Loading passports…</p>` : html; };

  // ---------- pieces ----------
  function cellGlyph({ x = 0, y = 0, w = 120, h = 84, name = "", film = false, dim = false }) {
    const c = Math.min(w, h) * 0.13;
    const poly = `${x + c},${y} ${x + w - c},${y} ${x + w},${y + c} ${x + w},${y + h - c} ${x + w - c},${y + h} ${x + c},${y + h} ${x},${y + h - c} ${x},${y + c}`;
    let fingers = "";
    for (let fy = y + 6; fy < y + h - 3; fy += 6) fingers += `<line x1="${x + 3}" y1="${fy}" x2="${x + w - 3}" y2="${fy}" stroke="rgba(255,255,255,0.09)"/>`;
    const bus = [0.25, 0.5, 0.75].map((f) => `<line x1="${x + w * f}" y1="${y + 2}" x2="${x + w * f}" y2="${y + h - 2}" stroke="rgba(255,255,255,0.42)" stroke-width="1.5"/>`).join("");
    return `<g opacity="${dim ? 0.55 : 1}"><polygon points="${poly}" fill="var(--cell)"/>${fingers}${bus}${film ? `<polygon points="${poly}" fill="var(--film)"/>` : ""}${name ? `<text class="cell-name" x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle">${esc(name)}</text>` : ""}</g>`;
  }
  const cellSvg = (opts) => `<svg class="cell-svg" viewBox="0 0 120 84" role="img" aria-label="${esc(opts.label || "panel")}">${cellGlyph({ ...opts, x: 1, y: 1, w: 118, h: 82 })}</svg>`;
  const gradeWord = { A: "strong: within 10% of the best panel in its batch", B: "usable: 75–90% of the best panel", C: "weak: under 75% of the best panel" };
  const flagWord = { weak: "Weak output: under 75% of the strongest panel measured with it.", low_voc: "Open-circuit voltage well below the others: possibly a failed cell group.", dark: "Almost no current: no light, or disconnected." };
  const fmtDay = (iso) => { const d = new Date(typeof iso === "string" || typeof iso === "number" ? iso : NaN); return isNaN(d) ? esc(typeof iso === "string" ? iso : "unknown") : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); };
  const fmtDate = (iso) => { const d = new Date(typeof iso === "string" || typeof iso === "number" ? iso : NaN); return isNaN(d) ? esc(typeof iso === "string" ? iso : "unknown") : d.toLocaleString(); };
  function pairingLine(v) {
    if (!v || !v.pmax_w || typeof v.pmax_w !== "object") return "";
    const watts = Object.values(v.pmax_w).map(Number).filter(Number.isFinite);
    const best = Number(v.pmax_w[v.best_pairing]);
    if (!watts.length || !Number.isFinite(best) || best <= 0) return "";
    const worst = Math.min(...watts);
    const gain = worst > 0 ? `, ${((best / worst - 1) * 100).toFixed(0)}% more than the worst wiring` : "";
    return `Best in wiring <b class="pair-${esc(v.best_pairing)}">${esc(v.best_pairing)}</b> (panels ${PAIR_PANELS[v.best_pairing] || ""}): ${best.toFixed(2)} W at maximum power${gain}.`;
  }

  // ---------- pages ----------
  function pageIndex() {
    const ps = passports();
    const rows = ps.map((p) => `<tr>
      <td><a href="#/p/${encodeURIComponent(p.passport_id)}">${esc(p.passport_id)}</a></td>
      <td><span class="grade g-${esc(p.grade)}">${esc(p.grade)}</span></td>
      <td class="num">${num(p.isc_ma, 0)} mA</td>
      <td class="num">${num(p.voc_v, 2)} V</td>
      <td class="num">${num(p.score_pct, 0)}%</td>
      <td>${(p.flags || []).map((f) => esc(String(f).replace("_", " "))).join(", ") || "—"}</td>
      <td class="small muted">${fmtDate(p.measured_at)}</td>
    </tr>`).join("");
    return `
      <h1 class="page-title">Panel passports</h1>
      <p class="lede">Every tested panel gets an ID and a QR code. The passport records its current and voltage, how it compares with the panels next to it, and which wiring its batch did best in. <a href="#/scale">Scale</a> shows the same rule on a pallet, where the hardware cannot try every wiring.</p>
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:baseline"><h2>Tested panels</h2>${ps.length ? `<a class="small no-print" href="#/print">Print cards for all ${ps.length}</a>` : ""}</div>
        ${ps.length ? `<table class="table"><thead><tr><th>Passport</th><th>Grade</th><th class="num">Short-circuit</th><th class="num">Open-circuit</th><th class="num">Score</th><th>Flags</th><th>Measured</th></tr></thead><tbody>${rows}</tbody></table>`
                    : emptyNote(`<p class="muted">No passports yet. Import a run from the bench dashboard, or load the sample run.</p>`)}
      </div>
      <div class="card no-print">
        <h2>Import a run</h2>
        <p class="muted small">On the bench dashboard, open Data and press “Export passports (JSON)”. Drop that file here, or paste its contents.</p>
        <div class="row" style="margin-top:10px">
          <label class="btn">Choose run file <input type="file" id="run-file" accept="application/json,.json" hidden></label>
          <button type="button" class="btn" id="btn-sample">Load the sample run</button>
          <button type="button" class="btn btn--quiet" id="btn-paste">Paste JSON</button>
          ${runs.length ? `<button type="button" class="btn btn--quiet" id="btn-clear">Remove all ${runs.length} run${runs.length === 1 ? "" : "s"}</button>` : ""}
          <span class="status" id="import-status"></span>
        </div>
        <div id="paste-box" hidden style="margin-top:10px"><label class="field">Run JSON <textarea id="paste-text"></textarea></label><div class="row" style="margin-top:8px"><button type="button" class="btn btn--primary" id="btn-paste-go">Import</button></div></div>
      </div>
      ${runs.length ? `<div class="card"><h2>Runs</h2><table class="table"><thead><tr><th>Run</th><th>Bench</th><th>Best wiring</th><th>Measured gain</th><th>Panels</th></tr></thead><tbody>
        ${runs.map((r) => `<tr><td>${esc(r.run_id)}</td><td class="small muted">${esc(r.bench || "")}</td><td>${r.search ? `<b class="pair-${esc(r.search.best)}">${esc(r.search.best)}</b>` : "—"}</td><td>${r.proof ? `+${num(r.proof.gain_pct, 1)}% ± ${num(r.proof.ci95_pct, 1)} (${r.proof.cycle} cycles)` : r.search ? "search only" : "—"}</td><td>${(r.passports || []).map((p) => `<a href="#/p/${encodeURIComponent(p.passport_id)}">${esc(p.passport_id)}</a>`).join(", ")}</td></tr>`).join("")}
      </tbody></table></div>` : ""}`;
  }

  function wireIndex() {
    const status = $("#import-status");
    const ok = (run) => { addRun(run); render(); };
    const bad = (err) => { status.classList.add("is-bad"); status.textContent = `Could not import: ${err.message || err}`; };
    const importText = (text) => { try { ok(JSON.parse(text)); } catch (err) { bad(err); } };
    $("#run-file").addEventListener("change", (e) => { const f = e.target.files[0]; if (!f) return; f.text().then(importText, bad); });
    $("#btn-sample").addEventListener("click", () => {
      status.classList.remove("is-bad"); status.textContent = "Loading…";
      fetch("data/sample-run.json").then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); }).then(ok).catch((err) => bad(new Error(`${err.message}. The sample loads over http, not from a file:// page.`)));
    });
    $("#btn-paste").addEventListener("click", () => { $("#paste-box").hidden = !$("#paste-box").hidden; });
    $("#btn-paste-go").addEventListener("click", () => importText($("#paste-text").value));
    const clear = $("#btn-clear");
    if (clear) clear.addEventListener("click", () => { if (confirm("Remove every imported run from this browser?")) { runs = []; saveRuns(); render(); } });
    document.body.addEventListener("dragover", (e) => { e.preventDefault(); });
    document.body.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) f.text().then(importText, bad); }, { once: true });
  }

  function pagePassport(id) {
    const p = passport(id);
    if (!p) return `<h1 class="page-title">${esc(id)}</h1>${emptyNote(`<p class="lede">No passport with this ID has been imported into this browser. <a href="#/">Back to the list.</a></p>`)}`;
    const url = location.href;
    const qr = window.qrcode(0, "M"); qr.addData(url); qr.make();
    const flags = (p.flags || []).map((f) => `<li>${esc(flagWord[f] || f)}</li>`).join("");
    return `
      <div class="row no-print" style="justify-content:space-between;margin-bottom:14px"><a href="#/">← All passports</a><button type="button" class="btn btn--quiet" onclick="window.print()">Print</button></div>
      <div class="card passport">
        <div class="passport__visual">
          ${cellSvg({ label: p.passport_id, dim: p.grade === "C" })}
          <div class="passport__qr" aria-label="QR code for this passport">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
          <p class="small muted">Scan to open this passport.</p>
        </div>
        <div>
          <div class="passport__id">${esc(p.passport_id)}</div>
          <div class="passport__grade-line"><span class="passport__grade grade g-${esc(p.grade)}">${esc(p.grade)}</span><span class="muted">${esc(gradeWord[p.grade] || "")}</span></div>
          <dl class="facts">
            <div><dt>Short-circuit current</dt><dd>${num(p.isc_ma, 1)} mA</dd></div>
            <div><dt>Open-circuit voltage</dt><dd>${num(p.voc_v, 2)} V</dd></div>
            <div><dt>Relative current score</dt><dd>${num(p.score_pct, 0)}% <span class="small muted">of the strongest panel in its batch (${num(p.reference && p.reference.strongest_isc_ma, 0)} mA)</span></dd></div>
            <div><dt>Raw reading, box factor</dt><dd class="small">${num(p.isc_raw_ma, 1)} mA × ${num(p.reference && p.reference.box_factor, 2)}</dd></div>
            <div><dt>Light during the test</dt><dd class="small">${esc(p.reference && p.reference.light || "not recorded")}</dd></div>
            <div><dt>Measured</dt><dd class="small">${fmtDate(p.measured_at)}, run ${esc(p.run_id)}, position ${esc(p.panel_label)}</dd></div>
          </dl>
          ${flags ? `<ul class="flags">${flags}</ul>` : ""}
          ${p.verified ? `<p style="margin-top:16px">${pairingLine(p.verified)}</p>` : ""}
          <p class="small muted" style="margin-top:14px">A relative score compares panels of the same model measured under the same light at the same instant, which removes light level from the comparison. Rated values from a label: ${p.rated && p.rated.isc_ma ? `${p.rated.isc_ma} mA, ${p.rated.voc_v} V` : "not recorded"}.</p>
        </div>
      </div>`;
  }

  // #/print: one card per passport, four to a sheet (two columns, two rows); each sheet is one printed page.
  // The QR encodes the passport page's own URL, built the way pagePassport sees it (location.href on that page).
  function pagePrint() {
    const ps = passports();
    const base = location.origin + location.pathname;
    const card = (p) => {
      const url = `${base}#/p/${encodeURIComponent(p.passport_id)}`;
      const qr = window.qrcode(0, "M"); qr.addData(url); qr.make();
      return `<article class="pcard">
        <div class="pcard__top">
          ${cellSvg({ label: p.passport_id, dim: p.grade === "C" })}
          <div class="pcard__id">${esc(p.passport_id)}</div>
          <span class="pcard__grade grade g-${esc(p.grade)}">${esc(p.grade)}</span>
        </div>
        <div class="pcard__body">
          <div class="pcard__qr" aria-label="QR code for passport ${esc(p.passport_id)}">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
          <dl class="pcard__facts">
            <div><dt>Short-circuit current</dt><dd>${num(p.isc_ma, 1)} mA</dd></div>
            <div><dt>Open-circuit voltage</dt><dd>${num(p.voc_v, 2)} V</dd></div>
            <div><dt>Relative score</dt><dd>${num(p.score_pct, 0)}%</dd></div>
            <div><dt>Measured</dt><dd class="small">${fmtDay(p.measured_at)}</dd></div>
          </dl>
        </div>
        <p class="pcard__foot small muted">Second String passport, scan for the full record.<br><span class="pcard__url">${esc(url)}</span></p>
      </article>`;
    };
    const sheets = [];
    for (let i = 0; i < ps.length; i += 4) sheets.push(`<section class="sheet" aria-label="Sheet ${sheets.length + 1}">${ps.slice(i, i + 4).map(card).join("")}</section>`);
    return `
      <div class="row no-print" style="justify-content:space-between;margin-bottom:14px"><a href="#/">← All passports</a>${sheets.length ? `<button type="button" class="btn btn--primary" onclick="window.print()">Print</button>` : ""}</div>
      <h1 class="page-title no-print">Passport cards</h1>
      <p class="lede no-print">One card per tested panel, four to a sheet${sheets.length ? ` (${ps.length} card${ps.length === 1 ? "" : "s"}, ${sheets.length} sheet${sheets.length === 1 ? "" : "s"})` : ""}. Print, cut along the borders and put each card next to its panel; the QR code opens that panel's passport.</p>
      ${sheets.length ? sheets.join("") : `<div class="card">${emptyNote(`<p class="muted">No passports yet. <a href="#/">Import a run first.</a></p>`)}</div>`}`;
  }

  function pageBuild() {
    const ps = passports();
    const sel = new Set(LS.get("ss.site.pool", ps.map((p) => p.passport_id)));
    const items = ps.map((p) => `<label class="${sel.has(p.passport_id) ? "is-on" : ""}"><input type="checkbox" data-pool="${esc(p.passport_id)}" ${sel.has(p.passport_id) ? "checked" : ""}> <b>${esc(p.passport_id)}</b> <span class="muted small">${num(p.isc_ma, 0)} mA, ${num(p.voc_v, 2)} V, ${esc(p.grade)}</span></label>`).join("");
    return `
      <h1 class="page-title">Array Builder</h1>
      <p class="lede">Pick a pool of passports. The builder puts panels with similar current in the same series string, so no strong panel is throttled by a weak one, and estimates the power against wiring them in the order they came.</p>
      <div class="card no-print">
        <h2>Pool</h2>
        ${ps.length ? `<div class="pool" id="pool">${items}</div>` : emptyNote(`<p class="muted">No passports yet. <a href="#/">Import a run first.</a></p>`)}
        <div class="row" style="margin-top:14px">
          <label class="field">Panels per string <select id="k"><option value="2">2 (12 V from 6 V panels)</option><option value="3">3</option><option value="4">4</option></select></label>
          <label class="field">Add a panel by hand <span class="row"><input id="add-isc" type="number" placeholder="mA" style="width:90px"><input id="add-voc" type="number" step="0.01" placeholder="V" style="width:80px"><button type="button" class="btn" id="btn-add">Add</button></span></label>
          <button type="button" class="btn btn--primary" id="btn-group">Group them</button>
        </div>
      </div>
      <div id="build-result"></div>`;
  }

  const extraPanels = [];
  function wireBuild() {
    const pool = $("#pool");
    if (pool) pool.addEventListener("change", () => {
      const ids = [...pool.querySelectorAll("[data-pool]:checked")].map((c) => c.dataset.pool);
      LS.set("ss.site.pool", ids);
      pool.querySelectorAll("label").forEach((l) => l.classList.toggle("is-on", l.querySelector("input").checked));
    });
    $("#btn-add").addEventListener("click", () => {
      const isc = Number($("#add-isc").value), voc = Number($("#add-voc").value);
      if (!(isc > 0 && voc > 0)) return;
      extraPanels.push({ id: `hand-${extraPanels.length + 1}`, isc_ma: isc, voc_v: voc });
      $("#add-isc").value = ""; $("#add-voc").value = "";
      runBuild();
    });
    $("#btn-group").addEventListener("click", runBuild);
    const ids = LS.get("ss.site.pool", null);
    if (ids && ids.length) runBuild();
  }

  function groupsHtml(groups, byId) {
    return `<div class="groups">${groups.map((g, i) => `<div class="group"><span class="muted small">String ${i + 1}</span><span class="group__string">${g.map((p) => `<span class="chip ${byId[p.id] && byId[p.id].grade === "C" ? "is-weak" : ""}">${esc(p.id)}</span>`).join("<span class='muted'>+</span>")}</span><span class="muted small">limited to ${Math.min(...g.map((p) => p.isc_ma)).toFixed(0)} mA</span></div>`).join("")}</div>`;
  }

  function runBuild() {
    const out = $("#build-result");
    const ps = passports();
    const byId = Object.fromEntries(ps.map((p) => [p.passport_id, p]));
    const chosen = [...document.querySelectorAll("[data-pool]:checked")].map((c) => byId[c.dataset.pool]).filter(Boolean).map((p) => ({ id: p.passport_id, isc_ma: Number(p.isc_ma), voc_v: Number(p.voc_v) }));
    const panels = [...chosen, ...extraPanels];
    const k = Number($("#k").value);
    const res = window.SSBuilder.analyze(panels, k);
    if (res.error) { out.innerHTML = `<div class="card"><p class="status is-bad">${esc(res.error)}</p></div>`; return; }
    const naiveGain = (res.greedy.pmax / res.naive.pmax - 1) * 100;
    const avg = res.brute ? res.brute.average : res.sampledAverage;
    const avgGain = (res.greedy.pmax / avg - 1) * 100;
    let verdict = "";
    if (res.brute) {
      verdict = res.brute.greedyIsBest
        ? `<div class="verdict is-good">Checked against all ${res.brute.count} possible groupings: the matched grouping is the best one. Worst grouping: ${res.brute.worst.pmax.toFixed(2)} W.</div>`
        : `<div class="verdict is-bad">Checked against all ${res.brute.count} groupings: a better grouping exists, ${res.brute.best.pmax.toFixed(2)} W. Sorting by current is a heuristic; the bench verifies by measuring.</div>`;
    } else {
      verdict = `<div class="verdict">${res.totalGroupings.toLocaleString()} possible groupings, too many to enumerate here; the average comes from 200 random groupings.</div>`;
    }
    // bench comparison: the pool is exactly one run's four passports
    let bench = "";
    const run = runs.find((r) => r.search && r.passports && r.passports.length === 4 && panels.length === 4 && r.passports.every((p) => panels.some((q) => q.id === p.passport_id)));
    if (run && k === 2) {
      const pos = Object.fromEntries(run.passports.map((p) => [p.passport_id, Number(String(p.panel_label || "").replace("P", ""))]));
      const keyOf = (groups) => groups.map((g) => g.map((p) => pos[p.id]).sort().join("+")).sort().join(", ");
      const letter = Object.keys(PAIR_PANELS).find((L) => PAIR_PANELS[L] === keyOf(res.greedy.groups));
      const agree = letter === run.search.best;
      bench = `<div class="verdict ${agree ? "is-good" : "is-bad"}">Bench check: these four panels were measured on the bench in run ${esc(run.run_id)}. The builder's grouping is wiring <b class="pair-${esc(letter)}">${esc(letter)}</b>; the bench measured wiring <b class="pair-${esc(run.search.best)}">${esc(run.search.best)}</b> as best (${Object.entries(run.search.pmax_w || {}).map(([L, w]) => `${L} ${num(w, 2)} W`).join(", ")}). ${agree ? "They agree." : "They disagree: trust the measurement."}</div>`;
    }
    out.innerHTML = `<div class="card">
      <h2>Result</h2>
      <div class="result-head">
        <div class="stat is-hero"><b>${res.greedy.pmax.toFixed(2)} W</b><span>matched grouping, estimated maximum power</span></div>
        <div class="stat"><b>+${naiveGain.toFixed(1)}%</b><span>against wiring in the order they came (${res.naive.pmax.toFixed(2)} W)</span></div>
        <div class="stat"><b>+${avgGain.toFixed(1)}%</b><span>against the average grouping (${avg.toFixed(2)} W), what wiring without measuring gets</span></div>
      </div>
      <h3 class="small muted" style="margin-bottom:8px">Matched grouping</h3>
      ${groupsHtml(res.greedy.groups, byId)}
      <h3 class="small muted" style="margin:14px 0 8px">As they came</h3>
      ${groupsHtml(res.naive.groups, byId)}
      ${verdict}${bench}
      <p class="small muted" style="margin-top:12px">Estimates use the same single-diode panel model as the bench, fitted to each passport's short-circuit current and open-circuit voltage, with a bypass diode per panel. Each string carries the current of its weakest panel; strings share one voltage.</p>
    </div>`;
  }

  function simulatedRun(run) {
    const text = `${run.link || ""} ${run.bench || ""} ${run.source || ""}`;
    return /sample|mock|single-diode|simulat/i.test(text);
  }

  function pageScale() {
    const rows = window.SSScale.scenarios();
    const cards = rows.map((row) => `
      <div class="card">
        <h2>${esc(row.title)}</h2>
        <p>${esc(row.note)}</p>
        <div class="result-head" style="margin-top:14px">
          <div class="stat is-hero"><b>${row.matched.toFixed(2)} W</b><span>matched by current</span></div>
          <div class="stat"><b>${row.arrived.toFixed(2)} W</b><span>wired in the order they arrived</span></div>
          <div class="stat"><b>+${row.gainVsArrived.toFixed(1)}%</b><span>more power from the same panels</span></div>
        </div>
        <p>If all ${row.n} panels were clear panels, this array would make <b>${row.healthy.toFixed(2)} W</b>. Matching the panels we actually have reaches <b>${row.shareOfHealthy.toFixed(0)}%</b> of that. The missing power left with the degraded panels. Matching does not give it back. Matching stops a weak panel from forcing a strong one down to its current.</p>
        <p class="small muted" style="margin-top:8px">${row.measurements} measurements, one per panel. ${row.wires} ways to pair them into series strings of ${row.k}. ${row.checkedAll ? `This batch is small enough to check all ${row.checkedCount} groupings: sorting by current is the best one.` : "Too many groupings to try on hardware, or even to list here. The product measures each panel once and sorts."}</p>
      </div>`).join("");
    return `
      <h1 class="page-title">Scale</h1>
      <p class="lede">The product is a current and voltage reading on each panel, then a wiring list. A degraded panel still produces less. Put it in a string with another degraded panel, and the healthy panels keep their own current. The watts below are the single-diode model, the same one the Array Builder uses.</p>
      ${cards}
      <div class="card">
        <h2>What scales, and what does not</h2>
        <p>A relay box that rewires four panels is a check on the rule. It does not become the warehouse tool. The warehouse clips each module once, prints the passport, and sorts the pallet in software. The number of wirings grows faster than any bench. The number of measurements grows one per panel.</p>
        <p class="small muted" style="margin-top:8px">Buyers are decommissioning crews and resellers who currently ship ungraded pallets, and installers who build strings from those pallets. The check they write is for the grade, not for a relay per module.</p>
      </div>`;
  }

  function pageImpact() {
    const proofRuns = runs.filter((r) => r.proof && r.proof.kind === "sweep");
    const benchRuns = proofRuns.filter((r) => !simulatedRun(r));
    const simRuns = proofRuns.filter((r) => simulatedRun(r));
    const meanOf = (list) => list.reduce((a, r) => a + Number(r.proof.gain_pct), 0) / list.length;
    const benchMean = benchRuns.length ? meanOf(benchRuns) : null;
    const simMean = simRuns.length ? meanOf(simRuns) : null;
    return `
      <h1 class="page-title">Impact</h1>
      <p class="lede">A figure is labeled with where it came from: the bench, the panel model, or a named source. <a href="#/scale">Scale</a> is the model on a pallet.</p>
      <div class="card">
        <h2>Power recovered by matching</h2>
        <p>${benchMean != null ? `Across ${benchRuns.length} bench proof run${benchRuns.length === 1 ? "" : "s"}, matching panels by current gave <b>${benchMean.toFixed(1)}% more power</b> than the comparison wiring, at each wiring's maximum power point.` : "No bench proof is loaded. A bench run is one whose file does not describe itself as a sample or a model."}</p>
        <p style="margin-top:8px">${simMean != null ? `The loaded model run reports <b>${simMean.toFixed(1)}% more power</b> than its comparison wiring. That run is labeled as model output in its bench field.` : "No model proof is loaded."}</p>
        <p class="small muted" style="margin-top:8px">Two panels at 35% current is a staged batch, so the gain looks large. Two panels at 80% is the ordinary used-module case, and the gain is much smaller. Both are on the Scale page. Neither number is nameplate power restored.</p>
      </div>
      <div class="card">
        <h2>Why reuse matters (sources)</h2>
        <ul class="small" style="padding-left:1.2em;display:grid;gap:6px">
          <li>Panels lose about 0.5–0.75% of output a year (NREL fleet study, median 0.75%/yr; literature median 0.5%/yr). After 25 years most still make 80–88% of their rating.</li>
          <li>Panels retired early, for upgrades or damage, often still produce 70–95% of their rating (NREL).</li>
          <li>NREL's baseline for US modules 2020–2050: about 83% landfilled, 9.5% recycled, 1.2% reused.</li>
          <li>Testing a used panel in a lab (flash test plus electroluminescence) costs about €16–31 per module, against about €50 for a new module (IEA PVPS Task 13, 2026; German test labs' price lists).</li>
        </ul>
      </div>
      <div class="card">
        <h2>What we do not claim</h2>
        <p class="small muted">No carbon figure. A diverted-panel count needs a stated pass rate and a stated displacement, and we do not have those measurements. The sourced facts above are the reuse case. The Scale page is the engineering case.</p>
      </div>`;
  }

  // ---------- router ----------
  function render() {
    const hash = location.hash || "#/";
    const view = $("#view");
    loadingShown = false;
    let route = "index";
    try {
      if (hash.startsWith("#/p/")) { view.innerHTML = pagePassport(safeDecode(hash.slice(4))); route = "index"; }
      else if (hash.startsWith("#/build")) { view.innerHTML = pageBuild(); wireBuild(); route = "build"; }
      else if (hash.startsWith("#/scale")) { view.innerHTML = pageScale(); route = "scale"; }
      else if (hash.startsWith("#/impact")) { view.innerHTML = pageImpact(); route = "impact"; }
      else if (hash.startsWith("#/print")) { view.innerHTML = pagePrint(); route = "index"; }
      else { view.innerHTML = pageIndex(); wireIndex(); }
    } catch (err) {
      // never leave a blank page on a judge's phone: say what happened and offer the one fix that always works
      console.error(err);
      view.innerHTML = `<div class="card"><h2>This page could not be drawn</h2><p class="status is-bad">${esc(err && err.message || err)}</p>
        <p class="small muted" style="margin-top:8px">Usually an imported run is malformed. Removing the runs imported into this browser fixes it; nothing on the bench or the server changes.</p>
        <div class="row" style="margin-top:10px"><button type="button" class="btn" id="btn-reset">Remove imported runs and reload</button></div></div>`;
      $("#btn-reset").addEventListener("click", () => { LS.del("ss.site.runs"); LS.del("ss.site.pool"); location.reload(); });
    }
    document.querySelectorAll("[data-route]").forEach((a) => a.classList.toggle("is-on", a.dataset.route === route));
    window.scrollTo(0, 0);
  }
  // When tools/serve.py is serving this site, runs uploaded by the dashboard appear on their own.
  // On a static host (GitHub Pages) there is no API: the site loads the runs committed to data/runs/,
  // listed in data/runs/index.json (regenerate it with python3 tools/sim/make_runs_index.py).
  let apiTimer = null;
  const fetchJson = (url) => fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url}: ${r.status}`))));
  function mergeRuns(list) {
    const before = JSON.stringify(runs.map((r) => r.run_id).sort());
    list.forEach((run) => { try { addRun(run); } catch (_) { /* skip malformed */ } });
    return JSON.stringify(runs.map((r) => r.run_id).sort()) !== before;
  }
  // the first pull is over, whatever it found: drop the "Loading…" notes and show what there is
  function settle(changed) {
    const wasLoading = loading && loadingShown;
    loading = false;
    if (changed || wasLoading) render();
  }
  function pullFromServer(first) {
    fetchJson("../api/runs")
      .then((list) => {
        const changed = Array.isArray(list) && mergeRuns(list);
        if (first) { settle(changed); apiTimer = setInterval(() => pullFromServer(false), 5000); }
        else if (changed) render();
      })
      .catch(() => { if (first) pullFromIndex(); });
  }
  function pullFromIndex() {
    fetchJson("data/runs/index.json")
      .then((index) => {
        const listed = Array.isArray(index) ? index : (index && Array.isArray(index.runs) ? index.runs : []);
        // plain file names only: no paths, nothing but the run files the index script lists
        const files = listed.filter((f) => typeof f === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(f) && f !== "index.json");
        return Promise.all(files.map((f) => fetchJson(`data/runs/${encodeURIComponent(String(f))}`).catch(() => null)));
      })
      .then((list) => settle(mergeRuns(list.filter(Boolean))))
      .catch(() => settle(false)); // neither the API nor an index: import by hand
  }

  window.addEventListener("hashchange", render);
  render();
  pullFromServer(true);
  window.secondStringSite = { addRun, passports, runs: () => runs };
})();
