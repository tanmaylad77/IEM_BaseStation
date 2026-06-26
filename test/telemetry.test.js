import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CSV_HEADINGS } from "../server/config.js";
import { recordsToCsv } from "../server/csv.js";
import { createEmulatedPacket } from "../server/emulator.js";
import { authorizeIngest, ingestTelemetryPacket, parseIngestBody } from "../server/ingest.js";
import { RaceState } from "../server/race.js";
import { bridgeConfigFromEnv, parseBridgeLine, uploadPacket } from "../server/serial-bridge.js";
import { Store } from "../server/store.js";
import {
  computeTargetDelta,
  detectLapCrossing,
  hasValidGps,
  integrateWh,
  nmeaToDecimal,
  normalizePacket,
  parseBaseStationLine
} from "../server/telemetry.js";

const sampleLine = JSON.stringify({
  schema: "iem.lora.rx.v1",
  type: "telemetry",
  ms: 2889,
  seq: 1,
  radio: { rssi_dbm: -82, snr_db: 13.8, freq_error_hz: 2405.43 },
  payload_format: "telemetryv2_kv_v1",
  payload_raw: "T=208408,fix=1,lat=5123.45678N,lon=00012.34567W,v=20.67,i=1.50,p=31.0,soc=255,st=3,thr=0.00,w=0.00,valid=0x007",
  fields: {
    source_ms: 208408,
    gps_fix: 1,
    latitude: 5123.45678,
    latitude_hemi: "N",
    longitude: 12.34567,
    longitude_hemi: "W",
    pack_voltage_v: 20.67,
    pack_current_a: 1.5,
    pack_power_w: 31,
    soc_percent: 255,
    bms_state: 3,
    throttle_0_to_1: 0,
    wheel_speed_rad_s: 0,
    valid_flags: 7
  }
});

test("parses valid base-station NDJSON and rejects boot noise", () => {
  assert.equal(parseBaseStationLine("ESP-ROM:esp32s3-20210327"), null);
  assert.equal(parseBaseStationLine("{not json"), null);
  assert.equal(parseBaseStationLine(JSON.stringify({ schema: "iem.base.status.v1", type: "status" })), null);
  assert.equal(parseBaseStationLine(sampleLine).schema, "iem.lora.rx.v1");
});

test("normalizes telemetry packets and converts NMEA coordinates", () => {
  const packet = normalizePacket(parseBaseStationLine(sampleLine), 1000);
  assert.equal(packet.received_at_ms, 1000);
  assert.equal(packet.pack_power_w, 31);
  assert.equal(packet.pack_voltage_v, 20.67);
  assert.equal(packet.pack_current_a, 1.5);
  assert.equal(Math.round(packet.latitude * 1e6), 51390946);
  assert.equal(Math.round(packet.longitude * 1e6), -205761);
  assert.equal(nmeaToDecimal(5123.45678, "N").toFixed(6), "51.390946");
  assert.equal(nmeaToDecimal(12.34567, "W").toFixed(6), "-0.205761");
});

test("integrates positive Wh across variable packet intervals", () => {
  const previous = { received_at_ms: 0, pack_power_w: 20 };
  const current = { received_at_ms: 2000, pack_power_w: 40 };
  assert.equal(integrateWh(previous, current, 0).toFixed(6), "0.016667");
  assert.equal(integrateWh(current, { received_at_ms: 9000, pack_power_w: 100 }, 1), 1);
  assert.equal(integrateWh(current, { received_at_ms: 3000, pack_power_w: -20 }, 1).toFixed(6), "1.002778");
});

test("computes target delta from completed lap count", () => {
  const target = computeTargetDelta(620, 3, 2040, 11);
  assert.equal(target.requiredAverageLapS.toFixed(3), "185.455");
  assert.equal(target.targetElapsedS.toFixed(3), "556.364");
  assert.equal(target.deltaS.toFixed(3), "63.636");
  assert.equal(target.predictedFinishS.toFixed(3), "2273.333");
});

test("detects line crossings and rejects immediate double counts", () => {
  const startLine = { latitude: 0, longitude: 0, heading_deg: 90 };
  const before = { gps_fix: 1, valid_flags: 1, latitude: 0, longitude: -0.0001, received_at_ms: 1000 };
  const after = { gps_fix: 1, valid_flags: 1, latitude: 0, longitude: 0.0001, received_at_ms: 2000 };
  assert.equal(detectLapCrossing(startLine, before, after, null), true);
  assert.equal(detectLapCrossing(startLine, before, after, 1500), false);
});

