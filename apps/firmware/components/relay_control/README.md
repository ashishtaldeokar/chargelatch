# relay_control

The relay on **GPIO26** (active high) that drives the contactor, plus its remote control over MQTT.

```c
relay_control_init();          // first thing in app_main: restores the last state in milliseconds
relay_control_set(true);       // close the contactor, persist the state
relay_control_is_on();
```

| Kconfig (menuconfig → chargelatch relay) | Default | Meaning                                              |
| ---------------------------------------- | ------- | ---------------------------------------------------- |
| `RELAY_GPIO`                             | 26      | trigger pin                                          |
| `RELAY_ACTIVE_HIGH`                      | y       | high = energised. Wrong polarity closes the contactor at boot |
| `RELAY_RESTORE_STATE`                    | y       | re-apply the last state (NVS namespace `relay`) after reset or power cut |

**With restore enabled the contactor closes by itself after a power cut if it was on before.**
That was a deliberate choice; set `RELAY_RESTORE_STATE=n` for "always off at boot". The state is
kept on Wi-Fi/MQTT loss either way. The pin is set to its level *before* it becomes an output, so
it does not glitch on. NVS is only written when the state actually changes.

Before the firmware runs (reset, bootloader, flashing) GPIO26 floats. If the relay module does
not have its own pull-down, add one (10 kΩ to GND) so the contactor cannot chatter during boot.

## MQTT (`relay_remote.c`)

| Topic                    | Direction | Payload                                                        |
| ------------------------ | --------- | -------------------------------------------------------------- |
| `devices/<id>/cmd/relay` | → device  | `{"on":true,"id":"<request id>"}`; `id` optional. Plain `on` / `off` also work: `mosquitto_pub -t devices/SONIK-1/cmd/relay -m on` |
| `devices/<id>/relay`     | device →  | retained `{"on":true,"id":"<request id>"}`                     |

The device publishes its state after **every** command (even if nothing changed) and on every
MQTT (re)connect. `id` echoes the command that produced the state; the API uses it to know that
*its* request was carried out. Anything without an explicit boolean `on` is ignored: never guess
with a contactor. Commands are never sent retained, so a reconnecting device does not replay one.

Not there yet: no minimum interval between switches (a contactor should not be cycled rapidly),
and, like the rest of MQTT here, no authentication: anyone who can reach the broker can publish
the command.
