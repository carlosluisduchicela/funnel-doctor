"use strict";

/* funnel-doctor — same logic as funnel.py, running entirely in the browser. */

var SAMPLE_PLAIN = [
  "step,users",
  "Visit,12000",
  "Signup,5400",
  "Activated,2700",
  "Trial Started,1890",
  "Paid,567"
].join("\n");

var SAMPLE_SEGMENTS = [
  "step,segment,users",
  "Visit,free,8000",
  "Visit,pro,2000",
  "Signup,free,3200",
  "Signup,pro,1400",
  "Activated,free,1600",
  "Activated,pro,1120",
  "Trial Started,free,800",
  "Trial Started,pro,840",
  "Paid,free,240",
  "Paid,pro,504"
].join("\n");

/* ------------------------------------------------------------ parsing */

function splitCsvLine(line) {
  var out = [], cur = "", inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else { cur += ch; }
    } else if (ch === '"') { inQuotes = true; }
    else if (ch === ",") { out.push(cur); cur = ""; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  var lines = text.split(/\r?\n/).filter(function (ln) { return ln.trim() !== ""; });
  if (!lines.length) throw new Error("empty CSV");
  var header = splitCsvLine(lines[0]).map(function (h) { return h.trim().toLowerCase(); });
  if (header[0] !== "step") throw new Error("first column must be 'step'");
  var hasSegment = header.length >= 3 && header[1] === "segment";
  if (!hasSegment && !(header.length >= 2 && header[1] === "users")) {
    throw new Error("expected columns 'step,users' or 'step,segment,users'");
  }
  var steps = [];
  var series = {};       // segment -> array of counts aligned with steps
  var order = [];
  for (var r = 1; r < lines.length; r++) {
    var row = splitCsvLine(lines[r]);
    if (row.length < (hasSegment ? 3 : 2)) throw new Error("line " + (r + 1) + ": not enough columns");
    var step = row[0].trim();
    if (!step) throw new Error("line " + (r + 1) + ": empty step name");
    var segment = hasSegment ? row[1].trim() : "all";
    var raw = (hasSegment ? row[2] : row[1]).trim().replace(/,/g, "");
    var users = Number(raw);
    if (!isFinite(users) || raw === "") throw new Error("line " + (r + 1) + ": users value is not a number");
    if (users < 0) throw new Error("line " + (r + 1) + ": users must be >= 0");
    var idx = steps.indexOf(step);
    if (idx === -1) { steps.push(step); idx = steps.length - 1; }
    if (!(segment in series)) { series[segment] = []; order.push(segment); }
    series[segment][idx] = users;
  }
  order.forEach(function (seg) {
    for (var i = 0; i < steps.length; i++) {
      if (typeof series[seg][i] !== "number") {
        throw new Error("segment '" + seg + "' is missing a count for some step");
      }
    }
  });
  if (steps.length < 2) throw new Error("a funnel needs at least 2 steps");
  return { steps: steps, series: series, order: order, segmented: hasSegment };
}

/* ------------------------------------------------------------ math */

function stepStats(counts) {
  return counts.map(function (users, i) {
    if (i === 0) return { users: users, stepConv: 1, cumulative: 1, lost: 0 };
    var prev = counts[i - 1];
    return {
      users: users,
      stepConv: prev ? users / prev : 0,
      cumulative: counts[0] ? users / counts[0] : 0,
      lost: prev - users
    };
  });
}

function biggestDrop(steps, counts) {
  var stats = stepStats(counts);
  var best = 1;
  for (var i = 2; i < counts.length; i++) {
    if (stats[i].stepConv < stats[best].stepConv ||
        (stats[i].stepConv === stats[best].stepConv && stats[i].lost > stats[best].lost)) {
      best = i;
    }
  }
  return best; // index into steps
}

