// File: firmware/include/DataModels.h

#pragma once
// =============================================================================
// DataModels.h — Definisi Struct Data Sensor
// =============================================================================
// Berisi struct ImuSample dan PpgSample yang dipakai bersama
// oleh modul HealthSensors, Network_Mqtt, dan main.cpp.
//
// Menggantikan MeshPackets.h yang dulu dipakai sebagai carrier struct ini,
// namun MeshPackets sudah dihapus bersama dengan modul EspNowMesh.
// =============================================================================

#include <Arduino.h>

// =============================================================================
// ImuSample — Satu sampel accelerometer + gyroscope dari MPU6050
// =============================================================================
struct ImuSample
{
    uint32_t timestamp_ms = 0; // millis() saat sampel dibaca

    // Accelerometer — satuan m/s²
    float ax = 0.0f;
    float ay = 0.0f;
    float az = 0.0f;

    // Gyroscope — satuan °/s
    float gx = 0.0f;
    float gy = 0.0f;
    float gz = 0.0f;
};

// =============================================================================
// PpgSample — Satu sampel PPG dari MAX30102
// =============================================================================
struct PpgSample
{
    uint32_t timestamp_ms = 0; // millis() saat sampel dibaca

    uint32_t ir  = 0; // kanal infrared (ADC raw)
    uint32_t red = 0; // kanal merah (ADC raw)

    float    spo2     = 0.0f; // estimasi SpO2 (%), 0 jika tidak valid
    uint8_t  beat_avg = 0;    // rata-rata BPM
};
