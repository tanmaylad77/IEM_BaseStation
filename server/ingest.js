import { normalizePacket, parseBaseStationLine } from "./telemetry.js";

export function authorizeIngest(headers, expectedToken = process.env.INGEST_TOKEN) {
  if (!expectedToken) {
    return true;
  }
  return headers["x-ingest-token"] === expectedToken;
}

export function parseIngestBody(body) {
  const packet = typeof body === "string" ? parseBaseStationLine(body) : parseBaseStationLine(JSON.stringify(body));
  if (!packet) {
    return null;
  }
  return normalizePacket(packet);
}

export function ingestTelemetryPacket(race, normalizedPacket) {
  return race.ingest(normalizedPacket);
}
