import fs from "node:fs";
import path from "node:path";

export class Store {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.runsDir = path.join(rootDir, "runs");
    this.packetsPath = path.join(rootDir, "packets.ndjson");
    this.statePath = path.join(rootDir, "state.json");
    fs.mkdirSync(this.runsDir, { recursive: true });
  }

  appendPacket(packet) {
    fs.appendFileSync(this.packetsPath, JSON.stringify(packet) + "\n");
  }

  appendRunRecord(runId, record) {
    fs.appendFileSync(this.runPath(runId), JSON.stringify(record) + "\n");
  }

  readRunRecords(runId) {
    const file = this.runPath(runId);
    if (!fs.existsSync(file)) {
      return [];
    }
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }

  saveState(state) {
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }

  loadState() {
    if (!fs.existsSync(this.statePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
  }

  clearRun(runId) {
    const file = this.runPath(runId);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
    }
  }

  runPath(runId) {
    return path.join(this.runsDir, `${safeName(runId)}.ndjson`);
  }
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_");
}
