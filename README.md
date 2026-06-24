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

## Live Dashboard

Install dependencies once:

```sh
npm install
```

Run against the connected base-station receiver:

```sh
SERIAL_PORT=/dev/cu.usbmodemXXXX npm start
```

For race use, prefer selecting the receiver by USB serial number so reconnects survive path changes:

```sh
SERIAL_NUMBER=D0CF133991B4 npm start
```

Open `http://localhost:3000`.

### Public Race-Day Access

The dashboard runs on the trackside laptop because it needs USB serial access to the receiver. To let multiple people view it from phones or laptops, expose the local dashboard with a temporary Cloudflare Quick Tunnel.

Install Cloudflare Tunnel once if it is not already installed:

```sh
brew install cloudflared
```

Race-day flow:

```sh
SERIAL_NUMBER=D0CF133991B4 npm start
```

In a second terminal:

```sh
npm run tunnel:cloudflare
```

Copy the generated `https://*.trycloudflare.com` URL and share it with the team. Anyone with the link can view the dashboard; there is no login in v1, and operator controls are visible, so only share the link with trusted people.

Fallbacks:

```sh
npm run tunnel:ngrok
```

If internet access is unreliable, keep everyone on the same Wi-Fi/hotspot and open:

```text
http://<trackside-laptop-ip>:3000
```

For UI testing without hardware:

```sh
REPLAY_FILE=test/fixtures/base-station-sample.ndjson npm start
```

For a continuously updating dashboard without hardware:

```sh
npm run start:emulator
```

The dashboard stores packets under `data/`, streams live updates over WebSocket, and exports each run as CSV from the dashboard export button or `GET /api/runs/:id/export.csv`.

## Optional Cloud Ingest Server

The receiver firmware is serial-only. It does not join Wi-Fi or upload directly to the cloud.

The Node app has an optional cloud-ingest mode for the serial-to-cloud bridge. To deploy that server on Render, the included `render.yaml` uses:

```text
Build command: npm install
Start command: npm run start:cloud
```

Set these Render environment variables:

```text
NODE_ENV=production
CLOUD_ONLY=1
INGEST_TOKEN=<long-random-secret>
```

External clients can upload telemetry to:

```text
https://<your-render-service>.onrender.com/api/ingest
```

`POST /api/ingest` requires:

```text
content-type: application/json
x-ingest-token: <same INGEST_TOKEN>
```

Responses:

```text
204 success
400 invalid telemetry packet
401 missing or wrong ingest token
```

### Serial-to-Cloud Bridge

Use this when the public Render dashboard should be the shared race dashboard. The laptop owns the receiver USB serial port and forwards valid LoRa packets to the cloud server.

```sh
INGEST_TOKEN=<same-token-as-render> \
SERIAL_NUMBER=D0CF133991B4 \
CLOUD_INGEST_URL=https://iem-base-station-dashboard.onrender.com/api/ingest \
npm run bridge:cloud
```

Open the public dashboard:

```text
https://iem-base-station-dashboard.onrender.com
```

The bridge ignores ESP32 boot/status noise, uploads only `iem.lora.rx.v1` telemetry lines, retries short cloud failures, and reconnects if the receiver serial port drops.

For a no-hardware bridge test:

```sh
INGEST_TOKEN=<same-token-as-render> \
BRIDGE_REPLAY_FILE=test/fixtures/base-station-sample.ndjson \
BRIDGE_REPLAY_DELAY_MS=50 \
npm run bridge:cloud
```

Only one process can read the receiver serial port at a time. For cloud sharing, run `npm run bridge:cloud` and view the Render dashboard. For purely local operation, run `npm start` instead.

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
