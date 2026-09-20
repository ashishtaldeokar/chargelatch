#include "sdm_registers.h"

#define COUNT(table) (sizeof(table) / sizeof((table)[0]))

/* Sorted by address (see sdm_registers.h). */
static const sdm_register_t sdm120_registers[] = {
    { "voltage",                SDM120_REG_VOLTAGE,                "V" },
    { "current",                SDM120_REG_CURRENT,                "A" },
    { "power",                  SDM120_REG_ACTIVE_POWER,           "W" },
    { "apparent_power",         SDM120_REG_APPARENT_POWER,         "VA" },
    { "reactive_power",         SDM120_REG_REACTIVE_POWER,         "VAr" },
    { "power_factor",           SDM120_REG_POWER_FACTOR,           "" },
    { "phase_angle",            SDM120_REG_PHASE_ANGLE,            "deg" },
    { "frequency",              SDM_REG_FREQUENCY,                 "Hz" },
    { "import_energy",          SDM_REG_IMPORT_ACTIVE_ENERGY,      "kWh" },
    { "export_energy",          SDM_REG_EXPORT_ACTIVE_ENERGY,      "kWh" },
    { "import_reactive_energy", SDM_REG_IMPORT_REACTIVE_ENERGY,    "kVArh" },
    { "export_reactive_energy", SDM_REG_EXPORT_REACTIVE_ENERGY,    "kVArh" },
    { "total_energy",           SDM_REG_TOTAL_ACTIVE_ENERGY,       "kWh" },
    { "total_reactive_energy",  SDM_REG_TOTAL_REACTIVE_ENERGY,     "kVArh" },
};

/* "current", "power", ... are the system totals, so they mean the same as on a 1-phase meter. */
static const sdm_register_t sdm630_registers[] = {
    { "voltage_l1",             SDM630_REG_VOLTAGE_L1,             "V" },
    { "voltage_l2",             SDM630_REG_VOLTAGE_L2,             "V" },
    { "voltage_l3",             SDM630_REG_VOLTAGE_L3,             "V" },
    { "current_l1",             SDM630_REG_CURRENT_L1,             "A" },
    { "current_l2",             SDM630_REG_CURRENT_L2,             "A" },
    { "current_l3",             SDM630_REG_CURRENT_L3,             "A" },
    { "power_l1",               SDM630_REG_ACTIVE_POWER_L1,        "W" },
    { "power_l2",               SDM630_REG_ACTIVE_POWER_L2,        "W" },
    { "power_l3",               SDM630_REG_ACTIVE_POWER_L3,        "W" },
    { "power_factor_l1",        SDM630_REG_POWER_FACTOR_L1,        "" },
    { "power_factor_l2",        SDM630_REG_POWER_FACTOR_L2,        "" },
    { "power_factor_l3",        SDM630_REG_POWER_FACTOR_L3,        "" },
    { "current",                SDM630_REG_SUM_CURRENT,            "A" },
    { "power",                  SDM630_REG_TOTAL_ACTIVE_POWER,     "W" },
    { "apparent_power",         SDM630_REG_TOTAL_APPARENT_POWER,   "VA" },
    { "reactive_power",         SDM630_REG_TOTAL_REACTIVE_POWER,   "VAr" },
    { "power_factor",           SDM630_REG_TOTAL_POWER_FACTOR,     "" },
    { "phase_angle",            SDM630_REG_TOTAL_PHASE_ANGLE,      "deg" },
    { "frequency",              SDM_REG_FREQUENCY,                 "Hz" },
    { "import_energy",          SDM_REG_IMPORT_ACTIVE_ENERGY,      "kWh" },
    { "export_energy",          SDM_REG_EXPORT_ACTIVE_ENERGY,      "kWh" },
    { "import_reactive_energy", SDM_REG_IMPORT_REACTIVE_ENERGY,    "kVArh" },
    { "export_reactive_energy", SDM_REG_EXPORT_REACTIVE_ENERGY,    "kVArh" },
    { "total_energy",           SDM_REG_TOTAL_ACTIVE_ENERGY,       "kWh" },
    { "total_reactive_energy",  SDM_REG_TOTAL_REACTIVE_ENERGY,     "kVArh" },
};

_Static_assert(COUNT(sdm120_registers) <= SDM_MAX_REGISTERS, "raise SDM_MAX_REGISTERS");
_Static_assert(COUNT(sdm630_registers) <= SDM_MAX_REGISTERS, "raise SDM_MAX_REGISTERS");

const sdm_model_t SDM_MODEL_SDM120 = { "SDM120", 1, sdm120_registers, COUNT(sdm120_registers) };
const sdm_model_t SDM_MODEL_SDM630 = { "SDM630", 3, sdm630_registers, COUNT(sdm630_registers) };
