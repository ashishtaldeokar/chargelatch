# sdm_meter

Reads an Eastron SDM energy meter over RS-485 (Modbus RTU, input registers, function `0x04`,
big-endian 32-bit floats). `meter_telemetry` publishes the readings to MQTT.

## Wiring (defaults)

| ESP32            | RS-485 transceiver | Meter   |
| ---------------- | ------------------ | ------- |
| GPIO17 (**TX2**) | DI                 |         |
| GPIO16 (**RX2**) | RO                 |         |
| GPIO4            | DE + /RE (tied)    |         |
|                  | A                  | A (+)   |
|                  | B                  | B (−)   |

- Use a **3.3 V** transceiver, or level-shift RO: ESP32 inputs are not 5 V tolerant.
- The UART runs in hardware RS-485 half-duplex mode, so the chip raises DE exactly for the
  duration of each frame. Set the DE GPIO to `-1` for an auto-direction transceiver.
- GPIO16/17 are used by PSRAM on WROVER modules: pick other pins there.
- No answer at all? Swap A and B first, then check baud rate and the meter's Modbus ID.

**Which meter, and its serial settings, are device configuration, not a build option.** The factory
app writes `meter_model`, `meter_addr`, `meter_baud` and `meter_parity` into the `fctry` partition
with the identity (`device_identity_get_meter()`), and `main` passes them to
`meter_telemetry_start()`. One firmware serves every meter it has a table for. `idf.py menuconfig`
→ **chargelatch SDM energy meter** only holds the UART/pins and the *defaults* for a board without
factory data (`SDM120`, address 1, 2400 8N1).

## Register maps are constants

`include/sdm_registers.h` has every address as a named constant (`SDM120_REG_VOLTAGE = 0x0000`,
`SDM_REG_TOTAL_ACTIVE_ENERGY = 0x0156`, …) and `sdm_registers.c` has one table per model mapping
a JSON key to an address:

| Model    | Phases | Values | Requests per read |
| -------- | ------ | ------ | ----------------- |
| `SDM120` | 1      | 14     | 3                 |
| `SDM630` | 3      | 25     | 3                 |

Adjacent registers are fetched together (at most 40 registers per request, the Eastron limit), so
a full read is 3 requests rather than one per value: about 1 s at 2400 baud.

**Adding a meter:** add its address constants and a table (sorted by address, unique keys), an
`sdm_model_t` and its entry in `SDM_MODELS[]`, a `check_model()` line in the host test, and a preset
in `apps/firmware/meters.json` (the factory dropdown; the host test checks the names match). Then
release the firmware: the factory app only offers meters the bundled firmware lists. Keep key meanings stable across models: `power` is always total active
power in W, `voltage_l1` only exists on 3-phase meters, and so on. Consumers key off these names.

The SDM630 map is from Eastron's protocol document and has not been run against a real SDM630.

## Tests

`pnpm --filter @chargelatch/firmware run test:unit` (also part of the root `pnpm test:unit`)
compiles the hardware-independent files with the host compiler and checks request framing, CRC,
float decoding, error handling, block planning for both models and the JSON output, against
frames generated independently of this code. Only `sdm_meter.c` (UART) needs real hardware.
