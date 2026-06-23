#include <Arduino.h>
#include <Adafruit_BusIO_Register.h>
#include <HTTPClient.h>
#include <RadioLib.h>
#include <SPI.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <stdlib.h>
#include <string.h>

#if __has_include("secrets.h")
#include "secrets.h"
#endif

#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif

#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif

#ifndef INGEST_URL
#define INGEST_URL ""
#endif

#ifndef INGEST_TOKEN
#define INGEST_TOKEN ""
#endif

#define SERIAL_BAUD 115200

// TelemetryV2 PCB pins. The base station only populates the ESP32-S3 and LoRa
// module, but the radio enable and SPI/LoRa pins are unchanged.
#define LED 37
#define RADIOS_EN 1
#define LORA_INT 47
#define LORA_RST 21
#define LORA_CS 14
#define SPI_MOSI 11
#define SPI_SCK 12
#define SPI_MISO 13

#define LORA_FREQ_MHZ 433.0
#define LORA_BW_KHZ 125.0
#define LORA_SF 9
#define LORA_CR 7
#define LORA_POWER_DBM 10
#define LORA_PREAMBLE_LEN 8
#define LORA_GAIN 0
#define WIFI_RECONNECT_INTERVAL_MS 5000
#define CLOUD_UPLOAD_INTERVAL_MS 1000
#define CLOUD_UPLOAD_TIMEOUT_MS 2500

SX1278 radio = new Module(LORA_CS, LORA_INT, LORA_RST);

static uint32_t packetSequence = 0;
static uint32_t lastWifiAttemptMs = 0;
static uint32_t lastCloudUploadMs = 0;

struct ParsedTelemetryPacket {
  bool matched = false;
  uint32_t sourceMs = 0;
  uint8_t gpsFix = 0;
  float latitude = 0.0f;
  char latitudeHemisphere = '\0';
  float longitude = 0.0f;
  char longitudeHemisphere = '\0';
  float packVoltageV = 0.0f;
  float packCurrentA = 0.0f;
  float packPowerW = 0.0f;
  uint8_t socPercent = 255;
  uint8_t bmsState = 0;
  float throttle = 0.0f;
  float wheelSpeedRadS = 0.0f;
  uint16_t validFlags = 0;
};

static String jsonEscape(const String &value) {
  String escaped;
  escaped.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];
    switch (c) {
      case '"':
        escaped += "\\\"";
        break;
      case '\\':
        escaped += "\\\\";
        break;
      case '\b':
        escaped += "\\b";
        break;
      case '\f':
        escaped += "\\f";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        if ((uint8_t)c < 0x20) {
          char buffer[7];
          snprintf(buffer, sizeof(buffer), "\\u%04X", c);
          escaped += buffer;
        } else {
          escaped += c;
        }
        break;
    }
  }
  return escaped;
}

static bool parseHemisphereValue(const char *value, float &number, char &hemisphere) {
  size_t len = strlen(value);
  if (len < 2) {
    return false;
  }

  char suffix = value[len - 1];
  if (suffix != 'N' && suffix != 'S' && suffix != 'E' && suffix != 'W') {
    return false;
  }

  char numeric[20];
  size_t numericLen = min(len - 1, sizeof(numeric) - 1);
  memcpy(numeric, value, numericLen);
  numeric[numericLen] = '\0';

  char *end = nullptr;
  float parsed = strtof(numeric, &end);
  if (end == numeric || *end != '\0') {
    return false;
  }

  number = parsed;
  hemisphere = suffix;
  return true;
}

static bool startsWithTelemetryV2Shape(const String &payload) {
  return payload.startsWith("T=") && payload.indexOf(",fix=") > 0 && payload.indexOf(",valid=") > 0;
}

