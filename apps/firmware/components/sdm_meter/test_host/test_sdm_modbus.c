/*
 * Host unit tests for the hardware-independent part of sdm_meter. Run with test_host/run.sh.
 * The frames below were generated independently (Python struct + CRC), not by the code under test.
 */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "sdm_json.h"
#include "sdm_modbus.h"

static int failures;

#define CHECK(condition)                                                        \
    do {                                                                        \
        if (!(condition)) {                                                     \
            printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);       \
            failures++;                                                         \
        }                                                                       \
    } while (0)

#define CLOSE_TO(actual, expected) (fabs((double)(actual) - (double)(expected)) < 1e-3)

static void test_request(void)
{
    /* The textbook Modbus example: read 2 input registers from 0 on slave 1. */
    const uint8_t expected[] = { 0x01, 0x04, 0x00, 0x00, 0x00, 0x02, 0x71, 0xCB };
    uint8_t request[SDM_MODBUS_REQUEST_LEN];
    sdm_modbus_build_read_input(1, 0x0000, 2, request);
    CHECK(memcmp(request, expected, sizeof(expected)) == 0);

    /* Total active energy on slave 5: address and slave land in the right bytes. */
    sdm_modbus_build_read_input(5, SDM_REG_TOTAL_ACTIVE_ENERGY, 2, request);
    CHECK(request[0] == 5 && request[2] == 0x01 && request[3] == 0x56);
    CHECK(sdm_modbus_crc16(request, 6) == (uint16_t)(request[6] | (request[7] << 8)));
}

static void test_single_value(void)
{
    const uint8_t frame[] = { 0x01, 0x04, 0x04, 0x43, 0x66, 0x80, 0x00, 0x6F, 0xDF }; /* 230.5 */
    CHECK(sdm_modbus_check_response(1, 2, frame, sizeof(frame), NULL) == SDM_MODBUS_OK);
    CHECK(CLOSE_TO(sdm_modbus_float_at(frame, 0x0000, 0x0000), 230.5));
}

static void test_value_inside_a_block(void)
{
    /* A block starting at frequency (0x46) that also holds import energy (0x48). */
    const uint8_t frame[] = { 0x01, 0x04, 0x08, 0x42, 0x48, 0x14, 0x7B, 0x44, 0x9A, 0x58, 0x00, 0x81, 0xE1 };
    CHECK(sdm_modbus_check_response(1, 4, frame, sizeof(frame), NULL) == SDM_MODBUS_OK);
    CHECK(CLOSE_TO(sdm_modbus_float_at(frame, SDM_REG_FREQUENCY, SDM_REG_FREQUENCY), 50.02));
    CHECK(CLOSE_TO(sdm_modbus_float_at(frame, SDM_REG_FREQUENCY, SDM_REG_IMPORT_ACTIVE_ENERGY), 1234.75));
}

static void test_bad_frames(void)
{
    uint8_t frame[] = { 0x01, 0x04, 0x04, 0x43, 0x66, 0x80, 0x00, 0x6F, 0xDF };

    CHECK(sdm_modbus_check_response(1, 2, frame, 4, NULL) == SDM_MODBUS_ERR_TOO_SHORT);
    CHECK(sdm_modbus_check_response(1, 2, frame, 0, NULL) == SDM_MODBUS_ERR_TOO_SHORT);
    /* Valid frame, but from another meter on the bus. */
    CHECK(sdm_modbus_check_response(2, 2, frame, sizeof(frame), NULL) == SDM_MODBUS_ERR_WRONG_SLAVE);
    /* We asked for 4 registers and got 2. */
    CHECK(sdm_modbus_check_response(1, 4, frame, sizeof(frame), NULL) == SDM_MODBUS_ERR_TOO_SHORT);

    frame[4] ^= 0x01; /* one flipped bit on the wire */
    CHECK(sdm_modbus_check_response(1, 2, frame, sizeof(frame), NULL) == SDM_MODBUS_ERR_CRC);
}

static void test_exception(void)
{
    const uint8_t frame[] = { 0x01, 0x84, 0x02, 0xC2, 0xC1 }; /* illegal data address */
    uint8_t code = 0;
    CHECK(sdm_modbus_check_response(1, 2, frame, sizeof(frame), &code) == SDM_MODBUS_ERR_EXCEPTION);
    CHECK(code == 0x02);
}

static void check_model(const sdm_model_t *model, size_t expected_blocks)
{
    sdm_block_t blocks[8];
    const size_t count = sdm_modbus_plan_blocks(model->registers, model->register_count, blocks, 8);
    printf("  %s: %zu values in %zu requests\n", model->name, model->register_count, count);
    CHECK(count == expected_blocks);

    size_t covered = 0;
    for (size_t b = 0; b < count; b++) {
        CHECK(blocks[b].register_count <= SDM_MODBUS_MAX_REGISTERS);
        CHECK(blocks[b].first_index == covered);
        for (size_t i = 0; i < blocks[b].value_count; i++) {
            const uint16_t address = model->registers[covered + i].address;
            CHECK(address >= blocks[b].start_address);
            CHECK(address + 2 <= blocks[b].start_address + blocks[b].register_count);
        }
        covered += blocks[b].value_count;
    }
    CHECK(covered == model->register_count);

    /* Keys become JSON field names: they must be unique within a model. */
    for (size_t i = 0; i < model->register_count; i++) {
        for (size_t j = i + 1; j < model->register_count; j++) {
            CHECK(strcmp(model->registers[i].key, model->registers[j].key) != 0);
        }
    }
}

