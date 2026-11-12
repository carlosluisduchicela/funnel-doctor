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

  /* Bars */
  var chart = el("chart");
  chart.innerHTML = "";
  steps.forEach(function (step, i) {
    var row = document.createElement("div");
    row.className = "bar-row";
    var width = Math.max(1, stats[i].cumulative * 100);
    row.innerHTML =
      '<div class="bar-label">' + escapeHtml(step) + "</div>" +
      '<div class="bar-track"><div class="bar-fill' + (i === dropIdx ? " drop" : "") +
      '" style="width:' + width + '%"></div></div>' +
      '<div class="bar-value">' + fmt(stats[i].users) + " · " + pct(stats[i].cumulative) + "</div>";
    chart.appendChild(row);
  });

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
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
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
});