static ParsedTelemetryPacket parseTelemetryPacket(const String &payload) {
  ParsedTelemetryPacket parsed;
  if (!startsWithTelemetryV2Shape(payload)) {
    return parsed;
  }

  char buffer[220];
  payload.toCharArray(buffer, sizeof(buffer));

  char *savePtr = nullptr;
  for (char *token = strtok_r(buffer, ",", &savePtr); token != nullptr; token = strtok_r(nullptr, ",", &savePtr)) {
    char *equals = strchr(token, '=');
    if (equals == nullptr) {
      continue;
    }

    *equals = '\0';
    const char *key = token;
    const char *value = equals + 1;

    if (strcmp(key, "T") == 0) {
      parsed.sourceMs = strtoul(value, nullptr, 10);
    } else if (strcmp(key, "fix") == 0) {
      parsed.gpsFix = (uint8_t)strtoul(value, nullptr, 10);
    } else if (strcmp(key, "lat") == 0) {
      parseHemisphereValue(value, parsed.latitude, parsed.latitudeHemisphere);
    } else if (strcmp(key, "lon") == 0) {
      parseHemisphereValue(value, parsed.longitude, parsed.longitudeHemisphere);
    } else if (strcmp(key, "v") == 0) {
      parsed.packVoltageV = strtof(value, nullptr);
    } else if (strcmp(key, "i") == 0) {
      parsed.packCurrentA = strtof(value, nullptr);
    } else if (strcmp(key, "p") == 0) {
      parsed.packPowerW = strtof(value, nullptr);
    } else if (strcmp(key, "soc") == 0) {
      parsed.socPercent = (uint8_t)strtoul(value, nullptr, 10);
    } else if (strcmp(key, "st") == 0) {
      parsed.bmsState = (uint8_t)strtoul(value, nullptr, 10);
    } else if (strcmp(key, "thr") == 0) {
      parsed.throttle = strtof(value, nullptr);
    } else if (strcmp(key, "w") == 0) {
      parsed.wheelSpeedRadS = strtof(value, nullptr);
    } else if (strcmp(key, "valid") == 0) {
      parsed.validFlags = (uint16_t)strtoul(value, nullptr, 0);
    }
  }

  parsed.matched = true;
  return parsed;
}

static void printStatusEvent(const char *event, int code = RADIOLIB_ERR_NONE) {
  Serial.print("{\"schema\":\"iem.base.status.v1\",\"type\":\"status\",\"ms\":");
  Serial.print(millis());
  Serial.print(",\"event\":\"");
  Serial.print(event);
  Serial.print("\"");
  if (code != RADIOLIB_ERR_NONE) {
    Serial.print(",\"code\":");
    Serial.print(code);
  }
  Serial.println("}");
}

static String formatReceiveEvent(const String &payload) {
  ParsedTelemetryPacket parsed = parseTelemetryPacket(payload);
  String event;
  event.reserve(360);

  event += "{\"schema\":\"iem.lora.rx.v1\",\"type\":\"telemetry\",\"ms\":";
  event += String(millis());
  event += ",\"seq\":";
  event += String(++packetSequence);
  event += ",\"radio\":{\"rssi_dbm\":";
  event += String(radio.getRSSI(), 1);
  event += ",\"snr_db\":";
  event += String(radio.getSNR(), 1);
  event += ",\"freq_error_hz\":";
  event += String(radio.getFrequencyError());
  event += "},\"payload_format\":\"";
  event += parsed.matched ? "telemetryv2_kv_v1" : "raw";
  event += "\",\"payload_raw\":\"";
  event += jsonEscape(payload);
  event += "\"";

  if (parsed.matched) {
    char fields[420];
    snprintf(fields, sizeof(fields),
             ",\"fields\":{\"source_ms\":%lu,\"gps_fix\":%u,\"latitude\":%.5f,\"latitude_hemi\":\"%c\","
             "\"longitude\":%.5f,\"longitude_hemi\":\"%c\",\"pack_voltage_v\":%.2f,\"pack_current_a\":%.2f,"
             "\"pack_power_w\":%.1f,\"soc_percent\":%u,\"bms_state\":%u,\"throttle_0_to_1\":%.2f,"
             "\"wheel_speed_rad_s\":%.2f,\"valid_flags\":%u,\"valid_flags_hex\":\"0x%03X\"}",
             parsed.sourceMs,
             parsed.gpsFix,
             parsed.latitude,
             parsed.latitudeHemisphere ? parsed.latitudeHemisphere : 'N',
             parsed.longitude,
             parsed.longitudeHemisphere ? parsed.longitudeHemisphere : 'E',
             parsed.packVoltageV,
             parsed.packCurrentA,
             parsed.packPowerW,
             parsed.socPercent,
             parsed.bmsState,
             parsed.throttle,
             parsed.wheelSpeedRadS,
             parsed.validFlags,
             parsed.validFlags);
    event += fields;
  }

  event += "}";
  return event;
}

