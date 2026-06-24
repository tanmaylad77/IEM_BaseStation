import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { parseBaseStationLine } from "./telemetry.js";

const DEFAULT_INGEST_URL = "https://iem-base-station-dashboard.onrender.com/api/ingest";

export function bridgeConfigFromEnv(env = process.env) {
  return {
    ingestUrl: env.CLOUD_INGEST_URL || env.INGEST_URL || DEFAULT_INGEST_URL,
    ingestToken: env.INGEST_TOKEN || "",
    serialPort: env.SERIAL_PORT || "",
    serialNumber: env.SERIAL_NUMBER || "",
    baudRate: Number(env.SERIAL_BAUD || 115200),
    replayFile: env.BRIDGE_REPLAY_FILE || "",
    replayDelayMs: Number(env.BRIDGE_REPLAY_DELAY_MS || 250),
    maxUploadAttempts: Number(env.BRIDGE_UPLOAD_ATTEMPTS || 3)
  };
}

export function parseBridgeLine(line) {
  return parseBaseStationLine(line);
}

export async function uploadPacket(packet, config, fetchImpl = fetch) {
  const headers = { "content-type": "application/json" };
  if (config.ingestToken) {
    headers["x-ingest-token"] = config.ingestToken;
  }

  const response = await fetchImpl(config.ingestUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(packet)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Cloud ingest rejected packet: HTTP ${response.status}${body ? ` ${body}` : ""}`);
  }
}

export class SerialCloudBridge {
  constructor(config = bridgeConfigFromEnv()) {
    this.config = config;
    this.device = null;
    this.reconnectTimer = null;
    this.reconnectDelayMs = 1000;
    this.uploadQueue = Promise.resolve();
    this.stats = {
      received: 0,
      uploaded: 0,
      ignored: 0,
      failed: 0
    };
  }

  async start() {
    if (!this.config.ingestUrl) {
      throw new Error("Set CLOUD_INGEST_URL or INGEST_URL.");
    }
    if (!this.config.ingestToken) {
      console.warn("INGEST_TOKEN is not set; upload will only work if the server allows anonymous ingest.");
    }

    if (this.config.replayFile) {
      await this.replayFile(this.config.replayFile);
      return;
    }

    await this.openSerialPort();
  }

  async stop() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.device?.isOpen) {
      await new Promise(resolve => this.device.close(() => resolve()));
    }
  }

  async openSerialPort() {
    const serialPort = await this.resolveSerialPort();
    console.log(`Opening serial bridge on ${serialPort} at ${this.config.baudRate} baud`);

    const device = new SerialPort({ path: serialPort, baudRate: this.config.baudRate, autoOpen: false });
    const parser = device.pipe(new ReadlineParser({ delimiter: "\n" }));
    this.device = device;

    device.on("open", () => {
      this.reconnectDelayMs = 1000;
      console.log(`Serial bridge connected: ${serialPort}`);
      device.set({ dtr: false, rts: false }, error => {
        if (error) {
          console.warn(`Could not set DTR/RTS inactive: ${error.message}`);
        }
      });
    });

    device.on("error", error => {
      console.error(`Serial bridge error: ${error.message}`);
      this.scheduleReconnect();
    });

    device.on("close", () => {
      console.warn(`Serial bridge closed: ${serialPort}`);
      this.scheduleReconnect();
    });

    parser.on("data", line => this.handleLine(line));

    device.open(error => {
      if (error) {
        console.error(`Serial bridge open failed: ${error.message}`);
        this.scheduleReconnect();
      }
    });
  }

  async resolveSerialPort() {
    if (this.config.serialPort) {
      return this.config.serialPort;
    }

    if (this.config.serialNumber) {
      const ports = await SerialPort.list();
      const match = ports.find(port => normalizeSerial(port.serialNumber) === normalizeSerial(this.config.serialNumber));
      if (!match) {
        throw new Error(`No USB serial port found with serial number ${this.config.serialNumber}.`);
      }
      return match.path;
    }

    const ports = await SerialPort.list();
    const candidates = ports.filter(candidate =>
      candidate.path.includes("usbmodem") || candidate.path.includes("usbserial")
    );
    if (candidates.length === 0) {
      throw new Error("No USB serial port found. Set SERIAL_PORT=/dev/cu.usbmodemXXXX.");
    }
    return candidates[0].path;
  }

  handleLine(line) {
    const packet = parseBridgeLine(line);
    if (!packet) {
      this.stats.ignored += 1;
      return;
    }

    this.stats.received += 1;
    this.uploadQueue = this.uploadQueue
      .then(() => this.uploadWithRetry(packet))
      .catch(error => {
        this.stats.failed += 1;
        console.error(error.message);
      });
  }

  async uploadWithRetry(packet) {
    const attempts = Math.max(1, this.config.maxUploadAttempts);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await uploadPacket(packet, this.config);
        this.stats.uploaded += 1;
        console.log(`Uploaded packet seq=${packet.seq ?? "?"} rssi=${packet.radio?.rssi_dbm ?? "?"}dBm`);
        return;
      } catch (error) {
        if (attempt === attempts) {
          throw error;
        }
        const delayMs = 500 * 2 ** (attempt - 1);
        console.warn(`Upload failed (${error.message}); retrying in ${delayMs}ms`);
        await sleep(delayMs);
      }
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.config.replayFile) {
      return;
    }

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 10000);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.openSerialPort();
      } catch (error) {
        console.error(`Serial bridge reconnect failed: ${error.message}`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  async replayFile(file) {
    console.log(`Replaying ${file} to ${this.config.ingestUrl}`);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      this.handleLine(line);
      await sleep(this.config.replayDelayMs);
    }
    await this.uploadQueue;
    console.log(`Replay complete: ${this.stats.uploaded} uploaded, ${this.stats.ignored} ignored, ${this.stats.failed} failed`);
  }
}

function normalizeSerial(value) {
  return String(value ?? "").replaceAll(":", "").toLowerCase();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bridge = new SerialCloudBridge();
  process.on("SIGINT", async () => {
    await bridge.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await bridge.stop();
    process.exit(0);
  });

  bridge.start().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
