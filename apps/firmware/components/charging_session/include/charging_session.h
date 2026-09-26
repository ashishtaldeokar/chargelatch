/*
 * Charging transactions: a third party starts one through the backend, which switches the
 * contactor on, and stops it, which switches it off and reports what was delivered.
 *
 *   devices/<id>/cmd/tx  <- {"op":"start","txId":"…","id":"<request>","interval":30}
 *                           {"op":"stop","txId":"…","id":"<request>"}
 *   devices/<id>/tx      -> retained {"state":"active","txId":"…","meterStart":1234.75,"interval":30,"id":"…"}
 *                           or       {"state":"idle","id":"…"}; republished on every (re)connect
 *   devices/<id>/tx/end  -> QoS 1   {"txId","meterStart","meterStop","energyWh","reason","id"}
 *   devices/<id>/tx/meter-> QoS 1   {"txId","seq","energyWh","meterKwh","reading":{…}} every interval
 *
 * A start while another transaction is active ends that one first (reason "superseded"), then
 * starts the new one: two acks, in order, from one command. The active transaction is persisted
 * in NVS, so after a power cut it resumes (the relay component restores the contactor).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"
#include "sdm_meter.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CHARGING_SESSION_COMMAND "tx"    /* devices/<id>/cmd/tx */

/** Loads a persisted transaction, installs the relay guard, starts the meter-value task. Call after relay_control_init(). */
esp_err_t charging_session_init(void);

/** Handles the payload of a devices/<id>/cmd/tx message. */
void charging_session_handle_command(const char *payload, size_t payload_len);

/** Publishes the retained transaction state. Call on every MQTT connect. */
void charging_session_publish_state(void);

/** Called by meter telemetry after every meter read: the latest counter is what energy is computed from. */
void charging_session_note_reading(const sdm_reading_t *reading, bool complete);

bool charging_session_is_active(void);

#ifdef __cplusplus
}
#endif
