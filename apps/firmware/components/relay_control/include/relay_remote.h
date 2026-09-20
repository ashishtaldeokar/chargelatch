/*
 * Remote control of the relay over MQTT.
 *
 *   devices/<id>/cmd/relay   <- {"on":true,"id":"<request id>"}   ("id" optional; plain "on"/"off"
 *                               is also accepted, handy with mosquitto_pub)
 *   devices/<id>/relay       -> {"on":true,"id":"<request id>"}   retained; "id" echoes the command
 *                               that caused this state, which is how the API knows its request
 *                               was carried out. Published after every command and on every
 *                               (re)connect, so the broker always holds the true state.
 */
#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define RELAY_REMOTE_COMMAND  "relay"   /* devices/<id>/cmd/relay */
#define RELAY_REMOTE_SUBTOPIC "relay"   /* devices/<id>/relay */

/** Handles the payload of a devices/<id>/cmd/relay message. */
void relay_remote_handle_command(const char *payload, size_t payload_len);

/** Publishes the current state (retained). Call whenever MQTT (re)connects. */
void relay_remote_publish_state(void);

#ifdef __cplusplus
}
#endif
