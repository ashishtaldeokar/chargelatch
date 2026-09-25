/*
 * Per-device identity issued by the factory app.
 *
 * At flashing time the factory web app registers the chip's MAC address with the backend, which
 * issues a human-readable identity ("SONIK-42") and a secret provisioning proof-of-possession, and
 * flashes both into the `fctry` NVS partition (namespace "factory", keys "identity" and "pop").
 * This component reads them back, read-only.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define DEVICE_IDENTITY_PARTITION   "fctry"
#define DEVICE_IDENTITY_NAMESPACE   "factory"
#define DEVICE_IDENTITY_KEY         "identity"
#define DEVICE_IDENTITY_POP_KEY     "pop"
/* Meter configuration chosen at the factory (optional; boards flashed before it existed lack it). */
#define DEVICE_IDENTITY_METER_MODEL_KEY   "meter_model"    /* string, e.g. "SDM120" */
#define DEVICE_IDENTITY_METER_ADDR_KEY    "meter_addr"     /* u8, Modbus slave address */
#define DEVICE_IDENTITY_METER_BAUD_KEY    "meter_baud"     /* u32 */
#define DEVICE_IDENTITY_METER_PARITY_KEY  "meter_parity"   /* string: none | even | odd */

/** Longest identity including the NUL terminator. */
#define DEVICE_IDENTITY_MAX_LEN     32
/** Longest provisioning proof-of-possession including the NUL terminator. */
#define DEVICE_IDENTITY_POP_MAX_LEN 65

/**
 * Loads the identity from the factory partition. Call once at startup, before
 * device_identity_get().
 *
 * @return ESP_OK on success
 *         ESP_ERR_NOT_FOUND if the partition is missing or holds no identity, i.e. the device
 *         did not go through the factory app (for example it was flashed with idf.py)
 *         other esp_err_t codes from NVS
 */
esp_err_t device_identity_init(void);

/**
 * The device identity, e.g. "SONIK-42".
 *
 * @return a NUL-terminated string valid for the lifetime of the program, or NULL if
 *         device_identity_init() has not succeeded.
 */
const char *device_identity_get(void);

/**
 * The per-device proof-of-possession for BLE Wi-Fi provisioning (protocomm security 1). The
 * backend only reveals it to admins. Treat it as a secret: never log it.
 *
 * @return a NUL-terminated string valid for the lifetime of the program, or NULL if
 *         device_identity_init() has not succeeded or the partition predates PoPs.
 */
const char *device_identity_get_pop(void);

typedef struct {
    /** NULL when no meter was configured at the factory. */
    const char *model;
    uint8_t address;
    uint32_t baud;
    /** "none", "even" or "odd"; NULL when not configured. */
    const char *parity;
} device_meter_config_t;

/** The meter configured at the factory; fields are NULL/0 where nothing was stored. */
const device_meter_config_t *device_identity_get_meter(void);

#ifdef __cplusplus
}
#endif
