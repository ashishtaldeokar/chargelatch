// How meter fields are labelled and ordered. Keys are the firmware's register-table names
// (apps/firmware/components/sdm_meter/sdm_registers.c); unknown keys still render, unformatted.

interface Field {
  label: string;
  unit: string;
  digits: number;
}

const FIELDS: Record<string, Field> = {
  power: { label: "Power", unit: "W", digits: 0 },
  voltage: { label: "Voltage", unit: "V", digits: 1 },
  current: { label: "Current", unit: "A", digits: 2 },
  power_factor: { label: "Power factor", unit: "", digits: 2 },
  frequency: { label: "Frequency", unit: "Hz", digits: 2 },
  apparent_power: { label: "Apparent power", unit: "VA", digits: 0 },
  reactive_power: { label: "Reactive power", unit: "VAr", digits: 0 },
  phase_angle: { label: "Phase angle", unit: "°", digits: 1 },
  total_energy: { label: "Total energy", unit: "kWh", digits: 2 },
  import_energy: { label: "Imported", unit: "kWh", digits: 2 },
  export_energy: { label: "Exported", unit: "kWh", digits: 2 },
  total_reactive_energy: { label: "Total reactive", unit: "kVArh", digits: 2 },
  import_reactive_energy: { label: "Reactive imported", unit: "kVArh", digits: 2 },
  export_reactive_energy: { label: "Reactive exported", unit: "kVArh", digits: 2 },
};

/** The headline numbers, shown large. Everything else goes under "All readings". */
export const PRIMARY_KEYS = ["power", "voltage", "current", "total_energy"];

export interface DisplayValue {
  key: string;
  label: string;
  text: string;
}

export function describeValue(key: string, value: number): DisplayValue {
  // voltage_l2 -> Voltage L2
  const phase = key.match(/^(.*)_l([123])$/);
  const field = FIELDS[phase ? phase[1]! : key];
  if (!field) return { key, label: key.replaceAll("_", " "), text: String(value) };
  const number = value.toLocaleString("en-US", { minimumFractionDigits: field.digits, maximumFractionDigits: field.digits });
  return { key, label: phase ? `${field.label} L${phase[2]}` : field.label, text: field.unit ? `${number} ${field.unit}` : number };
}

export function splitReadings(values: Record<string, number>): { primary: DisplayValue[]; rest: DisplayValue[] } {
  const primary = PRIMARY_KEYS.filter((key) => key in values).map((key) => describeValue(key, values[key]!));
  const rest = Object.keys(values)
    .filter((key) => !PRIMARY_KEYS.includes(key))
    .map((key) => describeValue(key, values[key]!));
  return { primary, rest };
}
