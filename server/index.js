import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { WebSocketServer } from "ws";
import { recordsToCsv } from "./csv.js";
import { authorizeIngest, ingestTelemetryPacket, parseIngestBody } from "./ingest.js";
import { RaceState } from "./race.js";
import { DEFAULT_RACE_PROFILE } from "./config.js";
import { startTelemetryEmulator } from "./emulator.js";
import { normalizePacket, parseBaseStationLine } from "./telemetry.js";
import { Store } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const port = Number(process.env.PORT || 3000);

const store = new Store(dataDir);
const race = new RaceState(store, DEFAULT_RACE_PROFILE);
const clients = new Set();
let serialStatus = { connected: false, port: null, error: null, mode: "starting" };
let reconnectTimer = null;
let reconnectDelayMs = 1000;

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

const wss = new WebSocketServer({ server });
wss.on("connection", ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "state", payload: withSerialStatus(race.snapshot()) }));
  ws.on("close", () => clients.delete(ws));
});

server.listen(port, () => {
  console.log(`Dashboard: http://localhost:${port}`);
  startIngest().catch(error => {
    serialStatus = { connected: false, port: null, error: error.message, mode: "failed" };
    broadcast("status", withSerialStatus(race.snapshot()));
    console.error(error);
  });
});

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, withSerialStatus(race.snapshot()));
  }

  if (req.method === "POST" && url.pathname === "/api/ingest") {
    if (!authorizeIngest(req.headers)) {
      return sendJson(res, 401, { error: "Unauthorized ingest token" });
    }

    const body = await readText(req);
    const normalized = parseIngestBody(body);
    if (!normalized) {
      return sendJson(res, 400, { error: "Invalid telemetry packet" });
    }

    const enriched = ingestTelemetryPacket(race, normalized);
    broadcast("telemetry", {
      record: enriched,
      state: withSerialStatus(race.snapshot())
    });
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run/start") {
    const body = await readJson(req);
    const snapshot = race.start(body);
    broadcast("state", withSerialStatus(snapshot));
    return sendJson(res, 200, withSerialStatus(snapshot));
  }

  if (req.method === "POST" && url.pathname === "/api/run/stop") {
    const snapshot = race.stop();
    broadcast("state", withSerialStatus(snapshot));
    return sendJson(res, 200, withSerialStatus(snapshot));
  }

  if (req.method === "POST" && url.pathname === "/api/run/reset") {
    const snapshot = race.reset();
    broadcast("state", withSerialStatus(snapshot));
    return sendJson(res, 200, withSerialStatus(snapshot));
  }

  if (req.method === "POST" && url.pathname === "/api/calibrate-start-line") {
    const snapshot = race.calibrateStartLine();
    broadcast("state", withSerialStatus(snapshot));
    return sendJson(res, 200, withSerialStatus(snapshot));
  }

  const exportMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/export\.csv$/);
  if (req.method === "GET" && exportMatch) {
    const records = store.readRunRecords(decodeURIComponent(exportMatch[1]));
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${exportMatch[1]}.csv"`
    });
    res.end(recordsToCsv(records));
    return;
  }

  const recordsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/records\.json$/);
  if (req.method === "GET" && recordsMatch) {
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") || 1800)));
    const records = store.readRunRecords(decodeURIComponent(recordsMatch[1])).slice(-limit);
    return sendJson(res, 200, { records });
  }

  if (req.method === "GET") {
    return serveStatic(url.pathname, res);
  }

  sendJson(res, 404, { error: "Not found" });
}

async function startIngest() {
  if (process.env.CLOUD_ONLY === "1") {
    serialStatus = { connected: true, port: "cloud-ingest", error: null, mode: "cloud" };
    broadcast("state", withSerialStatus(race.snapshot()));
    console.log("Cloud ingest mode enabled");
    return;
  }

  if (process.env.EMULATOR === "1") {
    serialStatus = { connected: true, port: "emulator", error: null, mode: "emulator" };
    broadcast("state", withSerialStatus(race.snapshot()));
    startTelemetryEmulator(ingestLine);
    console.log("Telemetry emulator started");
    return;
  }

  if (process.env.REPLAY_FILE) {
    serialStatus = { connected: true, port: process.env.REPLAY_FILE, error: null, mode: "replay" };
    broadcast("state", withSerialStatus(race.snapshot()));
    return replayFile(process.env.REPLAY_FILE);
  }

  await openSerialPort();
}

