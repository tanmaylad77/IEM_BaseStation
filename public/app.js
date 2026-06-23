const state = {
  snapshot: null,
  records: [],
  map: null,
  vehicleMarker: null,
  trackLine: null,
  chartViews: {},
  renderedCharts: {},
  activeChartDrag: null,
  draggedPanelId: null
};

const SILESIA_RING_CENTER = [50.528144, 18.096021];
const SILESIA_TRACK_OUTLINE = [
  [50.531350, 18.095750],
  [50.530740, 18.099050],
  [50.529120, 18.101100],
  [50.526950, 18.100060],
  [50.525320, 18.096420],
  [50.525760, 18.092840],
  [50.527580, 18.090900],
  [50.529880, 18.091840],
  [50.531350, 18.095750]
];

const els = Object.fromEntries([
  "connectionText", "runStatus", "elapsed", "laps", "delta", "predicted", "efficiency",
  "power", "powerFill", "powerHint", "energy", "energyFill", "energyHint",
  "voltage", "voltageFill", "voltageHint", "current", "currentFill", "currentHint",
  "speed", "speedFill", "speedHint", "radio", "radioFill", "radioHint",
  "packetAge", "paceText", "electricalText", "lapText", "efficiencyText",
  "targetEfficiency", "projectedEnergy", "energyHeadroom", "distanceEstimate",
  "targetFinish", "energyBudget", "startBtn", "stopBtn", "resetBtn", "calibrateBtn",
  "exportLink", "lapTable", "powerChart", "progressChart", "electricalChart",
  "trackMap", "mapStatus", "panelGrid"
].map(id => [id, document.getElementById(id)]));

initMap();
initChartInteractions();
initPanelDragging();
connect();
loadState();
setInterval(render, 1000);

els.startBtn.addEventListener("click", () => post("/api/run/start", {
  targetFinishS: parseDuration(els.targetFinish.value),
  energyBudgetWh: Number(els.energyBudget.value)
}));
els.stopBtn.addEventListener("click", () => post("/api/run/stop"));
els.resetBtn.addEventListener("click", () => {
  state.records = [];
  state.chartViews = {};
  post("/api/run/reset");
});
els.calibrateBtn.addEventListener("click", () => post("/api/calibrate-start-line"));

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  ws.onopen = () => { els.connectionText.textContent = "Dashboard connected"; };
  ws.onclose = () => {
    els.connectionText.textContent = "Dashboard disconnected; retrying...";
    setTimeout(connect, 1000);
  };
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      state.snapshot = message.payload;
    }
    if (message.type === "telemetry") {
      state.snapshot = message.payload.state;
      state.records.push(message.payload.record);
      state.records = state.records.slice(-1800);
    }
    render();
  };
}

async function loadState() {
  state.snapshot = await fetch("/api/state").then(response => response.json());
  await loadRunRecords();
  render();
}

async function post(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    alert((await response.json()).error || "Request failed");
    return;
  }
  state.snapshot = await response.json();
  if (url === "/api/run/start" || url === "/api/run/reset") {
    state.records = [];
    state.chartViews = {};
  }
  render();
}