static void setupPins() {
  pinMode(LED, OUTPUT);
  pinMode(RADIOS_EN, OUTPUT);
  pinMode(LORA_CS, OUTPUT);
  pinMode(LORA_INT, INPUT);

  digitalWrite(LED, LOW);
  digitalWrite(RADIOS_EN, HIGH);
  digitalWrite(LORA_CS, HIGH);
}

static void setupLoRa() {
  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI, LORA_CS);
  SPI.setFrequency(4000000);

  int state = radio.begin(
      LORA_FREQ_MHZ,
      LORA_BW_KHZ,
      LORA_SF,
      LORA_CR,
      RADIOLIB_SX127X_SYNC_WORD,
      LORA_POWER_DBM,
      LORA_PREAMBLE_LEN,
      LORA_GAIN);

  if (state != RADIOLIB_ERR_NONE) {
    printStatusEvent("radio_init_failed", state);
    while (true) {
      digitalWrite(LED, !digitalRead(LED));
      delay(250);
    }
  }

  printStatusEvent("radio_ready");
}

static bool hasCloudConfig() {
  return strlen(WIFI_SSID) > 0 && strlen(INGEST_URL) > 0 && strlen(INGEST_TOKEN) > 0;
}

static void setupWiFi() {
  if (!hasCloudConfig()) {
    printStatusEvent("cloud_upload_disabled");
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiAttemptMs = millis();
  printStatusEvent("wifi_connecting");
}

static void maintainWiFi() {
  if (!hasCloudConfig() || WiFi.status() == WL_CONNECTED) {
    return;
  }

  if (millis() - lastWifiAttemptMs >= WIFI_RECONNECT_INTERVAL_MS) {
    lastWifiAttemptMs = millis();
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    printStatusEvent("wifi_reconnecting");
  }
}

static void uploadTelemetry(const String &event) {
  if (!hasCloudConfig()) {
    return;
  }

  if (millis() - lastCloudUploadMs < CLOUD_UPLOAD_INTERVAL_MS) {
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    maintainWiFi();
    return;
  }

  lastCloudUploadMs = millis();

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(CLOUD_UPLOAD_TIMEOUT_MS);
  if (!http.begin(client, INGEST_URL)) {
    printStatusEvent("cloud_http_begin_failed");
    return;
  }

  http.addHeader("content-type", "application/json");
  http.addHeader("x-ingest-token", INGEST_TOKEN);
  int status = http.POST((uint8_t *)event.c_str(), event.length());

  if (status < 200 || status >= 300) {
    Serial.print("{\"schema\":\"iem.base.status.v1\",\"type\":\"status\",\"ms\":");
    Serial.print(millis());
    Serial.print(",\"event\":\"cloud_upload_failed\",\"code\":");
    Serial.print(status);
    Serial.println("}");
  }

  http.end();
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(2000);

  setupPins();
  printStatusEvent("boot");
  setupLoRa();
  setupWiFi();
}

void loop() {
  maintainWiFi();

  String payload;
  int state = radio.receive(payload);

  if (state == RADIOLIB_ERR_NONE) {
    digitalWrite(LED, HIGH);
    String event = formatReceiveEvent(payload);
    Serial.println(event);
    uploadTelemetry(event);
    digitalWrite(LED, LOW);
  } else if (state != RADIOLIB_ERR_RX_TIMEOUT) {
    printStatusEvent("receive_failed", state);
    delay(50);
  }
}