async function openSerialPort() {
  const serialPort = await resolveSerialPort();
  serialStatus = { connected: false, port: serialPort, error: "Opening serial port", mode: "serial" };
  broadcast("state", withSerialStatus(race.snapshot()));

  const device = new SerialPort({ path: serialPort, baudRate: 115200, autoOpen: false });
  const parser = device.pipe(new ReadlineParser({ delimiter: "\n" }));

  device.on("open", () => {
    reconnectDelayMs = 1000;
    serialStatus = { connected: true, port: serialPort, error: null, mode: "serial" };
    broadcast("state", withSerialStatus(race.snapshot()));
    console.log(`Serial connected: ${serialPort}`);

    // Keep opening the serial device from resetting boards wired through DTR/RTS.
    device.set({ dtr: false, rts: false }, error => {
      if (error) {
        console.warn(`Could not set DTR/RTS inactive: ${error.message}`);
      }
    });
  });
  device.on("error", error => {
    serialStatus = { connected: false, port: serialPort, error: error.message, mode: "serial" };
    broadcast("state", withSerialStatus(race.snapshot()));
    console.error(`Serial error: ${error.message}`);
    scheduleReconnect();
  });
  device.on("close", () => {
    serialStatus = { connected: false, port: serialPort, error: "Serial port closed", mode: "serial" };
    broadcast("state", withSerialStatus(race.snapshot()));
    console.warn(`Serial closed: ${serialPort}`);
    scheduleReconnect();
  });

  parser.on("data", ingestLine);

  device.open(error => {
    if (error) {
      serialStatus = { connected: false, port: serialPort, error: error.message, mode: "serial" };
      broadcast("state", withSerialStatus(race.snapshot()));
      console.error(`Serial open failed: ${error.message}`);
      scheduleReconnect();
    }
  });
}

async function resolveSerialPort() {
  if (process.env.SERIAL_PORT) {
    return process.env.SERIAL_PORT;
  }

  const serialNumber = process.env.SERIAL_NUMBER;
  if (serialNumber) {
    const ports = await SerialPort.list();
    const match = ports.find(port => normalizeSerial(port.serialNumber) === normalizeSerial(serialNumber));
    if (!match) {
      throw new Error(`No USB serial port found with serial number ${serialNumber}.`);
    }
    return match.path;
  }

  return detectSerialPort();
}

function scheduleReconnect() {
  if (reconnectTimer || process.env.REPLAY_FILE) {
    return;
  }

  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10000);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await openSerialPort();
    } catch (error) {
      serialStatus = {
        connected: false,
        port: serialStatus.port,
        error: error.message,
        mode: "serial"
      };
      broadcast("state", withSerialStatus(race.snapshot()));
      console.error(`Serial reconnect failed: ${error.message}`);
      scheduleReconnect();
    }
  }, delay);
}

async function detectSerialPort() {
  const ports = await SerialPort.list();
  const candidates = ports.filter(candidate =>
    candidate.path.includes("usbmodem") || candidate.path.includes("usbserial")
  );
  if (candidates.length === 0) {
    throw new Error("No USB serial port found. Set SERIAL_PORT=/dev/cu.usbmodemXXXX.");
  }
  return candidates[0].path;
}

function ingestLine(line) {
  const parsed = parseBaseStationLine(line);
  if (!parsed) {
    return;
  }

  const normalized = normalizePacket(parsed);
  const enriched = ingestTelemetryPacket(race, normalized);
  broadcast("telemetry", {
    record: enriched,
    state: withSerialStatus(race.snapshot())
  });
}

function normalizeSerial(value) {
  return String(value ?? "").replaceAll(":", "").toLowerCase();
}

async function replayFile(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    ingestLine(line);
    await new Promise(resolve => setTimeout(resolve, Number(process.env.REPLAY_DELAY_MS || 250)));
  }
}

function broadcast(type, payload) {
  const message = JSON.stringify({ type, payload });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}

function withSerialStatus(snapshot) {
  return { ...snapshot, serial: serialStatus };
}

function serveStatic(requestPath, res) {
  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(publicDir, normalized));
  if (!filePath.startsWith(publicDir)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendJson(res, 404, { error: "Not found" });
  }
  res.writeHead(200, { "content-type": mimeType(filePath) });
  fs.createReadStream(filePath).pipe(res);
}

function mimeType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const text = await readText(req);
  return text ? JSON.parse(text) : {};
}

async function readText(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
