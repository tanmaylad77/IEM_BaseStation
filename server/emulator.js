const BASE_LAT = 5031.68860;
const BASE_LON = 1805.76130;

export function startTelemetryEmulator(onLine, options = {}) {
  const intervalMs = Number(options.intervalMs || process.env.EMULATOR_INTERVAL_MS || 800);
  const startedAt = Date.now();
  let seq = 0;

  const timer = setInterval(() => {
    seq += 1;
    onLine(JSON.stringify(createEmulatedPacket(seq, Date.now() - startedAt)));
  }, intervalMs);

  onLine(JSON.stringify({
    schema: "iem.base.status.v1",
    type: "status",
    ms: 0,
    event: "emulator_ready"
  }));

  return () => clearInterval(timer);
}

export function createEmulatedPacket(seq, sourceMs) {
  const t = sourceMs / 1000;
  const lapPhase = (t / 185) % 1;
  const wave = Math.sin(t / 7);
  const throttle = clamp(0.34 + 0.18 * Math.sin(t / 11) + 0.06 * Math.sin(t / 2.7), 0, 1);
  const packVoltageV = 20.8 - 0.0012 * t - 0.12 * throttle + 0.03 * Math.sin(t / 19);
  const packCurrentA = Math.max(0, 0.25 + 4.3 * throttle + 0.35 * wave);
  const packPowerW = packVoltageV * packCurrentA;
  const wheelSpeedRadS = 8 + 20 * throttle + 2 * Math.sin(t / 5);
  const lat = BASE_LAT + 0.18000 * Math.sin(lapPhase * Math.PI * 2);
  const lon = BASE_LON + 0.27000 * Math.cos(lapPhase * Math.PI * 2);
  const soc = Math.max(0, Math.round(100 - t / 18));
  const raw = [
    `T=${Math.round(sourceMs)}`,
    "fix=1",
    `lat=${lat.toFixed(5)}N`,
    `lon=${lon.toFixed(5)}E`,
    `v=${packVoltageV.toFixed(2)}`,
    `i=${packCurrentA.toFixed(2)}`,
    `p=${packPowerW.toFixed(1)}`,
    `soc=${soc}`,
    "st=3",
    `thr=${throttle.toFixed(2)}`,
    `w=${wheelSpeedRadS.toFixed(2)}`,
    "valid=0x1FF"
  ].join(",");

  return {
    schema: "iem.lora.rx.v1",
    type: "telemetry",
    ms: Math.round(sourceMs),
    seq,
    radio: {
      rssi_dbm: round(-72 - 6 * Math.sin(t / 8) - Math.random() * 3, 1),
      snr_db: round(10 + 3 * Math.sin(t / 6), 1),
      freq_error_hz: round(2200 + 140 * Math.sin(t / 13), 2)
    },
    payload_format: "telemetryv2_kv_v1",
    payload_raw: raw,
    fields: {
      source_ms: Math.round(sourceMs),
      gps_fix: 1,
      latitude: Number(lat.toFixed(5)),
      latitude_hemi: "N",
      longitude: Number(lon.toFixed(5)),
      longitude_hemi: "E",
      pack_voltage_v: Number(packVoltageV.toFixed(2)),
      pack_current_a: Number(packCurrentA.toFixed(2)),
      pack_power_w: Number(packPowerW.toFixed(1)),
      soc_percent: soc,
      bms_state: 3,
      throttle_0_to_1: Number(throttle.toFixed(2)),
      wheel_speed_rad_s: Number(wheelSpeedRadS.toFixed(2)),
      valid_flags: 0x1FF
    }
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
