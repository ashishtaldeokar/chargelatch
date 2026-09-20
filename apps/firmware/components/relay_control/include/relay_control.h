/*
 * The relay on CONFIG_RELAY_GPIO (default GPIO26) that switches the contactor.
 */
#pragma once

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Configures the GPIO and applies the initial state: the last one stored in NVS
 * (CONFIG_RELAY_RESTORE_STATE), otherwise off. Call this first thing in app_main: it does not
 * wait for Wi-Fi, so the contactor is back in its previous state within milliseconds of boot.
 * The pin is driven to its level before it is made an output, so it never glitches "on".
 */
esp_err_t relay_control_init(void);

/** Switches the relay and persists the new state. Safe to call from any task. */
esp_err_t relay_control_set(bool on);

bool relay_control_is_on(void);

#ifdef __cplusplus
}
#endif
