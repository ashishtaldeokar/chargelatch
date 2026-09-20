/* Formats a meter reading as the JSON document published over MQTT. Pure C, host-tested. */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "sdm_registers.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Enough for SDM_MAX_REGISTERS values: ~40 bytes each plus the envelope. */
#define SDM_JSON_MAX_LEN 1536

/**
 * {"model":"SDM120","ok":true,"voltage":230.500,...}
 *
 * "ok" is true only if every register was read. Otherwise "error" carries the reason and only the
 * values that were read are present. Non-finite floats are left out: JSON cannot represent them.
 *
 * @param error  reason when something failed, may be NULL
 * @return length written (excluding the NUL), or 0 if `size` is too small
 */
size_t sdm_json_format(const sdm_model_t *model, const float *values, const bool *valid, const char *error,
                       char *out, size_t size);

#ifdef __cplusplus
}
#endif
