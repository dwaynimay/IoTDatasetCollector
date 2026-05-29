// File: firmware/src/main.cpp

// =============================================================================
// main.cpp — Dataset Collector v1.0 (Standalone WiFi+MQTT)
// =============================================================================
//
// Arsitektur sederhana (tanpa mesh, tanpa compressive sensing):
//   - taskReadIMU  : baca MPU6050 @ 100 Hz, simpan ke g_latestImu
//   - taskReadPPG  : baca MAX30102 @ ~50 Hz, simpan ke g_latestPpg
//   - taskMqttPublish : ambil snapshot IMU+PPG, publish JSON raw ke MQTT
//   - taskMonitor  : health check heap & WiFi
//
// MQTT Topic:
//   health_monitor/node_<ID>/raw
//
// Payload JSON contoh:
//   {"node":1,"ts":123456789,"ax":0.12,"ay":-0.05,"az":9.81,
//    "gx":0.01,"gy":-0.02,"gz":0.00,"ir":45231,"red":30100}
//
// SETUP:
//   1. config/credentials.h → isi SSID, password WiFi, IP broker MQTT
//   2. config/hardware.h    → isi pin I2C sesuai board
//   3. config/features.h    → atur LOG_LEVEL
//   4. Compile & upload
// =============================================================================

#include <Arduino.h>
#include "Config.h"

#include "Watchdog.h"
#include "Sensor_MPU.h"
#include "Sensor_PPG.h"
#include "Network_Mqtt.h"

static constexpr char TAG[] = "MAIN";

// =============================================================================
// Shared State Global
// =============================================================================

portMUX_TYPE       g_stateMux  = portMUX_INITIALIZER_UNLOCKED;
ImuSample          g_latestImu = {};
PpgSample          g_latestPpg = {};

SemaphoreHandle_t  g_wire0Mutex = nullptr;  // Bus 0 — MAX30102 PPG
SemaphoreHandle_t  g_wire1Mutex = nullptr;  // Bus 1 — MPU6050 IMU

static SensorMPU   g_imu;
static SensorPPG   g_ppg;
NetworkMqtt        g_mqtt;

// =============================================================================
// Task: Baca PPG (MAX30102)
// =============================================================================

static void taskReadPPG(void *param)
{
    g_watchdog.registerTask();

    for (;;)
    {
        g_watchdog.feed();

        if (xSemaphoreTake(g_wire0Mutex, pdMS_TO_TICKS(200)) == pdTRUE)
        {
            g_ppg.update();
            xSemaphoreGive(g_wire0Mutex);
        }
        else
        {
            LOG_WARN(TAG, "Wire0 mutex timeout di taskReadPPG");
        }

        PpgSample snap{};
        g_ppg.read(snap);

        taskENTER_CRITICAL(&g_stateMux);
        g_latestPpg = snap;
        taskEXIT_CRITICAL(&g_stateMux);

        vTaskDelay(pdMS_TO_TICKS(20)); // ~50 Hz
    }
}

// =============================================================================
// Task: Baca IMU (MPU6050)
// =============================================================================

static void taskReadIMU(void *param)
{
    g_watchdog.registerTask();

    uint32_t lastReadMs = 0;
    uint8_t  failCount  = 0;

    for (;;)
    {
        g_watchdog.feed();

        if (millis() - lastReadMs >= Timing::IMU_SAMPLE_MS)
        {
            ImuSample snap{};
            bool ok = false;

            if (xSemaphoreTake(g_wire1Mutex, portMAX_DELAY) == pdTRUE)
            {
                ok = g_imu.read(snap);
                xSemaphoreGive(g_wire1Mutex);
            }

            if (ok)
            {
                failCount = 0;
                taskENTER_CRITICAL(&g_stateMux);
                g_latestImu = snap;
                taskEXIT_CRITICAL(&g_stateMux);
            }
            else
            {
                failCount++;
                if (failCount > 50)
                    g_watchdog.triggerRestart("IMU read fail 50x");
            }

            lastReadMs = millis();
        }

        vTaskDelay(pdMS_TO_TICKS(1));
    }
}

// =============================================================================
// Task: Publish raw data ke MQTT
// =============================================================================

