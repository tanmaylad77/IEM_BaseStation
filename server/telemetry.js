const EARTH_RADIUS_M = 6371000;

export function parseBaseStationLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (parsed.schema !== "iem.lora.rx.v1" || parsed.type !== "telemetry" || !parsed.fields) {
    return null;
  }

  return parsed;
}

export function nmeaToDecimal(value, hemisphere) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const abs = Math.abs(value);
  const degrees = Math.floor(abs / 100);
  const minutes = abs - degrees * 100;
  if (minutes < 0 || minutes >= 60) {
    return null;
  }

  let decimal = degrees + minutes / 60;
  if (hemisphere === "S" || hemisphere === "W" || value < 0) {
    decimal *= -1;
  }
  return decimal;
}

export function normalizePacket(packet, receivedAtMs = Date.now()) {
  const fields = packet.fields ?? {};
  const voltage = numberOrNull(fields.pack_voltage_v);
  const current = numberOrNull(fields.pack_current_a);
  const packetPower = numberOrNull(fields.pack_power_w);
  const fallbackPower = voltage !== null && current !== null ? voltage * current : null;
  const power = packetPower !== null ? packetPower : fallbackPower;
  const latitude = nmeaToDecimal(numberOrNull(fields.latitude), fields.latitude_hemi);
  const longitude = nmeaToDecimal(numberOrNull(fields.longitude), fields.longitude_hemi);

  return {
    received_at_ms: receivedAtMs,
    source_ms: integerOrNull(fields.source_ms),
    seq: integerOrNull(packet.seq),
    pack_voltage_v: voltage,
    pack_current_a: current,
    pack_power_w: power,
    soc_percent: integerOrNull(fields.soc_percent),
    bms_state: integerOrNull(fields.bms_state),
    throttle_0_to_1: numberOrNull(fields.throttle_0_to_1),
    wheel_speed_rad_s: numberOrNull(fields.wheel_speed_rad_s),
    gps_fix: integerOrNull(fields.gps_fix),
    latitude,
    longitude,
    rssi_dbm: numberOrNull(packet.radio?.rssi_dbm),
    snr_db: numberOrNull(packet.radio?.snr_db),
    freq_error_hz: numberOrNull(packet.radio?.freq_error_hz),
    valid_flags: integerOrNull(fields.valid_flags),
    payload_raw: packet.payload_raw ?? ""
  };
}

export function integrateWh(previousRecord, currentRecord, currentAggregateWh) {
  if (!previousRecord || !Number.isFinite(currentRecord.pack_power_w)) {
    return currentAggregateWh;
  }

  const dtS = (currentRecord.received_at_ms - previousRecord.received_at_ms) / 1000;
  if (!Number.isFinite(dtS) || dtS <= 0 || dtS > 5) {
    return currentAggregateWh;
  }

  const previousPower = Number.isFinite(previousRecord.pack_power_w) ? previousRecord.pack_power_w : currentRecord.pack_power_w;
  const positiveAverageW = Math.max(0, (previousPower + currentRecord.pack_power_w) / 2);
  return currentAggregateWh + (positiveAverageW * dtS) / 3600;
}

export function computeTargetDelta(elapsedS, lap, targetFinishS, requiredLaps) {
  if (!Number.isFinite(elapsedS) || !Number.isFinite(lap) || lap <= 0) {
    return {
      targetElapsedS: 0,
      deltaS: 0,
      predictedFinishS: null,
      requiredAverageLapS: targetFinishS / requiredLaps
    };
  }

  const targetElapsedS = (targetFinishS / requiredLaps) * Math.min(lap, requiredLaps);
  const deltaS = elapsedS - targetElapsedS;
  const predictedFinishS = elapsedS / Math.min(lap, requiredLaps) * requiredLaps;
  return {
    targetElapsedS,
    deltaS,
    predictedFinishS,
    requiredAverageLapS: targetFinishS / requiredLaps
  };
}

export function createStartLineFromRecentPoints(points) {
  const valid = points.filter(point => point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
  if (valid.length === 0) {
    throw new Error("No recent GPS points available for calibration");
  }

  const origin = valid.at(-1);
  const previous = valid.length > 1 ? valid.at(-2) : null;
  const headingDeg = previous ? bearingDegrees(previous, origin) : 0;
  return {
    latitude: origin.latitude,
    longitude: origin.longitude,
    heading_deg: headingDeg,
    calibrated_at_ms: Date.now()
  };
}

export function detectLapCrossing(startLine, previousRecord, currentRecord, lastCrossingMs) {
  if (!startLine || !previousRecord || !currentRecord) {
    return false;
  }
  if (!Number.isFinite(previousRecord.latitude) || !Number.isFinite(previousRecord.longitude)) {
    return false;
  }
  if (!Number.isFinite(currentRecord.latitude) || !Number.isFinite(currentRecord.longitude)) {
    return false;
  }
  if (lastCrossingMs && currentRecord.received_at_ms - lastCrossingMs < 15000) {
    return false;
  }

  const prevSide = signedDistanceAlongTrackM(startLine, previousRecord);
  const nextSide = signedDistanceAlongTrackM(startLine, currentRecord);
  return prevSide < 0 && nextSide >= 0;
}

export function signedDistanceAlongTrackM(startLine, point) {
  const origin = latLonToLocal(startLine, point);
  const headingRad = (startLine.heading_deg * Math.PI) / 180;
  const unitX = Math.sin(headingRad);
  const unitY = Math.cos(headingRad);
  return origin.x * unitX + origin.y * unitY;
}

function latLonToLocal(origin, point) {
  const lat0 = (origin.latitude * Math.PI) / 180;
  const dLat = ((point.latitude - origin.latitude) * Math.PI) / 180;
  const dLon = ((point.longitude - origin.longitude) * Math.PI) / 180;
  return {
    x: dLon * Math.cos(lat0) * EARTH_RADIUS_M,
    y: dLat * EARTH_RADIUS_M
  };
}

function bearingDegrees(from, to) {
  const lat1 = (from.latitude * Math.PI) / 180;
  const lat2 = (to.latitude * Math.PI) / 180;
  const dLon = ((to.longitude - from.longitude) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : Number.isFinite(number) ? Math.round(number) : null;
}
