#!/bin/sh
# Builds and runs the host unit tests for the hardware-independent part of sdm_meter.
set -eu
cd "$(dirname "$0")/.."
out="$(mktemp -d)/test_sdm_modbus"
${CC:-cc} -std=c11 -Wall -Wextra -Werror -Iinclude sdm_modbus.c sdm_registers.c sdm_json.c test_host/test_sdm_modbus.c -lm -o "$out"
"$out"
