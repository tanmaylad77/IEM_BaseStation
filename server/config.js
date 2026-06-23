export const DEFAULT_RACE_PROFILE = Object.freeze({
  name: "Shell Eco-marathon Poland 2026",
  requiredLaps: 11,
  maxTimeS: 35 * 60,
  distanceKm: 14.6,
  lapDistanceKm: 14.6 / 11,
  defaultTargetFinishS: 34 * 60,
  defaultEnergyBudgetWh: 20
});

export const CSV_HEADINGS = Object.freeze([
  "run_id",
  "received_at_ms",
  "source_ms",
  "seq",
  "lap",
  "elapsed_s",
  "target_elapsed_s",
  "delta_s",
  "pack_voltage_v",
  "pack_current_a",
  "pack_power_w",
  "aggregate_wh",
  "soc_percent",
  "bms_state",
  "throttle_0_to_1",
  "wheel_speed_rad_s",
  "gps_fix",
  "latitude",
  "longitude",
  "rssi_dbm",
  "snr_db",
  "freq_error_hz",
  "valid_flags",
  "payload_raw"
]);
