"use strict";

const API_URL = window.CHALK_API_URL || "http://127.0.0.1:8766/advisor";
let selectedPanels = [];
let dataSource = "SIMULATED";

const el = (id) => document.getElementById(id);

function showError(message) {
  el("request-status").textContent = message;
}

function loadRun(run, source) {
  if (!run || !Array.isArray(run.passports)) {
    throw new Error("Invalid run JSON: passports missing.");
  }

  if (run.passports.length !== 4) {
    throw new Error("This advisor needs exactly four panels.");
  }

  const ids = ["A", "B", "C", "D"];

  selectedPanels = run.passports.map((p, index) => {
    const isc = Number(p.isc_ma);
    const voc = Number(p.voc_v);

    if (!(isc > 0) || !(voc > 0) ||
        !Number.isFinite(isc) || !Number.isFinite(voc)) {
      throw new Error("Invalid panel current or voltage.");
    }

    return {
      id: ids[index],
      passport_id: p.passport_id,
      isc_a: isc / 1000,
      voc_v: voc
    };
  });

  dataSource = source;

  el("data-status").textContent =
    `${selectedPanels.length} panels loaded (${source}).`;

  const table = document.createElement("table");
  table.className = "table";

  const heading = document.createElement("tr");
  for (const label of ["Panel", "Passport", "Isc (mA)", "Voc (V)"]) {
    const th = document.createElement("th");
    th.textContent = label;
    heading.appendChild(th);
  }
  table.appendChild(heading);

  for (const panel of selectedPanels) {
    const row = document.createElement("tr");
    for (const value of [
      panel.id,
      panel.passport_id,
      (panel.isc_a * 1000).toFixed(1),
      panel.voc_v.toFixed(2)
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      row.appendChild(td);
    }
    table.appendChild(row);
  }

  el("panel-list").replaceChildren(table);
  el("answer-card").hidden = true;
}


// Load the selection saved by Array Builder.
function loadBuilderSelection() {
  const raw = localStorage.getItem("ss.chalk.builderSelection");
  if (!raw) {
    el("data-status").textContent =
      "No saved Array Builder selection found.";
    return;
  }

  const saved = JSON.parse(raw);

  if (!Array.isArray(saved.panels) || saved.panels.length !== 4 ||
      !Array.isArray(saved.groups)) {
    throw new Error("Invalid saved Array Builder selection.");
  }

  const run = {
    passports: saved.panels.map(p => ({
      passport_id: String(p.id),
      isc_ma: p.isc_ma,
      voc_v: p.voc_v
    }))
  };

  loadRun(run, "UNSPECIFIED");

  const grouping = saved.groups
    .map(group => group.join(" + "))
    .join(" | ");

  el("question").value =
    "The Array Builder recommends " + grouping +
    ". Explain this model-based configuration, its limitations, " +
    "and what measurements are needed to validate it.";

  el("data-status").textContent =
    "Loaded from Array Builder: " + grouping +
    ". Recommendation is model-based, not hardware verified.";
}

if (new URLSearchParams(location.search).get("from") === "builder") {
  try {
    loadBuilderSelection();
  } catch (error) {
    el("data-status").textContent =
      "Could not load Array Builder data: " + error.message;
  }
}

el("load-sample").addEventListener("click", async () => {
  try {
    const response = await fetch("data/sample-run.json");
    if (!response.ok) throw new Error("Cannot load sample run.");
    loadRun(await response.json(), "SIMULATED");
    showError("");
  } catch (err) {
    showError(err.message);
  }
});

el("run-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const run = JSON.parse(await file.text());
    // Imported data is not automatically hardware verified.
    loadRun(run, "UNSPECIFIED");
    showError("");
  } catch (err) {
    showError(err.message);
  }
});

el("ask").addEventListener("click", async () => {
  if (selectedPanels.length !== 4) {
    showError("Load a four-panel run first.");
    return;
  }

  const button = el("ask");
  button.disabled = true;
  showError("Analyzing panels...");

  try {
    const payload = {
      question: el("question").value,
      mode: el("mode").value,
      data_source: dataSource,
      panels: selectedPanels.map(({id, isc_a, voc_v}) => ({
        id, isc_a, voc_v
      }))
    };

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || `API error ${response.status}`);
    }

    el("pairing").textContent =
      `Preliminary current-matching pairing: ${result.recommended_pairing}`;

    el("answer").textContent = result.response
      .replace(/\*\*/g, "")
      .replace(/^\s*-\s+/gm, "• ");

    el("source").textContent =
      `Mode: ${result.processing_mode} | ` +
      `AI enabled: ${result.ai_enabled} | ` +
      `Data: ${result.data_source} | ` +
      `Hardware verified: ${result.hardware_verified}`;

    const warnings = (result.warnings || []).map((warning) => {
      const li = document.createElement("li");
      li.textContent = warning;
      return li;
    });

    el("warnings").replaceChildren(...warnings);
    el("answer-card").hidden = false;
    showError("Analysis complete.");

  } catch (err) {
    showError(
      `Could not reach the Advisor: ${err.message}. ` +
      "Check that the API server is running."
    );
  } finally {
    button.disabled = false;
  }
});
