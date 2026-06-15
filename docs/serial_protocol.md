# Serial Protocol

The base station emits newline-delimited JSON over USB Serial at `115200` baud.

## Status Events

```json
{"schema":"iem.base.status.v1","type":"status","ms":2140,"event":"radio_ready"}
```

`event` values currently used:

- `boot`
- `radio_ready`
- `radio_init_failed`
- `receive_failed`

RadioLib error codes are included as `code` when relevant.

## Telemetry Events

```json
{"schema":"iem.lora.rx.v1","type":"telemetry","ms":12150,"seq":1,"radio":{"rssi_dbm":-72.5,"snr_db":8.0,"freq_error_hz":112},"payload_format":"telemetryv2_kv_v1","payload_raw":"T=12001,fix=1,lat=5123.45678N,lon=00012.34567W,v=48.20,i=3.10,p=149.4,soc=82,st=1,thr=0.22,w=16.50,valid=0x1FF","fields":{"source_ms":12001,"gps_fix":1,"latitude":5123.45678,"latitude_hemi":"N","longitude":12.34567,"longitude_hemi":"W","pack_voltage_v":48.20,"pack_current_a":3.10,"pack_power_w":149.4,"soc_percent":82,"bms_state":1,"throttle_0_to_1":0.22,"wheel_speed_rad_s":16.50,"valid_flags":511,"valid_flags_hex":"0x1FF"}}
```

Notes:

- `schema` is versioned so dashboard parsers can branch cleanly later.
- `seq` is a base-station-local packet counter.
- `ms` is base-station uptime from `millis()`.
- `payload_raw` is always present for forward compatibility.
- `fields` is present only when the packet matches the current TelemetryV2 key/value payload shape.
- Unknown future payloads still produce telemetry records with `payload_format:"raw"`.