test("rejects GPS points when telemetry valid flags are zero", () => {
  const valid = { gps_fix: 1, valid_flags: 7, latitude: 50.5, longitude: 18.1 };
  const missingFlags = { gps_fix: 1, valid_flags: null, latitude: 50.5, longitude: 18.1 };
  const invalid = { gps_fix: 1, valid_flags: 0, latitude: 50.5, longitude: 18.1 };
  assert.equal(hasValidGps(valid), true);
  assert.equal(hasValidGps(missingFlags), true);
  assert.equal(hasValidGps(invalid), false);
});

test("generates CSV with exact headings and stable row values", () => {
  const csv = recordsToCsv([{ run_id: "run-1", received_at_ms: 1, payload_raw: "a,b" }]);
  assert.equal(csv.split("\n")[0], CSV_HEADINGS.join(","));
  assert.match(csv, /run-1,1/);
  assert.match(csv, /"a,b"/);
});

test("race state appends run records and exports them from store", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "iem-dashboard-"));
  const store = new Store(tempDir);
  const race = new RaceState(store);
  race.start({ targetFinishS: 2040, energyBudgetWh: 12 });
  const normalized = normalizePacket(parseBaseStationLine(sampleLine), Date.now());
  const enriched = race.ingest(normalized);
  const records = store.readRunRecords(race.state.currentRunId);
  assert.equal(records.length, 1);
  assert.equal(records[0].run_id, enriched.run_id);
  assert.equal(records[0].pack_voltage_v, 20.67);
});

test("starting a run clears stale latest telemetry", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "iem-dashboard-start-"));
  const store = new Store(tempDir);
  const race = new RaceState(store);
  const normalized = normalizePacket(parseBaseStationLine(sampleLine), Date.now());
  race.ingest(normalized);
  assert.equal(race.state.latest.pack_voltage_v, 20.67);
  race.start({ targetFinishS: 2040, energyBudgetWh: 12 });
  assert.equal(race.state.latest, null);
});

test("emulator creates valid dashboard telemetry packets", () => {
  const packet = createEmulatedPacket(42, 12345);
  const parsed = parseBaseStationLine(JSON.stringify(packet));
  const normalized = normalizePacket(parsed, 5000);
  assert.equal(parsed.schema, "iem.lora.rx.v1");
  assert.equal(normalized.seq, 42);
  assert.equal(normalized.gps_fix, 1);
  assert.equal(typeof normalized.pack_power_w, "number");
  assert.ok(normalized.pack_voltage_v > 15);
  assert.ok(normalized.latitude > 49 && normalized.latitude < 51);
  assert.ok(normalized.longitude > 18 && normalized.longitude < 19);
});

test("cloud ingest requires matching token when configured", () => {
  assert.equal(authorizeIngest({}, ""), true);
  assert.equal(authorizeIngest({ "x-ingest-token": "secret" }, "secret"), true);
  assert.equal(authorizeIngest({ "x-ingest-token": "wrong" }, "secret"), false);
  assert.equal(authorizeIngest({}, "secret"), false);
});

test("cloud ingest accepts valid packet bodies and rejects invalid bodies", () => {
  const normalized = parseIngestBody(JSON.parse(sampleLine));
  assert.equal(normalized.pack_voltage_v, 20.67);
  assert.equal(parseIngestBody({ schema: "iem.base.status.v1", type: "status" }), null);
  assert.equal(parseIngestBody("not json"), null);
});

