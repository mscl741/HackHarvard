// Pallet-scale wiring estimates. Same single-diode model as the Array Builder.
// A weak panel still makes less power. Matching stops it from also limiting a strong one.
window.SSScale = (function () {
  const B = window.SSBuilder;

  function groupings(n, k) {
    if (n % k !== 0) return null;
    const fact = (x) => {
      let r = 1n;
      for (let i = 2n; i <= BigInt(x); i++) r *= i;
      return r;
    };
    return fact(n) / (fact(k) ** BigInt(n / k) * fact(n / k));
  }

  function commas(bi) {
    return bi.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function summarize(spec) {
    const res = B.analyze(spec.panels, spec.k, 8);
    const healthy = B.analyze(
      spec.panels.map((p) => ({ id: p.id, isc_ma: spec.nameplateIsc, voc_v: spec.nameplateVoc })),
      spec.k,
      0
    );
    const wires = groupings(spec.panels.length, spec.k);
    return {
      id: spec.id,
      title: spec.title,
      note: spec.note,
      n: spec.panels.length,
      k: spec.k,
      matched: res.greedy.pmax,
      arrived: res.naive.pmax,
      gainVsArrived: (res.greedy.pmax / res.naive.pmax - 1) * 100,
      healthy: healthy.greedy.pmax,
      shareOfHealthy: (res.greedy.pmax / healthy.greedy.pmax) * 100,
      wires: wires == null ? "—" : commas(wires),
      measurements: spec.panels.length,
      checkedAll: !!(res.brute && res.brute.greedyIsBest),
      checkedCount: res.brute ? res.brute.count : null,
      strings: res.greedy.groups.map((g) => g.map((p) => p.id)),
    };
  }

  // Fixed batches so a refresh shows the same watts.
  // The four-panel film batch is the published sample run's measured currents and voltages.
  const CLEAR = 149.7;
  const VOC = 6.82;

  function at(id, share) {
    return { id, isc_ma: Math.round(CLEAR * share * 10) / 10, voc_v: Math.round((VOC - (1 - share) * 0.7) * 100) / 100 };
  }

  function scenarios() {
    const film = [
      { id: "P1", isc_ma: 149.7, voc_v: 6.82 },
      { id: "P2", isc_ma: 52.7, voc_v: 6.39 },
      { id: "P3", isc_ma: 149.7, voc_v: 6.82 },
      { id: "P4", isc_ma: 52.4, voc_v: 6.39 },
    ];
    const aged = ["P1", "P2", "P3", "P4"].map((id, i) => at(id, [1, 0.8, 1, 0.8][i]));
    // a mixed pallet: mostly lightly aged, a few badly degraded, in the order a crew would unstack them
    const shares = [1, 0.62, 0.91, 0.55, 0.88, 0.97, 0.7, 0.48, 0.93, 0.81, 0.66, 1, 0.58, 0.86, 0.74, 0.95, 0.52, 0.9, 0.77, 0.64, 0.98, 0.71, 0.84, 0.6];
    const pallet = shares.map((share, i) => at(`M${String(i + 1).padStart(2, "0")}`, share));
    return [
      summarize({
        id: "film",
        title: "Four panels, two badly degraded",
        note: "Same currents and voltages as the sample passports: P2 and P4 are the weak pair, and the arrival order wires each of them to a strong panel. This is a staged batch, not a typical old array.",
        panels: film,
        k: 2,
        nameplateIsc: CLEAR,
        nameplateVoc: VOC,
      }),
      summarize({
        id: "aged",
        title: "Four panels, realistic aging",
        note: "Two panels at 80% of the clear-panel current. This is the gain to quote for ordinary used modules.",
        panels: aged,
        k: 2,
        nameplateIsc: CLEAR,
        nameplateVoc: VOC,
      }),
      summarize({
        id: "pallet",
        title: "A pallet of 24 mixed modules",
        note: "Currents run from about half to full, in the order they were unstacked. Every string is still two panels in series.",
        panels: pallet,
        k: 2,
        nameplateIsc: CLEAR,
        nameplateVoc: VOC,
      }),
    ];
  }

  return { scenarios, groupings };
})();
