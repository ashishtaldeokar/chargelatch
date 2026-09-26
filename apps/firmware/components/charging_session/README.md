# charging_session

A charging transaction: a third party starts it through the backend (contactor on) and stops
it (contactor off), and the device does the energy accounting from the meter's own cumulative
counter, so the figure is exact even if meter samples were missed on the way to the cloud.

| Topic | Direction | Payload |
| --- | --- | --- |
| `devices/<id>/cmd/tx` | → device | `{"op":"start","txId":"…","id":"<request>","interval":30}` · `{"op":"stop","txId":"…","id":"…"}` |
| `devices/<id>/tx` | device →, **retained** | `{"state":"active","txId","meterStart","interval","id"}` or `{"state":"idle","id"}`; republished on every MQTT connect |
| `devices/<id>/tx/end` | device →, QoS 1 | `{"txId","meterStart","meterStop","energyWh","reason","id"}` — `reason`: `remote`, `superseded`, `admin` |
| `devices/<id>/tx/meter` | device →, QoS 1 | `{"txId","seq","energyWh","meterKwh","reading":{…}}` every `interval` s (default `CONFIG_CHARGING_SESSION_METER_INTERVAL_SECONDS`, 30; a start may override, 5–3600) |

Rules the firmware enforces:

- **`start` with a different id while one is active ends the old one first** (`tx/end` with
  `superseded`), then starts the new one: two acks, in order, from one command. The same id again
  just re-confirms.
- **`stop` for an id that is not active** changes nothing and republishes the true state; the
  backend reconciles.
- **The transaction survives a reboot**: id, `meterStart` and interval are persisted in NVS
  (namespace `session`); `relay_control` restores the contactor. If the meter was unreadable at
  start, `meterStart` is taken from the first reading that arrives.
- **A plain relay "off" is refused while a transaction is active** (relay state is republished
  with `"rejected":"transaction_active"`); `"force":true` ends the transaction properly (reason
  `admin`) and then opens the contactor. This is a guard hook (`relay_remote_set_guard`), so
  `relay_control` does not depend on this component.
- `energyWh` is `max(0, (counter − meterStart) × 1000)`: a counter that went backwards (meter
  swapped) cannot produce a negative session. `null` when either end was unreadable; the backend
  then marks the session `partial`.
- Meter values are published only while connected; they are not queued during an outage (the
  summary does not depend on them).
