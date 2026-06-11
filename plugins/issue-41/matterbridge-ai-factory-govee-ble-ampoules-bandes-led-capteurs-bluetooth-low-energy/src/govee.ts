/**
 * Govee BLE protocol helpers: advertisement parsing (sensors) and GATT packet
 * building (lights). Implements the well documented 0x33 packet format used by
 * Govee H6xxx LED devices and the govee-ble sensor advertisement formats.
 *
 * @file govee.ts
 * @license Apache-2.0
 */

/** GATT control characteristic used by Govee BLE lights (write without response). */
export const GOVEE_WRITE_CHAR = '00010203-0405-0607-0809-0a0b0c0d2b11';
/** GATT control service used by Govee BLE lights. */
export const GOVEE_CONTROL_SERVICE = '000102030405060708090a0b0c0d1910';

export type GoveeDeviceType = 'light' | 'sensor';

/** Parsed sensor telemetry. All fields optional, only the supported ones are set. */
export interface GoveeReadings {
  /** Temperature in °C. */
  temperature?: number;
  /** Relative humidity in %. */
  humidity?: number;
  /** Battery level 0-100 %. */
  battery?: number;
  /** Motion / occupancy detected. */
  motion?: boolean;
  /** Contact open (true = open). */
  contactOpen?: boolean;
  /** Water leak detected. */
  leak?: boolean;
  /** Button index pressed (H5127 etc.), undefined if no press. */
  button?: number;
}

/** XOR checksum used as the last byte of every 20-byte Govee command frame. */
function frame(bytes: number[]): Buffer {
  const buf = Buffer.alloc(20, 0);
  for (let i = 0; i < bytes.length && i < 19; i++) buf[i] = bytes[i] & 0xff;
  let xor = 0;
  for (let i = 0; i < 19; i++) xor ^= buf[i];
  buf[19] = xor & 0xff;
  return buf;
}

/** Build an on/off command frame. */
export function buildPower(on: boolean): Buffer {
  return frame([0x33, 0x01, on ? 0x01 : 0x00]);
}

/** Build a brightness frame. level: Matter 0-254. Scaled to Govee 0-100. */
export function buildBrightness(matterLevel: number): Buffer {
  const pct = Math.max(0, Math.min(100, Math.round((matterLevel / 254) * 100)));
  return frame([0x33, 0x04, pct]);
}

/** Build an RGB color frame. */
export function buildColor(r: number, g: number, b: number): Buffer {
  return frame([0x33, 0x05, 0x02, r & 0xff, g & 0xff, b & 0xff, 0x00, 0xff, 0xae, 0x54]);
}

/** Build a color-temperature frame. kelvin + fallback rgb white point. */
export function buildColorTemperature(kelvin: number, r: number, g: number, b: number): Buffer {
  const k = Math.max(2000, Math.min(9000, Math.round(kelvin)));
  return frame([0x33, 0x05, 0x02, 0xff, 0xff, 0xff, 0x01, (k >> 8) & 0xff, k & 0xff, r & 0xff, g & 0xff, b & 0xff]);
}

/** Keep-alive frame (lights drop the GATT link without periodic traffic). */
export function buildKeepAlive(): Buffer {
  return frame([0xaa, 0x01]);
}

/** Convert mireds (Matter color temperature) to Kelvin. */
export function miredsToKelvin(mireds: number): number {
  return mireds > 0 ? Math.round(1_000_000 / mireds) : 4000;
}

/** Convert HSV (Matter hue 0-254, sat 0-254, val 0-254) to RGB 0-255. */
export function hsvToRgb(hue: number, sat: number, val: number): [number, number, number] {
  const h = (hue / 254) * 360;
  const s = sat / 254;
  const v = val / 254;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * Parse a Govee BLE advertisement into sensor readings.
 *
 * @param model - Govee model string from config (e.g. "H5179", "H5075", "H5121").
 * @param mfr - Manufacturer-specific data buffer from the advertisement.
 * @param localName - Advertised local name (used for format hints).
 * @returns Parsed readings (may be empty if nothing recognised).
 */
export function parseAdvertisement(model: string | undefined, mfr: Buffer | undefined, localName?: string): GoveeReadings {
  const out: GoveeReadings = {};
  if (!mfr || mfr.length < 4) return out;
  const m = (model ?? localName ?? '').toUpperCase();

  // H5179: <01><00><01><01><tempLE16><humLE16><battery>
  if (m.includes('H5179') && mfr.length >= 9) {
    out.temperature = mfr.readInt16LE(4) / 100;
    out.humidity = mfr.readUInt16LE(6) / 100;
    out.battery = mfr[8];
    return out;
  }

  // H5074 / H5052 / H5100: <flag><tempLE16 signed /100><humLE16 /100><battery>
  if ((m.includes('H5074') || m.includes('H5052') || m.includes('H5100')) && mfr.length >= 6) {
    out.temperature = mfr.readInt16LE(1) / 100;
    out.humidity = mfr.readUInt16LE(3) / 100;
    if (mfr.length >= 6) out.battery = mfr[5];
    return out;
  }

  // H5075 / H5072 / H5102 / H5101: packed 3-byte temp*humidity encoding + battery.
  if (m.includes('H5075') || m.includes('H5072') || m.includes('H5102') || m.includes('H5101') || m.includes('H5174')) {
    if (mfr.length >= 5) {
      let packed = (mfr[1] << 16) | (mfr[2] << 8) | mfr[3];
      const negative = (packed & 0x800000) !== 0;
      packed = packed & 0x7fffff;
      const temp = (negative ? -1 : 1) * (Math.floor(packed / 1000) / 10);
      const hum = (packed % 1000) / 10;
      out.temperature = temp;
      out.humidity = hum;
      out.battery = mfr[4];
      return out;
    }
  }

  // Binary / event sensors. Govee broadcasts a state byte on change; the event
  // byte position is model dependent. Use last data byte as the state flag.
  const state = mfr[mfr.length - 1];
  if (m.includes('H5121')) {
    out.motion = state !== 0; // motion sensor
    return out;
  }
  if (m.includes('H5123')) {
    out.contactOpen = state !== 0; // door/window contact (true = open)
    return out;
  }
  if (m.includes('H5054')) {
    out.leak = state !== 0; // water leak
    return out;
  }
  if (m.includes('H5127')) {
    out.button = state; // multi-button remote, byte = pressed index
    return out;
  }

  return out;
}
