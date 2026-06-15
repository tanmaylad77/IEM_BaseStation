# IEM Base Station

LoRa-only ESP32-S3 base station firmware for receiving one-way telemetry from a fully populated TelemetryV2 board.

The hardware is the TelemetryV2 PCB with only the ESP32-S3 microcontroller and SX1278 LoRa module populated. The PlatformIO setup mirrors `tanmaylad77/TelemetryV2` so the transmitter and receiver use the same board profile and dependency versions.

## Behaviour

- Enables the radio power rail.
- Initialises the SX1278 with the same LoRa settings used by TelemetryV2.
- Receives packets continuously.
- Prints one newline-delimited JSON object per received LoRa packet on USB Serial at `115200`.
- Includes RSSI, SNR, frequency error, the raw payload, and parsed telemetry fields when the current `TelemetryV2` key/value packet format is detected.

## Build and Upload

```sh
pio run
pio run --target upload
pio device monitor --baud 115200
```

## Current Radio Settings

| Setting | Value |
| --- | --- |
| Module | SX1278 |
| Frequency | 433.0 MHz |
| Bandwidth | 125.0 kHz |
| Spreading factor | 9 |
| Coding rate | 4/7 |
| Sync word | RadioLib SX127x default |
| Preamble | 8 symbols |

## Serial Output

Example telemetry line:

```json
{"schema":"iem.lora.rx.v1","type":"telemetry","ms":12150,"seq":1,"radio":{"rssi_dbm":-72.5,"snr_db":8.0,"freq_error_hz":112},"payload_format":"telemetryv2_kv_v1","payload_raw":"T=12001,fix=1,lat=5123.45678N,lon=00012.34567W,v=48.20,i=3.10,p=149.4,soc=82,st=1,thr=0.22,w=16.50,valid=0x1FF","fields":{"source_ms":12001,"gps_fix":1,"latitude":5123.45678,"latitude_hemi":"N","longitude":12.34567,"longitude_hemi":"W","pack_voltage_v":48.20,"pack_current_a":3.10,"pack_power_w":149.4,"soc_percent":82,"bms_state":1,"throttle_0_to_1":0.22,"wheel_speed_rad_s":16.50,"valid_flags":511,"valid_flags_hex":"0x1FF"}}
```

Dashboard software can treat the Serial stream as NDJSON: read line by line and parse each line as a JSON object.
