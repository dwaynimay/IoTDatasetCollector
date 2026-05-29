// File: firmware/include/Config.h

#pragma once
// =============================================================================
// Config.h — Titik Masuk Konfigurasi Tunggal
// =============================================================================
// File ini adalah satu-satunya yang perlu di-include oleh modul manapun
// untuk mendapatkan akses ke seluruh konfigurasi sistem.
//
// PANDUAN SETUP CEPAT:
//   1. config/credentials.h → isi SSID, password WiFi, IP broker MQTT
//   2. config/hardware.h    → isi pin I2C sesuai board
//   3. config/features.h    → atur LOG_LEVEL
//   4. config/tuning.h      → atur timing & send interval
//   5. Compile & upload
//
// STRUKTUR INCLUDE (urutan penting):
//   features.h   → #define LOG_LEVEL
//   Logger.h     → makro LOG_* (butuh LOG_LEVEL dari features.h)
//   credentials.h, hardware.h, tuning.h → konfigurasi hardware & jaringan
// =============================================================================

// ── Urutan include DI BAWAH INI TIDAK BOLEH DIUBAH ──────────────────────────
// features.h HARUS sebelum Logger.h karena Logger membaca LOG_LEVEL dari sana.

#include "config/features.h"    // (1) Flag fitur & LOG_LEVEL — HARUS PERTAMA
#include "utils/Logger.h"       // (2) Makro LOG_* — butuh LOG_LEVEL dari (1)
#include "DataModels.h"         // (3) Struct ImuSample, PpgSample

#include "config/credentials.h" // (4) WiFi & MQTT credentials + NODE_ID
#include "config/hardware.h"    // (5) Pin & alamat I2C
#include "config/tuning.h"      // (6) Timing, priority, stack size