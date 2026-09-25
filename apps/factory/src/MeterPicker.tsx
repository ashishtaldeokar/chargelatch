import { useEffect, useState } from "react";
import type { MeterConfig } from "./lib/api.ts";
import type { MeterPreset } from "./lib/firmware.ts";

interface MeterPickerProps {
  presets: MeterPreset[];
  value: MeterConfig | null;
  onChange: (meter: MeterConfig) => void;
  disabled?: boolean;
}

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400];

/**
 * Which energy meter is wired to the unit being flashed. Operators pick a preset (model + its
 * factory serial settings); address/baud/parity are under "Serial settings" for the rare meter
 * that was reconfigured. Presets come from the firmware bundle, so the list always matches what
 * the flashed firmware can read.
 */
export function MeterPicker({ presets, value, onChange, disabled }: MeterPickerProps) {
  if (presets.length === 0) {
    return <p role="alert">This firmware bundle lists no meters. Rebuild it with `pnpm firmware:bundle` from a firmware that has meters.json.</p>;
  }
  const preset = presets.find((p) => p.model === value?.model) ?? presets[0]!;
  // The address is edited as text and only clamped on blur, so clearing the field to retype it
  // does not snap to 1 mid-edit.
  const [addressText, setAddressText] = useState(String(value?.address ?? preset.address));
  useEffect(() => setAddressText(String(value?.address ?? preset.address)), [value?.address, preset.address]);
  const config = value ?? { model: preset.model, address: preset.address, baud: preset.baud, parity: preset.parity };
  const customised = config.address !== preset.address || config.baud !== preset.baud || config.parity !== preset.parity;

  return (
    <fieldset className="meter" disabled={disabled}>
      <legend>Energy meter</legend>
      <label>
        Model
        <select
          value={config.model}
          onChange={(e) => {
            const next = presets.find((p) => p.model === e.target.value)!;
            onChange({ model: next.model, address: next.address, baud: next.baud, parity: next.parity });
          }}
        >
          {presets.map((p) => (
            <option key={p.model} value={p.model}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <details open={customised}>
        <summary>
          Serial settings: address {config.address}, {config.baud} baud, parity {config.parity}
          {customised ? " (changed from the meter's defaults)" : ""}
        </summary>
        <div className="serial">
          <label>
            Modbus address
            <input
              type="number"
              min={1}
              max={247}
              value={addressText}
              onChange={(e) => setAddressText(e.target.value)}
              onBlur={() => onChange({ ...config, address: Math.min(247, Math.max(1, Number(addressText) || 1)) })}
            />
          </label>
          <label>
            Baud rate
            <select value={config.baud} onChange={(e) => onChange({ ...config, baud: Number(e.target.value) })}>
              {BAUD_RATES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label>
            Parity
            <select value={config.parity} onChange={(e) => onChange({ ...config, parity: e.target.value as MeterConfig["parity"] })}>
              <option value="none">None (8N1)</option>
              <option value="even">Even (8E1)</option>
              <option value="odd">Odd (8O1)</option>
            </select>
          </label>
          <button type="button" onClick={() => onChange({ model: preset.model, address: preset.address, baud: preset.baud, parity: preset.parity })} disabled={!customised}>
            Reset to defaults
          </button>
        </div>
      </details>
    </fieldset>
  );
}
