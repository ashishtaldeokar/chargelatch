/*
 * The Modbus RTU subset an SDM meter needs: "read input registers" (0x04) returning floats.
 * Pure C with no ESP-IDF dependencies, so it is unit-tested on the host (test_host/).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "sdm_registers.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SDM_MODBUS_REQUEST_LEN      8
/* Eastron meters answer at most 40 registers (20 values) per request. */
#define SDM_MODBUS_MAX_REGISTERS    40
/* slave + function + byte count + data + crc */
#define SDM_MODBUS_RESPONSE_LEN(register_count) (5 + 2 * (size_t)(register_count))
#define SDM_MODBUS_MAX_RESPONSE_LEN SDM_MODBUS_RESPONSE_LEN(SDM_MODBUS_MAX_REGISTERS)

typedef enum {
    SDM_MODBUS_OK = 0,
    SDM_MODBUS_ERR_TOO_SHORT,       /* timeout or truncated frame */
    SDM_MODBUS_ERR_CRC,
    SDM_MODBUS_ERR_WRONG_SLAVE,
    SDM_MODBUS_ERR_EXCEPTION,       /* the meter rejected the request, see exception code */
    SDM_MODBUS_ERR_MALFORMED,
} sdm_modbus_result_t;

/** A run of registers fetched with one request, covering table entries [first_index, first_index + value_count). */
typedef struct {
    uint16_t start_address;
    uint16_t register_count;
    size_t first_index;
    size_t value_count;
} sdm_block_t;

uint16_t sdm_modbus_crc16(const uint8_t *data, size_t len);

void sdm_modbus_build_read_input(uint8_t slave, uint16_t start_address, uint16_t register_count,
                                 uint8_t request[SDM_MODBUS_REQUEST_LEN]);

/**
 * Validates a response to a read of `register_count` registers.
 * @param exception_code  may be NULL; set for SDM_MODBUS_ERR_EXCEPTION
 */
sdm_modbus_result_t sdm_modbus_check_response(uint8_t slave, uint16_t register_count, const uint8_t *frame,
                                              size_t len, uint8_t *exception_code);

/** The float stored at `address` in a validated response to a read starting at `start_address`. */
float sdm_modbus_float_at(const uint8_t *frame, uint16_t start_address, uint16_t address);

/**
 * Groups a sorted register table into as few requests as possible. Reading across the gaps
 * between registers is fine: the meter returns zeros for addresses it does not implement.
 *
 * @return number of blocks written, or 0 if `max_blocks` is too small or the table is not sorted
 */
size_t sdm_modbus_plan_blocks(const sdm_register_t *registers, size_t count, sdm_block_t *blocks, size_t max_blocks);

const char *sdm_modbus_result_name(sdm_modbus_result_t result);

#ifdef __cplusplus
}
#endif
