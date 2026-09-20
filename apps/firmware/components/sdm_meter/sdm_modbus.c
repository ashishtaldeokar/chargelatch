#include <string.h>

#include "sdm_modbus.h"

#define FUNCTION_READ_INPUT     0x04
#define EXCEPTION_FLAG          0x80
#define REGISTERS_PER_VALUE     2

uint16_t sdm_modbus_crc16(const uint8_t *data, size_t len)
{
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc & 1) ? (uint16_t)((crc >> 1) ^ 0xA001) : (uint16_t)(crc >> 1);
        }
    }
    return crc;
}

void sdm_modbus_build_read_input(uint8_t slave, uint16_t start_address, uint16_t register_count,
                                 uint8_t request[SDM_MODBUS_REQUEST_LEN])
{
    request[0] = slave;
    request[1] = FUNCTION_READ_INPUT;
    request[2] = (uint8_t)(start_address >> 8);
    request[3] = (uint8_t)start_address;
    request[4] = (uint8_t)(register_count >> 8);
    request[5] = (uint8_t)register_count;
    const uint16_t crc = sdm_modbus_crc16(request, 6);
    request[6] = (uint8_t)crc;          /* the CRC, unlike everything else, goes low byte first */
    request[7] = (uint8_t)(crc >> 8);
}

static bool crc_ok(const uint8_t *frame, size_t len)
{
    const uint16_t expected = (uint16_t)(frame[len - 2] | (frame[len - 1] << 8));
    return sdm_modbus_crc16(frame, len - 2) == expected;
}

sdm_modbus_result_t sdm_modbus_check_response(uint8_t slave, uint16_t register_count, const uint8_t *frame,
                                              size_t len, uint8_t *exception_code)
{
    /* An exception reply is 5 bytes: slave, function | 0x80, code, crc. */
    if (len >= 5 && (frame[1] & EXCEPTION_FLAG)) {
        if (!crc_ok(frame, 5)) {
            return SDM_MODBUS_ERR_CRC;
        }
        if (exception_code) {
            *exception_code = frame[2];
        }
        return SDM_MODBUS_ERR_EXCEPTION;
    }

    const size_t expected_len = SDM_MODBUS_RESPONSE_LEN(register_count);
    if (len < expected_len) {
        return SDM_MODBUS_ERR_TOO_SHORT;
    }
    if (!crc_ok(frame, expected_len)) {
        return SDM_MODBUS_ERR_CRC;
    }
    if (frame[0] != slave) {
        return SDM_MODBUS_ERR_WRONG_SLAVE;
    }
    if (frame[1] != FUNCTION_READ_INPUT || frame[2] != 2 * register_count) {
        return SDM_MODBUS_ERR_MALFORMED;
    }
    return SDM_MODBUS_OK;
}

float sdm_modbus_float_at(const uint8_t *frame, uint16_t start_address, uint16_t address)
{
    const uint8_t *data = frame + 3 + 2 * (size_t)(address - start_address);
    /* Big-endian on the wire; assemble explicitly so host endianness does not matter. */
    const uint32_t bits = ((uint32_t)data[0] << 24) | ((uint32_t)data[1] << 16) | ((uint32_t)data[2] << 8) | data[3];
    float value;
    memcpy(&value, &bits, sizeof(value));
    return value;
}

size_t sdm_modbus_plan_blocks(const sdm_register_t *registers, size_t count, sdm_block_t *blocks, size_t max_blocks)
{
    size_t used = 0;
    for (size_t i = 0; i < count; i++) {
        if (i > 0 && registers[i].address <= registers[i - 1].address) {
            return 0; /* not sorted / duplicate address */
        }
        sdm_block_t *current = used ? &blocks[used - 1] : NULL;
        const uint32_t end = (uint32_t)registers[i].address + REGISTERS_PER_VALUE;
        if (current && end - current->start_address <= SDM_MODBUS_MAX_REGISTERS) {
            current->register_count = (uint16_t)(end - current->start_address);
            current->value_count++;
            continue;
        }
        if (used == max_blocks) {
            return 0;
        }
        blocks[used++] = (sdm_block_t) {
            .start_address = registers[i].address,
            .register_count = REGISTERS_PER_VALUE,
            .first_index = i,
            .value_count = 1,
        };
    }
    return used;
}

const char *sdm_modbus_result_name(sdm_modbus_result_t result)
{
    switch (result) {
    case SDM_MODBUS_OK:                 return "ok";
    case SDM_MODBUS_ERR_TOO_SHORT:      return "timeout";
    case SDM_MODBUS_ERR_CRC:            return "crc";
    case SDM_MODBUS_ERR_WRONG_SLAVE:    return "wrong_slave";
    case SDM_MODBUS_ERR_EXCEPTION:      return "exception";
    case SDM_MODBUS_ERR_MALFORMED:      return "malformed";
    }
    return "unknown";
}