async function loadRunRecords() {
  const runId = state.snapshot?.race?.currentRunId;
  if (!runId) {
    state.records = [];
    return;
  }
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/records.json?limit=1800`);
  if (!response.ok) return;
  const body = await response.json();
  state.records = Array.isArray(body.records) ? body.records : [];
}

function render() {
  const snap = state.snapshot;
  if (!snap) return;
  const race = snap.race;
  const latest = race.latest;
  const profile = snap.profile;
  const active = race.active;
  const elapsedS = latest?.elapsed_s ?? (active ? (Date.now() - race.startedAtMs) / 1000 : 0);
  const targetS = race.targetFinishS || profile.defaultTargetFinishS;
  const metrics = calculateMetrics(race, profile, latest, elapsedS, targetS);
  const sourceLabel = snap.serial.mode === "cloud" ? "Cloud ingest" : `${titleCase(snap.serial.mode || "source")} ${snap.serial.connected ? "connected" : "disconnected"}`;

  els.connectionText.textContent = `${sourceLabel} (${snap.serial.port || "no port"})`;
  els.runStatus.textContent = active ? "Running" : "Idle";
  els.elapsed.textContent = fmtDuration(elapsedS);
  els.laps.textContent = `${race.lap} / ${profile.requiredLaps}`;
  els.delta.textContent = fmtSigned(latest?.delta_s ?? 0);
  els.delta.className = (latest?.delta_s ?? 0) <= 0 ? "good" : "bad";
  els.predicted.textContent = latest?.predicted_finish_s ? fmtDuration(latest.predicted_finish_s) : "--";
  els.efficiency.textContent = `${fmt(metrics.avgWhPerKm, 1)} Wh/km`;
  els.efficiency.className = metricClass(metrics.avgWhPerKm, metrics.targetWhPerKm, false);

  els.power.textContent = `${fmt(latest?.pack_power_w, 1)} W`;
  els.powerHint.textContent = `Live ${fmt(metrics.liveWhPerKm, 1)} Wh/km`;
  setFill(els.powerFill, percent(latest?.pack_power_w, 0, 180));

  els.energy.textContent = `${fmt(race.aggregateWh, 2)} Wh`;
  els.energyHint.textContent = `Budget ${fmt(race.energyBudgetWh, 1)} Wh`;
  setFill(els.energyFill, percent(race.aggregateWh, 0, race.energyBudgetWh || 1));

  els.voltage.textContent = `${fmt(latest?.pack_voltage_v, 2)} V`;
  els.voltageHint.textContent = latest?.soc_percent !== null && latest?.soc_percent !== undefined
    ? `SOC ${fmt(latest.soc_percent, 0)}%`
    : "Pack voltage";
  setFill(els.voltageFill, percent(latest?.pack_voltage_v, 16, 22));

  els.current.textContent = `${fmt(latest?.pack_current_a, 2)} A`;
  els.currentHint.textContent = latest?.pack_current_a < 0 ? "Regen current" : "Discharge current";
  setFill(els.currentFill, percent(Math.abs(latest?.pack_current_a ?? 0), 0, 8));

  els.speed.textContent = `${fmt(metrics.speedKmh, 1)} km/h`;
  els.speedHint.textContent = `Target ${fmt(metrics.targetSpeedKmh, 1)} km/h`;
  setFill(els.speedFill, percent(metrics.speedKmh, 0, Math.max(1, metrics.targetSpeedKmh * 1.35)));

  els.radio.textContent = latest ? `${fmt(latest.rssi_dbm, 0)} dBm / ${fmt(latest.snr_db, 1)} dB` : "--";
  els.radioHint.textContent = latest ? `Freq ${fmt(latest.freq_error_hz, 0)} Hz` : "RSSI / SNR";
  setFill(els.radioFill, percent(latest?.rssi_dbm, -120, -45));

  els.packetAge.textContent = latest ? `Last packet ${fmt((Date.now() - latest.received_at_ms) / 1000, 0)} s ago` : "No packets yet";
  els.paceText.textContent = `Target: ${profile.requiredLaps} laps in ${fmtDuration(targetS)}; max ${fmtDuration(profile.maxTimeS)}`;
  els.electricalText.textContent = latest
    ? `${fmt(latest.pack_voltage_v, 2)} V at ${fmt(latest.pack_current_a, 2)} A`
    : "Waiting for packets";
  els.lapText.textContent = race.lapTimes?.length ? `${race.lapTimes.length} counted` : "No laps counted yet";
  els.efficiencyText.textContent = `${fmt(metrics.avgWhPerKm, 1)} Wh/km against ${fmt(metrics.targetWhPerKm, 1)} Wh/km target`;
  els.targetEfficiency.textContent = `${fmt(metrics.targetWhPerKm, 1)} Wh/km`;
  els.projectedEnergy.textContent = `${fmt(metrics.projectedTotalWh, 1)} Wh`;
  els.projectedEnergy.className = metricClass(metrics.projectedTotalWh, race.energyBudgetWh, false);
  els.energyHeadroom.textContent = `${fmt(metrics.energyHeadroomWh, 1)} Wh`;
  els.energyHeadroom.className = metrics.energyHeadroomWh >= 0 ? "good" : "bad";
  els.distanceEstimate.textContent = `${fmt(metrics.distanceKm, 2)} km`;
  els.exportLink.href = race.currentRunId ? `/api/runs/${encodeURIComponent(race.currentRunId)}/export.csv` : "#";
  updateMap(latest);

  renderLapTable(race.lapTimes || []);
  drawDualAxisTimeChart(els.powerChart, "power", {
    title: "Power and Energy",
    xLabel: "Elapsed time",
    leftLabel: "Power (W)",
    rightLabel: "Energy (Wh)",
    leftColor: "#c44536",
    rightColor: "#4f772d",
    leftSeries: [{ label: "Power", values: state.records.map(r => [r.elapsed_s, r.pack_power_w]) }],
    rightSeries: [{ label: "Energy", values: state.records.map(r => [r.elapsed_s, r.aggregate_wh]) }]
  });
  drawDualAxisTimeChart(els.electricalChart, "electrical", {
    title: "Voltage and Current",
    xLabel: "Elapsed time",
    leftLabel: "Voltage (V)",
    rightLabel: "Current (A)",
    leftColor: "#1f7a8c",
    rightColor: "#b7791f",
    leftSeries: [{ label: "Voltage", values: state.records.map(r => [r.elapsed_s, r.pack_voltage_v]) }],
    rightSeries: [{ label: "Current", values: state.records.map(r => [r.elapsed_s, r.pack_current_a]) }]
  });
  drawProgressChart(els.progressChart, "progress", race, profile, elapsedS, targetS);
}

function initMap() {
  if (!window.L || !els.trackMap) {
    if (els.mapStatus) {
      els.mapStatus.textContent = "Map unavailable";
    }
    return;
  }

  state.map = L.map("trackMap", {
    zoomControl: true,
    attributionControl: true
  }).setView(SILESIA_RING_CENTER, 15);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(state.map);

  state.trackLine = L.polyline(SILESIA_TRACK_OUTLINE, {
    color: "#1f7a8c",
    weight: 4,
    opacity: 0.85
  }).addTo(state.map);

  state.map.fitBounds(state.trackLine.getBounds(), { padding: [24, 24] });
}

function updateMap(latest) {
  if (!state.map || !latest) {
    return;
  }

  const hasFix = latest.gps_fix && Number.isFinite(latest.latitude) && Number.isFinite(latest.longitude);
  if (!hasFix) {
    els.mapStatus.textContent = "Waiting for GPS";
    return;
  }

  const latLng = [latest.latitude, latest.longitude];
  els.mapStatus.textContent = `${latest.latitude.toFixed(5)}, ${latest.longitude.toFixed(5)}`;

  if (!state.vehicleMarker) {
    state.vehicleMarker = L.marker(latLng, {
      icon: L.divIcon({
        className: "",
        html: '<div class="vehicle-marker"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9]
      })
    }).addTo(state.map);
  } else {
    state.vehicleMarker.setLatLng(latLng);
  }

  if (!state.map.getBounds().pad(-0.15).contains(latLng)) {
    state.map.panTo(latLng);
  }
}

function initChartInteractions() {
  for (const canvas of document.querySelectorAll("canvas[data-chart-key]")) {
    const key = canvas.dataset.chartKey;

    canvas.addEventListener("wheel", event => {
      const rendered = state.renderedCharts[key];
      if (!rendered) return;
      event.preventDefault();
      const view = viewFor(key, rendered.xMin, rendered.xMax);
      const center = xValueFromEvent(event, rendered) ?? (view.xMin + view.xMax) / 2;
      const factor = Math.exp(event.deltaY * 0.0012);
      const nextMin = center - (center - view.xMin) * factor;
      const nextMax = center + (view.xMax - center) * factor;
      setChartView(key, nextMin, nextMax, rendered);
      render();
    }, { passive: false });

    canvas.addEventListener("pointerdown", event => {
      const rendered = state.renderedCharts[key];
      if (!rendered) return;
      canvas.setPointerCapture(event.pointerId);
      const view = viewFor(key, rendered.xMin, rendered.xMax);
      state.activeChartDrag = {
        key,
        startX: event.clientX,
        startMin: view.xMin,
        startMax: view.xMax
      };
    });

    canvas.addEventListener("pointermove", event => {
      const drag = state.activeChartDrag;
      const rendered = state.renderedCharts[key];
      if (!drag || drag.key !== key || !rendered) return;
      const span = drag.startMax - drag.startMin;
      const dx = event.clientX - drag.startX;
      const delta = -(dx / rendered.plotWidth) * span;
      setChartView(key, drag.startMin + delta, drag.startMax + delta, rendered);
      render();
    });

    canvas.addEventListener("pointerup", () => { state.activeChartDrag = null; });
    canvas.addEventListener("pointercancel", () => { state.activeChartDrag = null; });
    canvas.addEventListener("dblclick", () => {
      delete state.chartViews[key];
      render();
    });
  }

  for (const button of document.querySelectorAll("[data-chart-reset]")) {
    button.addEventListener("click", () => {
      const canvas = document.getElementById(button.dataset.chartReset);
      delete state.chartViews[canvas.dataset.chartKey];
      render();
    });
  }
}

function initPanelDragging() {
  const savedOrder = JSON.parse(localStorage.getItem("iem-panel-order") || "[]");
  for (const id of savedOrder) {
    const panel = document.querySelector(`[data-panel-id="${id}"]`);
    if (panel) els.panelGrid.appendChild(panel);
  }

  for (const panel of document.querySelectorAll("[data-panel-id]")) {
    panel.addEventListener("dragstart", event => {
      if (!event.target.closest(".drag-handle")) {
        event.preventDefault();
        return;
      }
      state.draggedPanelId = panel.dataset.panelId;
      event.dataTransfer.effectAllowed = "move";
    });
    panel.addEventListener("dragover", event => {
      if (!state.draggedPanelId) return;
      event.preventDefault();
      panel.classList.add("drag-over");
    });
    panel.addEventListener("dragleave", () => panel.classList.remove("drag-over"));
    panel.addEventListener("drop", event => {
      event.preventDefault();
      panel.classList.remove("drag-over");
      const dragged = document.querySelector(`[data-panel-id="${state.draggedPanelId}"]`);
      if (!dragged || dragged === panel) return;
      const afterTarget = event.clientY > panel.getBoundingClientRect().top + panel.offsetHeight / 2;
      els.panelGrid.insertBefore(dragged, afterTarget ? panel.nextSibling : panel);
      savePanelOrder();
    });
    panel.addEventListener("dragend", () => {
      state.draggedPanelId = null;
      panel.classList.remove("drag-over");
    });
  }
}

function savePanelOrder() {
  const order = [...document.querySelectorAll("[data-panel-id]")].map(panel => panel.dataset.panelId);
  localStorage.setItem("iem-panel-order", JSON.stringify(order));
}

function renderLapTable(laps) {
  const tbody = els.lapTable.querySelector("tbody");
  tbody.innerHTML = laps.length ? laps.map(row => `
    <tr><td>${row.lap}</td><td>${fmtDuration(row.elapsed_s)}</td><td>${fmtDuration(row.lap_time_s)}</td></tr>
  `).join("") : `<tr><td colspan="3">No laps counted yet</td></tr>`;
}

function drawDualAxisTimeChart(canvas, key, config) {
  const ctx = setupCanvas(canvas);
  const width = canvas.width;
  const height = canvas.height;
  const plot = { left: 62, right: width - 58, top: 34, bottom: height - 48 };
  ctx.clearRect(0, 0, width, height);

  const leftValues = config.leftSeries.flatMap(series => series.values).filter(validPoint);
  const rightValues = config.rightSeries.flatMap(series => series.values).filter(validPoint);
  const allValues = [...leftValues, ...rightValues];
  const xRange = rangeFor(allValues.map(point => point[0]), 0, 60);
  const view = viewFor(key, xRange.min, xRange.max);
  const visibleLeft = leftValues.filter(point => point[0] >= view.xMin && point[0] <= view.xMax);
  const visibleRight = rightValues.filter(point => point[0] >= view.xMin && point[0] <= view.xMax);
  const leftRange = paddedRange(visibleLeft.map(point => point[1]), true);
  const rightRange = paddedRange(visibleRight.map(point => point[1]), true);

  state.renderedCharts[key] = {
    xMin: xRange.min,
    xMax: xRange.max,
    viewXMin: view.xMin,
    viewXMax: view.xMax,
    plot,
    plotWidth: plot.right - plot.left
  };

  drawGrid(ctx, plot, view.xMin, view.xMax, leftRange, config.xLabel, config.leftLabel, config.leftColor, {
    showRight: true,
    rightLabel: config.rightLabel,
    rightRange,
    rightColor: config.rightColor
  });

  drawSeriesSet(ctx, plot, view, leftRange, config.leftSeries, config.leftColor);
  drawSeriesSet(ctx, plot, view, rightRange, config.rightSeries, config.rightColor);
  drawLegend(ctx, plot, [
    ...config.leftSeries.map(series => ({ label: series.label, color: config.leftColor })),
    ...config.rightSeries.map(series => ({ label: series.label, color: config.rightColor }))
  ]);
  drawEmptyState(ctx, plot, allValues.length);
}

function drawProgressChart(canvas, key, race, profile, elapsedS, targetS) {
  const ctx = setupCanvas(canvas);
  const width = canvas.width;
  const height = canvas.height;
  const plot = { left: 62, right: width - 28, top: 34, bottom: height - 48 };
  ctx.clearRect(0, 0, width, height);

  const maxX = Math.max(targetS, elapsedS, 60);
  const view = viewFor(key, 0, maxX);
  const yRange = { min: 0, max: profile.requiredLaps };
  const progressPoints = state.records.map(record => [record.elapsed_s, record.lap]).filter(validPoint);

  state.renderedCharts[key] = {
    xMin: 0,
    xMax: maxX,
    viewXMin: view.xMin,
    viewXMax: view.xMax,
    plot,
    plotWidth: plot.right - plot.left
  };

  drawGrid(ctx, plot, view.xMin, view.xMax, yRange, "Elapsed time", "Completed laps", "#1f7a8c");
  drawLine(ctx, plot, view, yRange, [[0, 0], [targetS, profile.requiredLaps]], "#9aa6b2", 2, [6, 4]);
  drawLine(ctx, plot, view, yRange, progressPoints, "#1f7a8c", 2.5);

  const actual = [elapsedS, race.lap];
  if (validPoint(actual)) {
    const x = scale(actual[0], view.xMin, view.xMax, plot.left, plot.right);
    const y = scale(actual[1], yRange.min, yRange.max, plot.bottom, plot.top);
    ctx.fillStyle = "#c44536";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  drawLegend(ctx, plot, [
    { label: "Actual", color: "#1f7a8c" },
    { label: "Target", color: "#9aa6b2" }
  ]);
}

function drawGrid(ctx, plot, xMin, xMax, yRange, xLabel, yLabel, yColor, options = {}) {
  ctx.save();
  ctx.strokeStyle = "#e8edf3";
  ctx.lineWidth = 1;
  ctx.font = "11px system-ui";
  ctx.fillStyle = "#657386";

  const xTicks = ticks(xMin, xMax, 5);
  const yTicks = ticks(yRange.min, yRange.max, 5);
  for (const tick of xTicks) {
    const x = scale(tick, xMin, xMax, plot.left, plot.right);
    ctx.beginPath();
    ctx.moveTo(x, plot.top);
    ctx.lineTo(x, plot.bottom);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillText(fmtDuration(tick), x, plot.bottom + 20);
  }
  for (const tick of yTicks) {
    const y = scale(tick, yRange.min, yRange.max, plot.bottom, plot.top);
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(fmtAxis(tick), plot.left - 8, y + 4);
  }

  ctx.strokeStyle = "#b8c3cf";
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);
  ctx.stroke();

  ctx.fillStyle = "#657386";
  ctx.textAlign = "center";
  ctx.fillText(xLabel, (plot.left + plot.right) / 2, plot.bottom + 40);

  ctx.save();
  ctx.translate(18, (plot.top + plot.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = yColor;
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();

  if (options.showRight) {
    ctx.fillStyle = options.rightColor;
    ctx.textAlign = "left";
    for (const tick of ticks(options.rightRange.min, options.rightRange.max, 5)) {
      const y = scale(tick, options.rightRange.min, options.rightRange.max, plot.bottom, plot.top);
      ctx.fillText(fmtAxis(tick), plot.right + 8, y + 4);
    }
    ctx.save();
    ctx.translate(plot.right + 46, (plot.top + plot.bottom) / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(options.rightLabel, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function drawSeriesSet(ctx, plot, xRange, yRange, seriesSet, color) {
  for (const series of seriesSet) {
    const values = series.values.filter(validPoint);
    drawLine(ctx, plot, xRange, yRange, values, color, 2.5);
  }
}

function drawLine(ctx, plot, xRange, yRange, values, color, lineWidth = 2, dash = []) {
  const visible = values.filter(point => point[0] >= xRange.xMin && point[0] <= xRange.xMax);
  if (visible.length < 2) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dash);
  ctx.beginPath();
  visible.forEach(([xValue, yValue], index) => {
    const x = scale(xValue, xRange.xMin, xRange.xMax, plot.left, plot.right);
    const y = scale(yValue, yRange.min, yRange.max, plot.bottom, plot.top);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawLegend(ctx, plot, items) {
  ctx.save();
  ctx.font = "12px system-ui";
  let x = plot.left;
  for (const item of items) {
    ctx.fillStyle = item.color;
    ctx.fillRect(x, 12, 12, 3);
    ctx.fillStyle = "#17202a";
    ctx.fillText(item.label, x + 18, 16);
    x += ctx.measureText(item.label).width + 54;
  }
  ctx.restore();
}

function drawEmptyState(ctx, plot, count) {
  if (count > 1) return;
  ctx.save();
  ctx.fillStyle = "#657386";
  ctx.font = "13px system-ui";
  ctx.textAlign = "center";
  ctx.fillText("Waiting for telemetry", (plot.left + plot.right) / 2, (plot.top + plot.bottom) / 2);
  ctx.restore();
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width));
  canvas.height = Math.max(1, Math.floor(rect.height));
  return canvas.getContext("2d");
}

function calculateMetrics(race, profile, latest, elapsedS, targetS) {
  const targetWhPerKm = safeDivide(race.energyBudgetWh, profile.distanceKm);
  const trackFraction = latest?.gps_fix ? estimateTrackFraction(latest.latitude, latest.longitude) : null;
  const lapDistance = profile.lapDistanceKm;
  const completedKm = Math.min(profile.distanceKm, Math.max(0, race.lap * lapDistance));
  const gpsKm = Number.isFinite(trackFraction)
    ? Math.min(profile.distanceKm, Math.max(completedKm, (race.lap + trackFraction) * lapDistance))
    : completedKm;
  const fallbackTargetKm = Math.min(profile.distanceKm, Math.max(0, safeDivide(elapsedS, targetS) * profile.distanceKm));
  const distanceKm = Math.max(gpsKm, fallbackTargetKm * 0.25);
  const speedKmh = elapsedS > 0 && distanceKm > 0 ? distanceKm / elapsedS * 3600 : null;
  const targetSpeedKmh = profile.distanceKm / targetS * 3600;
  const avgWhPerKm = distanceKm > 0 ? race.aggregateWh / distanceKm : null;
  const liveWhPerKm = speedKmh > 1 && latest?.pack_power_w > 0 ? latest.pack_power_w / speedKmh : null;
  const projectedTotalWh = Number.isFinite(avgWhPerKm) ? avgWhPerKm * profile.distanceKm : null;

  return {
    distanceKm,
    speedKmh,
    targetSpeedKmh,
    targetWhPerKm,
    avgWhPerKm,
    liveWhPerKm,
    projectedTotalWh,
    energyHeadroomWh: race.energyBudgetWh - race.aggregateWh
  };
}

function estimateTrackFraction(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const point = projectMeters(latitude, longitude);
  const projected = SILESIA_TRACK_OUTLINE.map(([lat, lon]) => projectMeters(lat, lon));
  let total = 0;
  const segments = [];
  for (let i = 0; i < projected.length - 1; i++) {
    const length = distance(projected[i], projected[i + 1]);
    segments.push({ start: projected[i], end: projected[i + 1], length, before: total });
    total += length;
  }
  if (total <= 0) return null;

  let best = { distance: Infinity, along: 0 };
  for (const segment of segments) {
    const vx = segment.end.x - segment.start.x;
    const vy = segment.end.y - segment.start.y;
    const wx = point.x - segment.start.x;
    const wy = point.y - segment.start.y;
    const t = clamp((wx * vx + wy * vy) / Math.max(1, segment.length ** 2), 0, 1);
    const closest = { x: segment.start.x + vx * t, y: segment.start.y + vy * t };
    const d = distance(point, closest);
    if (d < best.distance) {
      best = { distance: d, along: segment.before + segment.length * t };
    }
  }
  return clamp(best.along / total, 0, 0.999);
}

function projectMeters(latitude, longitude) {
  const latRad = SILESIA_RING_CENTER[0] * Math.PI / 180;
  return {
    x: longitude * 111320 * Math.cos(latRad),
    y: latitude * 110540
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function setChartView(key, xMin, xMax, rendered) {
  const fullMin = rendered.xMin;
  const fullMax = rendered.xMax;
  const fullSpan = fullMax - fullMin;
  const minSpan = Math.max(5, fullSpan * 0.02);
  let nextMin = xMin;
  let nextMax = xMax;
  if (nextMax - nextMin < minSpan) {
    const mid = (nextMin + nextMax) / 2;
    nextMin = mid - minSpan / 2;
    nextMax = mid + minSpan / 2;
  }
  if (nextMin < fullMin) {
    nextMax += fullMin - nextMin;
    nextMin = fullMin;
  }
  if (nextMax > fullMax) {
    nextMin -= nextMax - fullMax;
    nextMax = fullMax;
  }
  state.chartViews[key] = {
    xMin: Math.max(fullMin, nextMin),
    xMax: Math.min(fullMax, nextMax)
  };
}

function viewFor(key, xMin, xMax) {
  const view = state.chartViews[key];
  if (!view || !Number.isFinite(view.xMin) || !Number.isFinite(view.xMax)) {
    return { xMin, xMax };
  }
  return {
    xMin: Math.max(xMin, view.xMin),
    xMax: Math.min(xMax, view.xMax)
  };
}

function xValueFromEvent(event, rendered) {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const plot = rendered.plot;
  if (x < plot.left || x > plot.right) return null;
  return scale(x, plot.left, plot.right, rendered.viewXMin, rendered.viewXMax);
}

function validPoint(point) {
  return Number.isFinite(point?.[0]) && Number.isFinite(point?.[1]);
}

function rangeFor(values, fallbackMin, fallbackMax) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return { min: fallbackMin, max: fallbackMax };
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  return { min, max: max <= min ? min + 1 : max };
}

function paddedRange(values, includeZero = false) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return { min: 0, max: 1 };
  let min = Math.min(...valid);
  let max = Math.max(...valid);
  if (includeZero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

function ticks(min, max, count) {
  const step = niceStep((max - min) / Math.max(1, count - 1));
  const start = Math.ceil(min / step) * step;
  const result = [];
  for (let value = start; value <= max + step * 0.5; value += step) {
    result.push(Math.abs(value) < 1e-9 ? 0 : value);
  }
  return result.slice(0, count + 2);
}

function niceStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const fraction = rawStep / 10 ** exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * 10 ** exponent;
}

function scale(value, fromMin, fromMax, toMin, toMax) {
  if (fromMax === fromMin) return (toMin + toMax) / 2;
  return toMin + ((value - fromMin) / (fromMax - fromMin)) * (toMax - toMin);
}

function setFill(element, value) {
  element.style.width = `${clamp(value, 0, 100).toFixed(1)}%`;
}

function percent(value, min, max) {
  if (!Number.isFinite(value) || max <= min) return 0;
  return ((value - min) / (max - min)) * 100;
}

function safeDivide(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null;
}

function metricClass(value, target, higherIsBetter = true) {
  if (!Number.isFinite(value) || !Number.isFinite(target)) return "";
  const ratio = value / target;
  if (higherIsBetter) return ratio >= 0.98 ? "good" : ratio >= 0.9 ? "warn" : "bad";
  return ratio <= 1 ? "good" : ratio <= 1.08 ? "warn" : "bad";
}

function parseDuration(value) {
  const parts = String(value).split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : 2040;
}

function fmt(value, places = 1) {
  return Number.isFinite(value) ? Number(value).toFixed(places) : "--";
}

function fmtAxis(value) {
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const rounded = Math.max(0, Math.round(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function fmtSigned(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number >= 0 ? "+" : ""}${number.toFixed(1)} s`;
}

function titleCase(value) {
  return String(value).replace(/^\w/, letter => letter.toUpperCase());
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
