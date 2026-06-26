import { DEFAULT_RACE_PROFILE } from "./config.js";
import {
  computeTargetDelta,
  createStartLineFromRecentPoints,
  detectLapCrossing,
  hasValidGps,
  integrateWh
} from "./telemetry.js";

export class RaceState {
  constructor(store, profile = DEFAULT_RACE_PROFILE) {
    this.store = store;
    this.profile = profile;
    this.recentGps = [];
    this.lastPacket = null;
    this.load();
  }

  load() {
    const saved = this.store.loadState();
    this.state = {
      active: false,
      currentRunId: null,
      startedAtMs: null,
      stoppedAtMs: null,
      targetFinishS: this.profile.defaultTargetFinishS,
      energyBudgetWh: this.profile.defaultEnergyBudgetWh,
      aggregateWh: 0,
      lap: 0,
      lapTimes: [],
      lastCrossingMs: null,
      startLine: null,
      latest: null,
      ...saved
    };
  }

  snapshot() {
    return {
      profile: this.profile,
      race: this.state,
      recentGpsCount: this.recentGps.length
    };
  }

  start({ targetFinishS, energyBudgetWh } = {}) {
    const now = Date.now();
    this.state.active = true;
    this.state.currentRunId = `run-${new Date(now).toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z")}`;
    this.state.startedAtMs = now;
    this.state.stoppedAtMs = null;
    this.state.targetFinishS = validPositive(targetFinishS) ?? this.profile.defaultTargetFinishS;
    this.state.energyBudgetWh = validPositive(energyBudgetWh) ?? this.profile.defaultEnergyBudgetWh;
    this.state.aggregateWh = 0;
    this.state.lap = 0;
    this.state.lapTimes = [];
    this.state.lastCrossingMs = null;
    this.state.latest = null;
    this.lastPacket = null;
    this.store.clearRun(this.state.currentRunId);
    this.persist();
    return this.snapshot();
  }

  stop() {
    this.state.active = false;
    this.state.stoppedAtMs = Date.now();
    this.persist();
    return this.snapshot();
  }

  reset() {
    const startLine = this.state.startLine;
    this.state = {
      active: false,
      currentRunId: null,
      startedAtMs: null,
      stoppedAtMs: null,
      targetFinishS: this.profile.defaultTargetFinishS,
      energyBudgetWh: this.profile.defaultEnergyBudgetWh,
      aggregateWh: 0,
      lap: 0,
      lapTimes: [],
      lastCrossingMs: null,
      startLine,
      latest: null
    };
    this.lastPacket = null;
    this.persist();
    return this.snapshot();
  }

  calibrateStartLine() {
    this.state.startLine = createStartLineFromRecentPoints(this.recentGps);
    this.persist();
    return this.snapshot();
  }

  ingest(packet) {
    this.store.appendPacket(packet);
    if (hasValidGps(packet)) {
      this.recentGps.push(packet);
      this.recentGps = this.recentGps.slice(-20);
    }

    const enriched = this.enrich(packet);
    this.state.latest = enriched;
    if (this.state.active && this.state.currentRunId) {
      this.store.appendRunRecord(this.state.currentRunId, enriched);
    }
    this.lastPacket = packet;
    this.persist();
    return enriched;
  }

  enrich(packet) {
    const elapsedS = this.state.active && this.state.startedAtMs
      ? Math.max(0, (packet.received_at_ms - this.state.startedAtMs) / 1000)
      : 0;

    if (this.state.active) {
      this.state.aggregateWh = integrateWh(this.lastPacket, packet, this.state.aggregateWh);
      if (detectLapCrossing(this.state.startLine, this.lastPacket, packet, this.state.lastCrossingMs)) {
        this.state.lap += 1;
        this.state.lastCrossingMs = packet.received_at_ms;
        this.state.lapTimes.push({
          lap: this.state.lap,
          elapsed_s: elapsedS,
          lap_time_s: this.state.lapTimes.length
            ? elapsedS - this.state.lapTimes.at(-1).elapsed_s
            : elapsedS
        });
      }
    }

    const target = computeTargetDelta(elapsedS, this.state.lap, this.state.targetFinishS, this.profile.requiredLaps);

    return {
      run_id: this.state.currentRunId,
      ...packet,
      lap: this.state.lap,
      elapsed_s: round(elapsedS, 3),
      target_elapsed_s: round(target.targetElapsedS, 3),
      delta_s: round(target.deltaS, 3),
      predicted_finish_s: target.predictedFinishS === null ? null : round(target.predictedFinishS, 3),
      required_average_lap_s: round(target.requiredAverageLapS, 3),
      aggregate_wh: round(this.state.aggregateWh, 6),
      energy_budget_wh: this.state.energyBudgetWh
    };
  }

  persist() {
    this.store.saveState(this.state);
  }
}

function validPositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function round(value, places) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