static void test_block_planning(void)
{
    /* 0x0000-0x0025, 0x0046-0x004F, 0x0156-0x0159 */
    check_model(&SDM_MODEL_SDM120, 3);
    /* 0x0000-0x0023, 0x0030-0x004F, 0x0156-0x0159 */
    check_model(&SDM_MODEL_SDM630, 3);

    sdm_block_t blocks[8];
    CHECK(sdm_modbus_plan_blocks(SDM_MODEL_SDM120.registers, SDM_MODEL_SDM120.register_count, blocks, 8) == 3);
    CHECK(blocks[0].start_address == 0x0000 && blocks[0].register_count == 38 && blocks[0].value_count == 7);
    CHECK(blocks[1].start_address == 0x0046 && blocks[1].register_count == 10 && blocks[1].value_count == 5);
    CHECK(blocks[2].start_address == 0x0156 && blocks[2].register_count == 4 && blocks[2].value_count == 2);

    const sdm_register_t unsorted[] = { { "b", 0x0006, "" }, { "a", 0x0000, "" } };
    CHECK(sdm_modbus_plan_blocks(unsorted, 2, blocks, 8) == 0);
    CHECK(sdm_modbus_plan_blocks(SDM_MODEL_SDM120.registers, SDM_MODEL_SDM120.register_count, blocks, 2) == 0);
}

static void test_lookup(void)
{
    CHECK(sdm_model_by_name("SDM120") == &SDM_MODEL_SDM120);
    CHECK(sdm_model_by_name("SDM630") == &SDM_MODEL_SDM630);
    CHECK(sdm_model_by_name("nope") == NULL);
    CHECK(sdm_model_by_name(NULL) == NULL);
    /* Every model must expose the cumulative counter transactions are billed from. */
    for (size_t i = 0; i < SDM_MODEL_COUNT; i++) {
        CHECK(sdm_model_index_of(SDM_MODELS[i], "total_energy") >= 0);
        CHECK(strcmp(SDM_MODELS[i]->registers[sdm_model_index_of(SDM_MODELS[i], "power")].key, "power") == 0);
    }
    CHECK(sdm_model_index_of(&SDM_MODEL_SDM120, "voltage_l2") == -1);
}

static void test_json(void)
{
    char json[SDM_JSON_MAX_LEN];
    float values[SDM_MAX_REGISTERS] = { 0 };
    bool valid[SDM_MAX_REGISTERS] = { false };
    const sdm_model_t *model = &SDM_MODEL_SDM120;

    for (size_t i = 0; i < model->register_count; i++) {
        values[i] = (float)i + 0.5f;
        valid[i] = true;
    }
    values[0] = 230.5f;
    size_t len = sdm_json_format(model, values, valid, NULL, json, sizeof(json));
    CHECK(len == strlen(json));
    const char *prefix = "{\"model\":\"SDM120\",\"phases\":1,\"ok\":true,\"voltage\":230.500,\"current\":1.500,";
    CHECK(strncmp(json, prefix, strlen(prefix)) == 0);
    CHECK(strstr(json, "\"total_reactive_energy\":13.500}") != NULL);
    CHECK(strstr(json, "error") == NULL);

    /* The energy blocks failed: their keys disappear and the document says why. */
    for (size_t i = 7; i < model->register_count; i++) {
        valid[i] = false;
    }
    sdm_json_format(model, values, valid, "crc", json, sizeof(json));
    CHECK(strstr(json, "\"ok\":false,\"error\":\"crc\"") != NULL);
    CHECK(strstr(json, "\"phase_angle\":6.500}") != NULL);
    CHECK(strstr(json, "frequency") == NULL);

    /* Nothing read at all. */
    memset(valid, 0, sizeof(valid));
    sdm_json_format(model, values, valid, "timeout", json, sizeof(json));
    CHECK(strcmp(json, "{\"model\":\"SDM120\",\"phases\":1,\"ok\":false,\"error\":\"timeout\"}") == 0);

    /* NaN is not JSON. */
    valid[0] = true;
    values[0] = NAN;
    sdm_json_format(model, values, valid, NULL, json, sizeof(json));
    CHECK(strstr(json, "nan") == NULL && strstr(json, "voltage") == NULL);
    CHECK(strstr(json, "\"error\":\"invalid_value\"") != NULL);

    /* The largest model with wide values still fits, and a tiny buffer is refused, not overrun. */
    model = &SDM_MODEL_SDM630;
    for (size_t i = 0; i < model->register_count; i++) {
        values[i] = -1234567.875f;
        valid[i] = true;
    }
    len = sdm_json_format(model, values, valid, NULL, json, sizeof(json));
    printf("  largest document: %zu of %d bytes\n", len, SDM_JSON_MAX_LEN);
    CHECK(len > 0 && json[len - 1] == '}');
    CHECK(sdm_json_format(model, values, valid, NULL, json, 64) == 0);
}

int main(void)
{
    printf("sdm_modbus host tests\n");
    test_request();
    test_single_value();
    test_value_inside_a_block();
    test_bad_frames();
    test_exception();
    test_block_planning();
    test_json();
    test_lookup();
    printf(failures ? "%d FAILED\n" : "all passed\n", failures);
    return failures ? 1 : 0;
}