test("serial cloud bridge filters lines and sends ingest token", async () => {
  assert.equal(parseBridgeLine("ESP-ROM:esp32s3-20210327"), null);
  assert.equal(parseBridgeLine(JSON.stringify({ schema: "iem.base.status.v1", type: "status" })), null);
  assert.equal(parseBridgeLine(sampleLine).seq, 1);

  const config = bridgeConfigFromEnv({
    CLOUD_INGEST_URL: "https://example.test/api/ingest",
    INGEST_TOKEN: "test-secret",
    SERIAL_BAUD: "9600",
    BRIDGE_UPLOAD_ATTEMPTS: "2"
  });
  assert.equal(config.ingestUrl, "https://example.test/api/ingest");
  assert.equal(config.ingestToken, "test-secret");
  assert.equal(config.baudRate, 9600);
  assert.equal(config.maxUploadAttempts, 2);

  let request;
  await uploadPacket(parseBridgeLine(sampleLine), config, async (url, options) => {
    request = { url, options };
    return new Response("", { status: 200 });
  });

  assert.equal(request.url, "https://example.test/api/ingest");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["x-ingest-token"], "test-secret");
  assert.equal(JSON.parse(request.options.body).schema, "iem.lora.rx.v1");
});

test("cloud ingest path updates race state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "iem-cloud-ingest-"));
  const store = new Store(tempDir);
  const race = new RaceState(store);
  const normalized = parseIngestBody(JSON.parse(sampleLine));
  const enriched = ingestTelemetryPacket(race, normalized);
  assert.equal(enriched.pack_voltage_v, 20.67);
  assert.equal(race.state.latest.pack_voltage_v, 20.67);
});

test("HTTP ingest endpoint enforces token and validates packets", async () => {
  const port = 4200 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      CLOUD_ONLY: "1",
      INGEST_TOKEN: "test-secret"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForServer(`http://localhost:${port}/api/state`);
    const packet = createEmulatedPacket(7, 1000);

    const unauthorized = await fetch(`http://localhost:${port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-token": "wrong" },
      body: JSON.stringify(packet)
    });
    assert.equal(unauthorized.status, 401);

    const invalid = await fetch(`http://localhost:${port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-token": "test-secret" },
      body: JSON.stringify({ schema: "iem.base.status.v1", type: "status" })
    });
    assert.equal(invalid.status, 400);

    const bootNoise = await fetch(`http://localhost:${port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-token": "test-secret" },
      body: "ESP-ROM:esp32s3-20210327"
    });
    assert.equal(bootNoise.status, 400);

    await fetch(`http://localhost:${port}/api/run/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetFinishS: 2040, energyBudgetWh: 12 })
    });

    const valid = await fetch(`http://localhost:${port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-token": "test-secret" },
      body: JSON.stringify(packet)
    });
    assert.equal(valid.status, 204);

    const state = await fetch(`http://localhost:${port}/api/state`).then(response => response.json());
    assert.equal(state.serial.mode, "cloud");
    assert.equal(state.race.latest.seq, 7);

    const records = await fetch(`http://localhost:${port}/api/runs/${encodeURIComponent(state.race.currentRunId)}/records.json?limit=1`)
      .then(response => response.json());
    assert.equal(records.records.length, 1);
    assert.equal(records.records[0].seq, 7);
  } finally {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
  }
});

test("serial cloud bridge replay uploads valid fixture packets to cloud ingest", async () => {
  const port = 4700 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      CLOUD_ONLY: "1",
      INGEST_TOKEN: "test-secret"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForServer(`http://localhost:${port}/api/state`);
    await fetch(`http://localhost:${port}/api/run/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetFinishS: 2040, energyBudgetWh: 12 })
    });

    const bridge = spawn(process.execPath, ["server/serial-bridge.js"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        CLOUD_INGEST_URL: `http://localhost:${port}/api/ingest`,
        INGEST_TOKEN: "test-secret",
        BRIDGE_REPLAY_FILE: "test/fixtures/base-station-sample.ndjson",
        BRIDGE_REPLAY_DELAY_MS: "1",
        BRIDGE_UPLOAD_ATTEMPTS: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const exitCode = await waitForExit(bridge);
    assert.equal(exitCode, 0);

    const state = await fetch(`http://localhost:${port}/api/state`).then(response => response.json());
    assert.equal(state.race.latest.seq, 3);

    const records = await fetch(`http://localhost:${port}/api/runs/${encodeURIComponent(state.race.currentRunId)}/records.json?limit=10`)
      .then(response => response.json());
    assert.equal(records.records.length, 3);
    assert.deepEqual(records.records.map(record => record.seq), [1, 2, 3]);
  } finally {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
  }
});

async function waitForServer(url) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${url}`);
}

async function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Child exited with ${code}: ${stderr}`));
      }
    });
  });
}
