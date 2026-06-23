const state = {
  snapshot: null,
  records: [],
  map: null,
  vehicleMarker: null,
  trackLine: null
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
  "connectionText", "runStatus", "elapsed", "laps", "delta", "predicted", "power",
  "energy", "voltage", "current", "radio", "packetAge", "paceText", "targetFinish",
  "energyBudget", "startBtn", "stopBtn", "resetBtn", "calibrateBtn", "exportLink",
  "lapTable", "powerChart", "progressChart", "electricalChart", "trackMap", "mapStatus"
].map(id => [id, document.getElementById(id)]));

initMap();
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
      state.records = state.records.slice(-900);
    }
    render();
  };
}

async function loadState() {
  state.snapshot = await fetch("/api/state").then(response => response.json());
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
  render();
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

  els.connectionText.textContent = `${snap.serial.connected ? "Serial connected" : "Serial disconnected"} (${snap.serial.port || "no port"})`;
  els.runStatus.textContent = active ? "Running" : "Idle";
  els.elapsed.textContent = fmtDuration(elapsedS);
  els.laps.textContent = `${race.lap} / ${profile.requiredLaps}`;
  els.delta.textContent = fmtSigned(latest?.delta_s ?? 0);
  els.delta.className = (latest?.delta_s ?? 0) <= 0 ? "good" : "bad";
  els.predicted.textContent = latest?.predicted_finish_s ? fmtDuration(latest.predicted_finish_s) : "--";
  els.power.textContent = `${fmt(latest?.pack_power_w, 1)} W`;
  els.energy.textContent = `${fmt(race.aggregateWh, 2)} Wh`;
  els.voltage.textContent = `${fmt(latest?.pack_voltage_v, 2)} V`;
  els.current.textContent = `${fmt(latest?.pack_current_a, 2)} A`;
  els.radio.textContent = latest ? `${fmt(latest.rssi_dbm, 0)} dBm / ${fmt(latest.snr_db, 1)} dB` : "--";
  els.packetAge.textContent = latest ? `Last packet ${fmt((Date.now() - latest.received_at_ms) / 1000, 0)} s ago` : "No packets yet";
  els.paceText.textContent = `Target: ${profile.requiredLaps} laps in ${fmtDuration(targetS)}; max ${fmtDuration(profile.maxTimeS)}`;
  els.exportLink.href = race.currentRunId ? `/api/runs/${encodeURIComponent(race.currentRunId)}/export.csv` : "#";
  updateMap(latest);

  renderLapTable(race.lapTimes || []);
  drawChart(els.powerChart, [
    { label: "Power W", color: "#c44536", values: state.records.map(r => [r.elapsed_s, r.pack_power_w]) },
    { label: "Wh", color: "#4f772d", values: state.records.map(r => [r.elapsed_s, r.aggregate_wh]) }
  ]);
  drawChart(els.electricalChart, [
    { label: "Voltage V", color: "#1f7a8c", values: state.records.map(r => [r.elapsed_s, r.pack_voltage_v]) },
    { label: "Current A", color: "#b7791f", values: state.records.map(r => [r.elapsed_s, r.pack_current_a]) }
  ]);
  drawProgressChart(els.progressChart, race, profile, elapsedS, targetS);
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

function renderLapTable(laps) {
  const tbody = els.lapTable.querySelector("tbody");
  tbody.innerHTML = laps.length ? laps.map(row => `
    <tr><td>${row.lap}</td><td>${fmtDuration(row.elapsed_s)}</td><td>${fmtDuration(row.lap_time_s)}</td></tr>
  `).join("") : `<tr><td colspan="3">No laps counted yet</td></tr>`;
}

function drawProgressChart(canvas, race, profile, elapsedS, targetS) {
  const ctx = setupCanvas(canvas);
  const width = canvas.width;
  const height = canvas.height;
  const pad = 44;
  ctx.clearRect(0, 0, width, height);
  axes(ctx, width, height, pad);
  const actualX = pad + (Math.min(targetS, elapsedS) / targetS) * (width - pad * 2);
  const actualY = height - pad - (Math.min(profile.requiredLaps, race.lap) / profile.requiredLaps) * (height - pad * 2);
  ctx.strokeStyle = "#d8dee8";
  ctx.beginPath();
  ctx.moveTo(pad, height - pad);
  ctx.lineTo(width - pad, pad);
  ctx.stroke();
  ctx.fillStyle = "#1f7a8c";
  ctx.beginPath();
  ctx.arc(actualX, actualY, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#17202a";
  ctx.font = "13px system-ui";
  ctx.fillText("Target", width - pad - 48, pad + 16);
  ctx.fillText(`Actual lap ${race.lap}`, Math.min(width - pad - 90, actualX + 10), Math.max(pad + 16, actualY));
}

function drawChart(canvas, series) {
  const ctx = setupCanvas(canvas);
  const width = canvas.width;
  const height = canvas.height;
  const pad = 44;
  ctx.clearRect(0, 0, width, height);
  axes(ctx, width, height, pad);

  const points = series.flatMap(s => s.values).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (points.length < 2) return;
  const minX = Math.min(...points.map(p => p[0]));
  const maxX = Math.max(...points.map(p => p[0]), minX + 1);
  const minY = Math.min(0, ...points.map(p => p[1]));
  const maxY = Math.max(...points.map(p => p[1]), minY + 1);

  for (const item of series) {
    const valid = item.values.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    valid.forEach(([x, y], index) => {
      const px = pad + ((x - minX) / (maxX - minX)) * (width - pad * 2);
      const py = height - pad - ((y - minY) / (maxY - minY)) * (height - pad * 2);
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  series.forEach((item, index) => {
    ctx.fillStyle = item.color;
    ctx.fillRect(pad + index * 110, 12, 12, 12);
    ctx.fillStyle = "#17202a";
    ctx.font = "12px system-ui";
    ctx.fillText(item.label, pad + 18 + index * 110, 22);
  });
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width));
  canvas.height = Math.max(1, Math.floor(rect.height));
  return canvas.getContext("2d");
}

function axes(ctx, width, height, pad) {
  ctx.strokeStyle = "#d8dee8";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(pad, height - pad);
  ctx.lineTo(width - pad, height - pad);
  ctx.stroke();
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