static void taskMqttPublish(void *param)
{
    char topic[64];
    char payload[256];

    // Format topic: health_monitor/node_<NODE_ID>/raw
    snprintf(topic, sizeof(topic), "%s/node_%d/raw", Mqtt::TOPIC_BASE, NODE_ID);
    LOG_INFO(TAG, "MQTT publish topic: %s", topic);

    for (;;)
    {
        // Ambil snapshot thread-safe
        ImuSample imu{};
        PpgSample ppg{};

        taskENTER_CRITICAL(&g_stateMux);
        imu = g_latestImu;
        ppg = g_latestPpg;
        taskEXIT_CRITICAL(&g_stateMux);

        // Reconnect jika terputus
        if (!g_mqtt.isConnected())
        {
            LOG_WARN(TAG, "MQTT terputus, mencoba reconnect...");
            g_mqtt.tryReconnect();
            vTaskDelay(pdMS_TO_TICKS(2000));
            continue;
        }

        // Build JSON payload
        int len = snprintf(payload, sizeof(payload),
            "{\"node\":%d,\"ts\":%lu,"
            "\"ax\":%.4f,\"ay\":%.4f,\"az\":%.4f,"
            "\"gx\":%.4f,\"gy\":%.4f,\"gz\":%.4f,"
            "\"ir\":%lu,\"red\":%lu}",
            NODE_ID,
            (unsigned long)imu.timestamp_ms,
            imu.ax, imu.ay, imu.az,
            imu.gx, imu.gy, imu.gz,
            (unsigned long)ppg.ir,
            (unsigned long)ppg.red
        );

        if (len > 0 && len < (int)sizeof(payload))
        {
            bool ok = g_mqtt.publish(topic, payload);
            LOG_EVERY_N(50, LOG_DEBUG, TAG, "Publish %s | ok=%s", topic, ok ? "Y" : "N");
        }

        vTaskDelay(pdMS_TO_TICKS(Timing::SEND_INTERVAL_MS));
    }
}

// =============================================================================
// Task: Monitor kesehatan sistem
// =============================================================================

static void taskMonitor(void *param)
{
    for (;;)
    {
        g_watchdog.healthCheck();
        g_watchdog.checkTaskStack("PPG");
        g_watchdog.checkTaskStack("IMU");
        g_watchdog.checkTaskStack("MQTT_TX");

        const bool wifiOk = g_mqtt.isWifiConnected();
        LOG_INFO(TAG, "heap=%lu KB | WiFi=%s | MQTT=%s",
                 esp_get_free_heap_size() / 1024,
                 wifiOk ? "OK" : "DOWN",
                 g_mqtt.isConnected() ? "OK" : "DOWN");

        if (!wifiOk)
        {
            static uint32_t wifiDownSince = 0;
            if (wifiDownSince == 0) wifiDownSince = millis();
            if (millis() - wifiDownSince > 30000)
                g_watchdog.triggerRestart("WiFi down > 30s");
        }

        vTaskDelay(pdMS_TO_TICKS(HEALTH_CHECK_MS));
    }
}

// =============================================================================
// setup()
// =============================================================================

void setup()
{
    Serial.begin(115200);
    delay(500);

    LOG_INFO(TAG, "================================================");
    LOG_INFO(TAG, "  IoT Dataset Collector v1.0");
    LOG_INFO(TAG, "  Node ID: %d", NODE_ID);
    LOG_INFO(TAG, "  Send interval: %lu ms", (unsigned long)Timing::SEND_INTERVAL_MS);
    LOG_INFO(TAG, "================================================");

    g_watchdog.begin(true);

    // ── I2C Mutex ─────────────────────────────────────────────────────────────
    g_wire0Mutex = xSemaphoreCreateMutex();
    g_wire1Mutex = xSemaphoreCreateMutex();
    if (!g_wire0Mutex || !g_wire1Mutex)
        g_watchdog.triggerRestart("Gagal buat I2C mutex");

    // ── Sensor Init ───────────────────────────────────────────────────────────
    if (!g_imu.begin())
        g_watchdog.triggerRestart("MPU6050 init gagal");

    if (!g_ppg.begin())
        LOG_WARN(TAG, "MAX30102 gagal — lanjut tanpa PPG");

    // ── WiFi + MQTT ───────────────────────────────────────────────────────────
    if (!g_mqtt.begin())
        g_watchdog.triggerRestart("WiFi/MQTT init gagal");

    // ── FreeRTOS Tasks ────────────────────────────────────────────────────────
    xTaskCreatePinnedToCore(taskReadPPG,     "PPG",     StackSize::SENSOR_PPG,
                            nullptr, TaskPrio::SENSOR_PPG, nullptr, 1);
    xTaskCreatePinnedToCore(taskReadIMU,     "IMU",     StackSize::SENSOR_IMU,
                            nullptr, TaskPrio::SENSOR_IMU, nullptr, 1);
    xTaskCreatePinnedToCore(taskMqttPublish, "MQTT_TX", StackSize::MQTT_PUB,
                            nullptr, TaskPrio::MQTT_PUB,   nullptr, 0);
    xTaskCreatePinnedToCore(taskMonitor,     "MONITOR", StackSize::MONITOR,
                            nullptr, TaskPrio::MONITOR,    nullptr, 0);

    LOG_INFO(TAG, "Semua task terdaftar — sistem berjalan");
}

// =============================================================================
// loop() — kosong, semua di FreeRTOS task
// =============================================================================

void loop()
{
    vTaskDelay(pdMS_TO_TICKS(10000));
}