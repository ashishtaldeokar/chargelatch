#!/bin/sh
# Builds and runs the host unit tests for the hardware-independent part of sdm_meter.
set -eu
cd "$(dirname "$0")/.."
out="$(mktemp -d)/test_sdm_modbus"
${CC:-cc} -std=c11 -Wall -Wextra -Werror -Iinclude sdm_modbus.c sdm_registers.c sdm_json.c test_host/test_sdm_modbus.c -lm -o "$out"
"$out"

# meters.json (the factory app's dropdown) must only list models this firmware implements.
for model in $(grep -o '"model": *"[A-Z0-9]*"' ../../meters.json | sed 's/.*"\([A-Z0-9]*\)"$/\1/'); do
  grep -q "\"$model\"" sdm_registers.c || { echo "meters.json lists $model but sdm_registers.c has no such model"; exit 1; }
done
echo "meters.json matches sdm_registers.c"