/* Abramowitz & Stegun erf approximation (|error| <= 1.5e-7). */
function erf(x) {
  var sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  var t = 1 / (1 + 0.3275911 * x);
  var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

function twoProportionZTest(x1, n1, x2, n2) {
  if (n1 <= 0 || n2 <= 0) return { z: 0, p: 1 };
  var pooled = (x1 + x2) / (n1 + n2);
  var se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  var z = (x1 / n1 - x2 / n2) / se;
  var p = 2 * (1 - normCdf(Math.abs(z)));
  return { z: z, p: Math.min(1, Math.max(0, p)) };
}

function segmentComparisons(parsed) {
  var out = [];
  var names = parsed.order;
  if (names.length < 2) return out;
  for (var i = 1; i < parsed.steps.length; i++) {
    for (var a = 0; a < names.length; a++) {
      for (var b = a + 1; b < names.length; b++) {
        var sa = parsed.series[names[a]], sb = parsed.series[names[b]];
        var res = twoProportionZTest(sa[i], sa[i - 1], sb[i], sb[i - 1]);
        out.push({
          step: parsed.steps[i], index: i,
          segA: names[a], segB: names[b],
          convA: sa[i - 1] ? sa[i] / sa[i - 1] : 0,
          convB: sb[i - 1] ? sb[i] / sb[i - 1] : 0,
          z: res.z, p: res.p, significant: res.p < 0.05
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ rendering */

function pct(x) { return (x * 100).toFixed(1) + "%"; }
function fmt(n) { return n.toLocaleString("en-US"); }

function el(id) { return document.getElementById(id); }

function analyse() {
  var errorBox = el("error");
  errorBox.textContent = "";
  var parsed;
  try {
    parsed = parseCsv(el("csv-input").value);
  } catch (e) {
    errorBox.textContent = "Error: " + e.message;
    el("results").hidden = true;
    return;
  }
  var steps = parsed.steps;
  var totals = steps.map(function (_, i) {
    return parsed.order.reduce(function (sum, seg) { return sum + parsed.series[seg][i]; }, 0);
  });
  var stats = stepStats(totals);
  var dropIdx = biggestDrop(steps, totals);

  el("results").hidden = false;

  el("callout").innerHTML =
    "<strong>Biggest drop-off:</strong> " + escapeHtml(steps[dropIdx - 1]) + " &rarr; " +
    escapeHtml(steps[dropIdx]) + " — only " + pct(stats[dropIdx].stepConv) +
    " convert (" + fmt(stats[dropIdx].lost) + " users lost). " +
    "Overall conversion: " + pct(stats[stats.length - 1].cumulative) +
    " (" + fmt(totals[0]) + " &rarr; " + fmt(totals[totals.length - 1]) + ").";

  /* Patient map */
  renderPatientMap(steps, stats, dropIdx);

  /* Table */
  var tbody = el("funnel-table").querySelector("tbody");
  tbody.innerHTML = "";
  steps.forEach(function (step, i) {
    var tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(step) + "</td><td>" + fmt(stats[i].users) + "</td><td>" +
      (i === 0 ? "—" : pct(stats[i].stepConv)) + "</td><td>" + pct(stats[i].cumulative) +
      "</td><td>" + fmt(stats[i].lost) + "</td>";
    tbody.appendChild(tr);
  });

  /* Segments */
  var comparisons = parsed.segmented ? segmentComparisons(parsed) : [];
  var segCard = el("segment-card");
  if (parsed.segmented) {
    segCard.hidden = false;
    var sbody = el("segment-table").querySelector("tbody");
    sbody.innerHTML = "";
    comparisons.forEach(function (c) {
      var tr = document.createElement("tr");
      if (c.significant) tr.className = "sig";
      tr.innerHTML =
        "<td>" + escapeHtml(c.step) + "</td><td>" +
        escapeHtml(c.segA) + " vs " + escapeHtml(c.segB) + "</td><td>" +
        pct(c.convA) + " vs " + pct(c.convB) + "</td><td>" + c.z.toFixed(2) +
        "</td><td>" + c.p.toFixed(4) + "</td><td>" + (c.significant ? "yes" : "no") + "</td>";
      sbody.appendChild(tr);
    });
  } else {
    segCard.hidden = true;
  }

  /* Diagnosis */
  var findings = [];
  findings.push("Biggest leak: " + steps[dropIdx - 1] + " → " + steps[dropIdx] + " at " +
    pct(stats[dropIdx].stepConv) + " step conversion. Start the investigation here.");
  var weak = [];
  for (var i = 1; i < steps.length; i++) {
    if (stats[i].stepConv < 0.20) weak.push(steps[i] + " (" + pct(stats[i].stepConv) + ")");
  }
  if (weak.length) {
    findings.push("Weak step(s) converting below 20%: " + weak.join(", ") + ".");
  } else {
    findings.push("No step converts below 20%.");
  }
  if (parsed.segmented) {
    var sig = comparisons.filter(function (c) { return c.significant; });
    if (sig.length) {
      var worst = sig.reduce(function (a, b) {
        return Math.abs(b.convA - b.convB) > Math.abs(a.convA - a.convB) ? b : a;
      });
      findings.push("Largest significant segment gap: " + worst.step + " — " + worst.segA +
        " " + pct(worst.convA) + " vs " + worst.segB + " " + pct(worst.convB) +
        " (p = " + worst.p.toFixed(4) + "). The weaker segment likely hits different friction at this step.");
      findings.push(sig.length + " of " + comparisons.length +
        " segment comparisons are significant at p < 0.05 (no multiple-comparison correction).");
    } else {
      findings.push("No statistically significant segment gaps (p < 0.05).");
    }
    parsed.order.forEach(function (seg) {
      var st = stepStats(parsed.series[seg]);
      findings.push("Segment " + seg + ": " + pct(st[st.length - 1].cumulative) +
        " end-to-end (" + fmt(parsed.series[seg][0]) + " → " +
        fmt(parsed.series[seg][parsed.series[seg].length - 1]) + ").");
    });
  }
  var list = el("diagnosis");
  list.innerHTML = "";
  findings.forEach(function (f) {
    var li = document.createElement("li");
    li.textContent = f;
    list.appendChild(li);
  });

  renderClinic(parsed, steps, totals, stats, dropIdx, comparisons);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

/* ------------------------------------------------------------ clinic layer
   Presentation and interaction only. The parsing and statistics above are
   the source of truth; everything below derives its facts from them. */

var currentAilments = [];
var extractedAilments = {};
var selectedStageIndex = 0;

function stageStatus(index, stat) {
  if (index === 0) return { label: "Intake", cls: "intake" };
  if (stat.stepConv >= 0.60) return { label: "Stable", cls: "stable" };
  if (stat.stepConv >= 0.40) return { label: "Guarded", cls: "guarded" };
  if (stat.stepConv >= 0.25) return { label: "Serious", cls: "serious" };
  return { label: "Critical", cls: "critical" };
}

function overallCondition(cumulative) {
  if (cumulative >= 0.25) return { label: "Stable", cls: "stable" };
  if (cumulative >= 0.10) return { label: "Guarded", cls: "guarded" };
  if (cumulative >= 0.05) return { label: "Serious", cls: "serious" };
  return { label: "Critical", cls: "critical" };
}

function doctorNote(index, steps, stats, dropIdx) {
  if (index === 0) {
    return "This is intake: the full admitted population. Every later reading is measured against these " + fmt(stats[0].users) + " people.";
  }
  if (index === dropIdx) {
    return "This is the critical transition. Only " + pct(stats[index].stepConv) + " make it from " + steps[index - 1] + " to " + steps[index] + ", so investigate this handoff before optimising anywhere else.";
  }
  if (stats[index].stepConv < 0.20) {
    return "This stage is below the clinic's 20% warning line. Treat it as a separate problem, not background noise around the main leak.";
  }
  if (stats[index].lost === Math.max.apply(null, stats.map(function (s) { return s.lost; }))) {
    return "This stage loses the largest number of people, even though another transition loses a larger share. It may deserve its own workstream.";
  }
  if (stats[index].stepConv >= 0.60) {
    return "A comparatively healthy handoff. Protect what is working here while attention goes to the weaker stages.";
  }
  return "A middling handoff: not the emergency, but " + fmt(stats[index].lost) + " people still leave here. Look for friction after the critical leak is understood.";
}

function renderExam(index, steps, stats, dropIdx) {
  selectedStageIndex = index;
  var stat = stats[index];
  var status = stageStatus(index, stat);
  el("exam-panel").innerHTML =
    '<p class="kicker">Now examining</p>' +
    "<h3>" + escapeHtml(steps[index]) + "</h3>" +
    '<p><span class="status-pill">' + status.label + "</span></p>" +
    '<div class="exam-grid">' +
      "<div><span>People here</span><strong>" + fmt(stat.users) + "</strong></div>" +
      "<div><span>From previous</span><strong>" + (index === 0 ? "—" : pct(stat.stepConv)) + "</strong></div>" +
      "<div><span>Of original</span><strong>" + pct(stat.cumulative) + "</strong></div>" +
      "<div><span>Lost before here</span><strong>" + fmt(stat.lost) + "</strong></div>" +
    "</div>" +
    '<p class="exam-note">' + escapeHtml(doctorNote(index, steps, stats, dropIdx)) + "</p>";
}

function selectStage(index, steps, stats, dropIdx) {
  var rows = el("chart").querySelectorAll(".stage-row");
  rows.forEach(function (row, i) {
    row.classList.toggle("selected", i === index);
    row.setAttribute("aria-pressed", i === index ? "true" : "false");
  });
  renderExam(index, steps, stats, dropIdx);
}

function renderPatientMap(steps, stats, dropIdx) {
  var chart = el("chart");
  chart.innerHTML = "";
  steps.forEach(function (step, i) {
    var status = stageStatus(i, stats[i]);
    var row = document.createElement("div");
    row.className = "stage-row status-" + status.cls + (i === dropIdx ? " selected" : "");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-pressed", i === dropIdx ? "true" : "false");
    row.setAttribute("aria-label", "Examine " + step);
    var transition = i === 0
      ? "Top of funnel · 100% of admitted people"
      : pct(stats[i].stepConv) + " from previous · " + fmt(stats[i].lost) + " lost";
    row.innerHTML =
      '<div class="stage-node">' + (i + 1) + "</div>" +
      '<div class="stage-main">' +
        '<div class="stage-top"><div><div class="stage-name">' + escapeHtml(step) + '</div>' +
        '<div class="stage-users">' + fmt(stats[i].users) + " people · " + pct(stats[i].cumulative) + ' of original</div></div>' +
        '<span class="status-pill">' + status.label + "</span></div>" +
        '<div class="stage-track"><div class="stage-fill" data-width="' + Math.max(2, stats[i].cumulative * 100) + '"></div></div>' +
        '<div class="stage-meta"><span>' + escapeHtml(transition) + "</span>" +
        (i === dropIdx ? '<span class="drop-badge">Critical transition</span>' : "") + "</div>" +
      "</div>";
    row.addEventListener("click", function () { selectStage(i, steps, stats, dropIdx); });
    row.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        selectStage(i, steps, stats, dropIdx);
      }
    });
    chart.appendChild(row);
  });
  requestAnimationFrame(function () {
    chart.querySelectorAll(".stage-fill").forEach(function (fill) {
      fill.style.width = fill.getAttribute("data-width") + "%";
    });
  });
  renderExam(dropIdx, steps, stats, dropIdx);
}

function buildAilments(steps, stats, dropIdx, comparisons, segmented) {
  var ailments = [];
  var drop = stats[dropIdx];
  var dropDetail = "Only " + pct(drop.stepConv) + " convert from " + steps[dropIdx - 1] + " to " + steps[dropIdx] + " — " + fmt(drop.lost) + " people are lost at this handoff.";
  if (drop.stepConv < 0.20) dropDetail += " It is also below the 20% warning line.";
  ailments.push({
    id: "critical-leak", kind: "Critical leak", title: steps[dropIdx - 1] + " → " + steps[dropIdx],
    detail: dropDetail, severity: drop.stepConv < 0.35 ? "critical" : "serious"
  });

  var maxLostIdx = 1;
  for (var i = 2; i < stats.length; i++) {
    if (stats[i].lost > stats[maxLostIdx].lost) maxLostIdx = i;
  }
  if (maxLostIdx !== dropIdx && stats[maxLostIdx].lost > 0) {
    ailments.push({
      id: "heavy-loss", kind: "Heavy loss", title: fmt(stats[maxLostIdx].lost) + " leave before " + steps[maxLostIdx],
      detail: "This is the largest headcount loss in the funnel. The share lost is smaller than at the critical leak, but the audience affected is bigger.",
      severity: "serious"
    });
  }

  for (var w = 1; w < steps.length && ailments.length < 4; w++) {
    if (w !== dropIdx && stats[w].stepConv < 0.20) {
      ailments.push({
        id: "weak-" + w, kind: "Weak stage", title: steps[w] + " converts at " + pct(stats[w].stepConv),
        detail: "This stage sits below the clinic's 20% warning line. Extract it separately so it does not hide behind the main leak.",
        severity: "critical"
      });
    }
  }

  if (segmented && ailments.length < 4) {
    var sig = comparisons.filter(function (c) { return c.significant; });
    if (sig.length) {
      var worst = sig.reduce(function (a, b) {
        return Math.abs(b.convA - b.convB) > Math.abs(a.convA - a.convB) ? b : a;
      });
      ailments.push({
        id: "segment-gap", kind: "Uneven response", title: worst.segA + " and " + worst.segB + " diverge at " + worst.step,
        detail: worst.segA + " converts at " + pct(worst.convA) + " versus " + pct(worst.convB) + " for " + worst.segB + " (p = " + worst.p.toFixed(4) + "). " + sig.length + " of " + comparisons.length + " segment comparisons are significant.",
        severity: "moderate"
      });
    }
  }
  return ailments.slice(0, 4);
}

function treatmentFor(ailment) {
  if (ailment.id === "critical-leak") {
    return {
      title: "Operate on " + ailment.title + " first",
      text: "Inspect the exact handoff: instrumentation, page or step friction, eligibility surprises, and user intent. Interview or watch people who reached the first step but never completed the second."
    };
  }
  if (ailment.id === "heavy-loss") {
    return {
      title: "Stop the heavy loss",
      text: "Because this stage affects the most people, check traffic quality, expectation mismatch, and whether the preceding step is admitting people who were never a fit."
    };
  }
  if (ailment.id === "segment-gap") {
    return {
      title: "Treat the segment gap separately",
      text: "Do not average the segments away. Compare the weaker segment's context, device, intent, and assistance needs at this step, then test a targeted variant."
    };
  }
  return {
    title: "Stabilise " + ailment.title,
    text: "Give this weak stage its own hypothesis and success measure. A sub-20% conversion usually signals a comprehension, trust, or effort problem rather than a traffic problem."
  };
}

function renderTreatment(ailments) {
  var list = el("treatment");
  list.innerHTML = "";
  ailments.forEach(function (ailment) {
    var plan = treatmentFor(ailment);
    var li = document.createElement("li");
    li.id = "plan-" + ailment.id;
    li.innerHTML =
      '<span class="plan-title">' + escapeHtml(plan.title) + "</span>" +
      '<span class="plan-text">' + escapeHtml(plan.text) + "</span>" +
      '<span class="plan-state">Awaiting extraction</span>';
    list.appendChild(li);
  });
  var follow = document.createElement("li");
  follow.className = "done";
  follow.innerHTML =
    '<span class="plan-title">Schedule the follow-up</span>' +
    '<span class="plan-text">After shipping a fix, admit the new funnel as a fresh patient and compare the same transitions. Do not declare recovery from one hopeful number.</span>' +
    '<span class="plan-state">Always required</span>';
  list.appendChild(follow);
}

function updateTray() {
  var total = currentAilments.length;
  var done = currentAilments.filter(function (a) { return extractedAilments[a.id]; }).length;
  el("tray-count").textContent = done + " of " + total + " extracted";
  el("extract-fill").style.width = total ? (done / total * 100) + "%" : "0%";
  var tray = el("tray-list");
  tray.innerHTML = "";
  if (!done) {
    tray.innerHTML = '<span class="tray-empty">No specimens yet. Extract a finding to collect it here.</span>';
  } else {
    currentAilments.forEach(function (a) {
      if (!extractedAilments[a.id]) return;
      var chip = document.createElement("span");
      chip.className = "specimen-chip";
      chip.textContent = a.kind + ": " + a.title;
      tray.appendChild(chip);
    });
  }
  if (total && done === total) {
    el("extract-status").textContent = "All findings extracted. The patient is stable enough to discharge with the treatment plan below.";
  }
  currentAilments.forEach(function (a) {
    var plan = el("plan-" + a.id);
    if (!plan) return;
    var state = plan.querySelector(".plan-state");
    if (extractedAilments[a.id]) {
      plan.classList.add("done");
      state.textContent = "Specimen collected";
    } else {
      plan.classList.remove("done");
      state.textContent = "Awaiting extraction";
    }
  });
}

function failExtraction(card, message) {
  card.classList.remove("holding");
  card.classList.add("buzz");
  card.querySelector(".hold-fill").style.width = "0%";
  card.querySelector(".hold-percent").textContent = "0%";
  el("extract-status").textContent = message;
  setTimeout(function () { card.classList.remove("buzz"); }, 420);
}

function completeExtraction(card, ailment) {
  extractedAilments[ailment.id] = true;
  card.classList.remove("holding");
  card.classList.add("extracted");
  card.setAttribute("aria-disabled", "true");
  card.querySelector(".hold-fill").style.width = "100%";
  card.querySelector(".hold-percent").textContent = "Done";
  card.querySelector(".hold-action").textContent = "Extracted";
  el("extract-status").textContent = ailment.kind + " collected: " + ailment.title + ".";
  updateTray();
}

function attachHold(card, ailment) {
  var startAt = 0;
  var startX = 0;
  var startY = 0;
  var frame = null;
  var activePointer = null;

  function tick() {
    var elapsed = performance.now() - startAt;
    var progress = Math.min(1, elapsed / 950);
    card.querySelector(".hold-fill").style.width = (progress * 100) + "%";
    card.querySelector(".hold-percent").textContent = Math.round(progress * 100) + "%";
    if (progress >= 1) {
      cleanup();
      completeExtraction(card, ailment);
      return;
    }
    frame = requestAnimationFrame(tick);
  }
  function cleanup() {
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    activePointer = null;
    card.classList.remove("holding");
  }
  function begin(x, y, pointerId) {
    if (extractedAilments[ailment.id]) return;
    startAt = performance.now();
    startX = x; startY = y; activePointer = pointerId;
    card.classList.add("holding");
    el("extract-status").textContent = "Steady… keep holding to extract " + ailment.kind.toLowerCase() + ".";
    frame = requestAnimationFrame(tick);
  }
  card.addEventListener("pointerdown", function (ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    if (card.setPointerCapture && ev.pointerId !== undefined) {
      try { card.setPointerCapture(ev.pointerId); } catch (e) { /* capture is an enhancement */ }
    }
    begin(ev.clientX, ev.clientY, ev.pointerId);
  });
  card.addEventListener("pointermove", function (ev) {
    if (activePointer === null || ev.pointerId !== activePointer) return;
    var distance = Math.hypot(ev.clientX - startX, ev.clientY - startY);
    if (distance > 18) {
      cleanup();
      failExtraction(card, "Buzz — too much movement. Rest your hand and hold the finding again.");
    }
  });
  card.addEventListener("pointerup", function (ev) {
    if (activePointer === null || ev.pointerId !== activePointer) return;
    cleanup();
    if (!extractedAilments[ailment.id]) failExtraction(card, "Released too soon. Press and hold until the ring reaches 100%.");
  });
  card.addEventListener("pointercancel", function () {
    if (activePointer !== null) {
      cleanup();
      failExtraction(card, "Extraction interrupted. Try the steady hold again.");
    }
  });
  card.addEventListener("keydown", function (ev) {
    if ((ev.key === "Enter" || ev.key === " ") && !ev.repeat && activePointer === null) {
      ev.preventDefault();
      begin(0, 0, "keyboard");
    }
  });
  card.addEventListener("keyup", function (ev) {
    if ((ev.key === "Enter" || ev.key === " ") && activePointer === "keyboard") {
      ev.preventDefault();
      cleanup();
      if (!extractedAilments[ailment.id]) failExtraction(card, "Released too soon. Hold Enter or Space until extraction reaches 100%.");
    }
  });
}

function renderAilments(ailments) {
  var wrap = el("ailments");
  wrap.innerHTML = "";
  ailments.forEach(function (ailment) {
    var card = document.createElement("div");
    card.className = "ailment sev-" + ailment.severity;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", "Press and hold to extract: " + ailment.title);
    card.innerHTML =
      '<span class="ailment-top"><span class="ailment-kind">' + escapeHtml(ailment.kind) + '</span>' +
      '<span class="severity">' + escapeHtml(ailment.severity) + "</span></span>" +
      "<h3>" + escapeHtml(ailment.title) + "</h3>" +
      "<p>" + escapeHtml(ailment.detail) + "</p>" +
      '<span class="hold-ui"><span class="hold-label"><span class="hold-action">Press &amp; hold — steady</span><span class="hold-percent">0%</span></span>' +
      '<span class="hold-track"><span class="hold-fill"></span></span></span>';
    attachHold(card, ailment);
    wrap.appendChild(card);
  });
  updateTray();
}

function renderClinic(parsed, steps, totals, stats, dropIdx, comparisons) {
  var condition = overallCondition(stats[stats.length - 1].cumulative);
  var pill = el("condition-pill");
  pill.textContent = "Condition: " + condition.label;
  pill.className = "condition-pill" + (condition.cls === "serious" ? " serious" : condition.cls === "critical" ? " critical" : "");

  el("vitals").innerHTML =
    '<div class="vital"><span class="v-label">Admitted</span><strong class="v-value">' + fmt(totals[0]) + '</strong><span class="v-note">people at ' + escapeHtml(steps[0]) + "</span></div>" +
    '<div class="vital"><span class="v-label">Made it through</span><strong class="v-value">' + fmt(totals[totals.length - 1]) + '</strong><span class="v-note">completed ' + escapeHtml(steps[steps.length - 1]) + "</span></div>" +
    '<div class="vital"><span class="v-label">Overall conversion</span><strong class="v-value">' + pct(stats[stats.length - 1].cumulative) + '</strong><span class="v-note">first step to last step</span></div>' +
    '<div class="vital alert"><span class="v-label">Critical transition</span><strong class="v-value">' + escapeHtml(steps[dropIdx - 1]) + " → " + escapeHtml(steps[dropIdx]) + '</strong><span class="v-note">only ' + pct(stats[dropIdx].stepConv) + " convert · " + fmt(stats[dropIdx].lost) + " lost</span></div>";

  currentAilments = buildAilments(steps, stats, dropIdx, comparisons || [], parsed.segmented);
  extractedAilments = {};
  el("extract-status").textContent = currentAilments.length + (currentAilments.length === 1 ? " finding is" : " findings are") + " ready. Extract each one to build the specimen tray.";
  renderAilments(currentAilments);
  renderTreatment(currentAilments);
}

/* ------------------------------------------------------------ wiring */

document.addEventListener("DOMContentLoaded", function () {
  el("load-sample").addEventListener("click", function () {
    el("csv-input").value = SAMPLE_PLAIN;
    analyse();
  });
  el("load-segment-sample").addEventListener("click", function () {
    el("csv-input").value = SAMPLE_SEGMENTS;
    analyse();
  });
  el("analyse").addEventListener("click", analyse);
  el("file-input").addEventListener("change", function (ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      el("csv-input").value = String(reader.result || "");
      analyse();
    };
    reader.readAsText(file);
  });

  /* Admit the fictional sample patient immediately so the clinic is alive
     on arrival; visitors can replace it with their own CSV at any time. */
  el("csv-input").value = SAMPLE_PLAIN;
  analyse();
});
