#pragma once
// =============================================================================
// config/tuning.h — PARAMETER PERFORMA & TIMING
// =============================================================================
// File ini untuk menyetel performa sistem.
//
// ⚠️  Perubahan di sini bisa memengaruhi stabilitas — ubah satu per satu
//     dan test setelah setiap perubahan.
//
// Dataset Collector: tidak ada mesh topology atau ESP-NOW queue.
// =============================================================================

#include <Arduino.h>

// ---------------------------------------------------------------------------
// SEND INTERVAL — Seberapa sering sensor mengirim data ke gateway
//
//   100ms = 10 Hz  → resolusi tinggi, cocok untuk deteksi gerakan/gesture
//   200ms =  5 Hz  → balance antara detail dan beban jaringan (default)
//   500ms =  2 Hz  → monitoring santai (postur, SpO2 jangka panjang)
//
// ---------------------------------------------------------------------------
namespace Timing
{
    constexpr uint32_t SEND_INTERVAL_MS = 200;

    // Internal — jangan diubah kecuali ada alasan hardware
    constexpr uint32_t PPG_POLL_MS = 0;         // PPG polling secepat mungkin
    constexpr uint32_t IMU_SAMPLE_MS = 10;      // 100 Hz internal IMU
    constexpr uint32_t MQTT_PUBLISH_MS = 500;   // timeout tunggu queue
    constexpr uint32_t WIFI_TIMEOUT_MS = 10000; // batas waktu konek WiFi
    constexpr uint32_t HEARTBEAT_MS = 30000;    // interval heartbeat node → gateway
    constexpr uint32_t TIME_SYNC_MS = 60000;    // 1 menit sekali gateway kirim sync
}

// ---------------------------------------------------------------------------
// WATCHDOG THRESHOLD
//
// MIN_FREE_HEAP_KB: restart otomatis jika heap di bawah nilai ini.
//   Gateway normal: 8–12 KB tersisa (WiFi + MQTT + ESP-NOW makan banyak RAM)
//   Sensor normal: 50–80 KB tersisa
//
// Threshold sudah disesuaikan per-role di Watchdog.h — parameter ini
// hanya untuk referensi dokumentasi.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FREERTOS TASK PRIORITY (1 = terendah, 24 = tertinggi di ESP32)
//
// Urutan prioritas:
//   PPG (4) > IMU (3) > MQTT_TX (2) > MONITOR (1)
//
// PPG butuh polling cepat agar tidak kehilangan beat → prioritas tertinggi.
// Jangan set semua ke prioritas sama — FreeRTOS butuh hierarki.
// ---------------------------------------------------------------------------
namespace TaskPrio
{
    constexpr uint8_t SENSOR_PPG = 4;
    constexpr uint8_t SENSOR_IMU = 3;
    constexpr uint8_t MQTT_PUB   = 2;
    constexpr uint8_t MONITOR    = 1;
}

// ---------------------------------------------------------------------------
// FREERTOS STACK SIZE (bytes per task)
//
// Naikkan jika ada stack overflow (terlihat di Serial: "[WDT] Stack kritis")
// ---------------------------------------------------------------------------
namespace StackSize
{
    constexpr uint32_t SENSOR_PPG = 4096;
    constexpr uint32_t SENSOR_IMU = 4096;
    constexpr uint32_t MQTT_PUB   = 8192;
    constexpr uint32_t MONITOR    = 4096;
}

// ---------------------------------------------------------------------------
// NODE ID
//
// NODE_ID digunakan sebagai identifier di MQTT topic:
//   health_monitor/node_<NODE_ID>/raw
//
// Setiap ESP32 dalam sistem harus punya NODE_ID unik.
// Di-inject oleh platformio.ini via build_flags:
//   -D NODE_ID=1
// ---------------------------------------------------------------------------
