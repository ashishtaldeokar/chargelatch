/*
 * Eastron SDM register maps.
 *
 * All values are Modbus INPUT registers (function 0x04) holding a big-endian IEEE-754 float
 * spread over two 16-bit registers. Addresses are the 0-based protocol addresses from Eastron's
 * "Modbus Protocol" documents (the 3X/30001-style numbers there are address + 1).
 *
 * To support another meter, add a table here (and in sdm_registers.c) and a Kconfig choice entry.
 * RULES for a table: sorted by ascending address, and every key unique. Keys become the JSON
 * field names published over MQTT, so keep a key's meaning identical across models: consumers
 * rely on e.g. "power" always being the total active power in W.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    const char *key;    /* JSON field name */
    uint16_t address;   /* first of the two input registers */
    const char *unit;   /* documentation only */
} sdm_register_t;

typedef struct {
    const char *name;
    uint8_t phases;
    const sdm_register_t *registers;
    size_t register_count;
} sdm_model_t;

/* ---- Registers shared by the whole SDM family ------------------------------------------- */
#define SDM_REG_FREQUENCY                   0x0046  /* Hz */
#define SDM_REG_IMPORT_ACTIVE_ENERGY        0x0048  /* kWh */
#define SDM_REG_EXPORT_ACTIVE_ENERGY        0x004A  /* kWh */
#define SDM_REG_IMPORT_REACTIVE_ENERGY      0x004C  /* kVArh */
#define SDM_REG_EXPORT_REACTIVE_ENERGY      0x004E  /* kVArh */
#define SDM_REG_TOTAL_ACTIVE_ENERGY         0x0156  /* kWh */
#define SDM_REG_TOTAL_REACTIVE_ENERGY       0x0158  /* kVArh */

/* ---- SDM120 (1-phase) --------------------------------------------------------------------- */
#define SDM120_REG_VOLTAGE                  0x0000  /* V */
#define SDM120_REG_CURRENT                  0x0006  /* A */
#define SDM120_REG_ACTIVE_POWER             0x000C  /* W */
#define SDM120_REG_APPARENT_POWER           0x0012  /* VA */
#define SDM120_REG_REACTIVE_POWER           0x0018  /* VAr */
#define SDM120_REG_POWER_FACTOR             0x001E
#define SDM120_REG_PHASE_ANGLE              0x0024  /* degrees */

/* ---- SDM630 (3-phase): per-phase values sit at base, base + 2, base + 4 ------------------- */
#define SDM630_REG_VOLTAGE_L1               0x0000  /* V, line to neutral */
#define SDM630_REG_VOLTAGE_L2               0x0002
#define SDM630_REG_VOLTAGE_L3               0x0004
#define SDM630_REG_CURRENT_L1               0x0006  /* A */
#define SDM630_REG_CURRENT_L2               0x0008
#define SDM630_REG_CURRENT_L3               0x000A
#define SDM630_REG_ACTIVE_POWER_L1          0x000C  /* W */
#define SDM630_REG_ACTIVE_POWER_L2          0x000E
#define SDM630_REG_ACTIVE_POWER_L3          0x0010
#define SDM630_REG_POWER_FACTOR_L1          0x001E
#define SDM630_REG_POWER_FACTOR_L2          0x0020
#define SDM630_REG_POWER_FACTOR_L3          0x0022
#define SDM630_REG_SUM_CURRENT              0x0030  /* A */
#define SDM630_REG_TOTAL_ACTIVE_POWER       0x0034  /* W */
#define SDM630_REG_TOTAL_APPARENT_POWER     0x0038  /* VA */
#define SDM630_REG_TOTAL_REACTIVE_POWER     0x003C  /* VAr */
#define SDM630_REG_TOTAL_POWER_FACTOR       0x003E
#define SDM630_REG_TOTAL_PHASE_ANGLE        0x0042  /* degrees */

extern const sdm_model_t SDM_MODEL_SDM120;
extern const sdm_model_t SDM_MODEL_SDM630;

/** Largest register_count of any model, for sizing buffers. */
#define SDM_MAX_REGISTERS 32

#ifdef __cplusplus
}
#endif
