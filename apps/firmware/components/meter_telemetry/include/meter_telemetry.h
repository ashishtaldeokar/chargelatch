/*
 * Reads the energy meter on a fixed interval and publishes each reading as JSON to
 *   devices/<device id>/meter
 *
 *   {"model":"SDM120","phases":1,"ok":true,"voltage":230.500,"current":1.250,"power":287.100,...}
 *
 * Field names come from the register table of the selected model (sdm_registers.c). When the
 * meter cannot be read, {"model":...,"ok":false,"error":"timeout"} is published instead, so the
 * backend can tell "meter unreachable" from "device offline" (devices/<id>/status).
 */
#pragma once

#include "esp_err.h"
#include "sdm_meter.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Subtopic under devices/<id>/. */
#define METER_TELEMETRY_SUBTOPIC "meter"

/**
 * Initialises the meter UART and starts the background task. Call after device_mqtt_start().
 * Readings taken while MQTT is disconnected are dropped, not queued: stale power values are
 * worthless and would only pile up in memory.
 */
esp_err_t meter_telemetry_start(const sdm_meter_config_t *meter);

#ifdef __cplusplus
}
#endif
