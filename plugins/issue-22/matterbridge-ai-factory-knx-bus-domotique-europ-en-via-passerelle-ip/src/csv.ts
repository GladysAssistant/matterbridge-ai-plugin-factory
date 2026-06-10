/**
 * CSV parsing for KNX device definitions exported from ETS.
 *
 * @file csv.ts
 * @license Apache-2.0
 */

export type KnxDeviceType = 'light' | 'switch' | 'cover' | 'climate' | 'sensor_temperature' | 'sensor_humidity' | 'binary_sensor';

export interface KnxDeviceDef {
  name: string;
  groupAddressWrite: string;
  groupAddressRead: string;
  groupAddressState: string;
  deviceType: KnxDeviceType;
  dpt: string;
  room: string;
  comment: string;
}

const VALID_TYPES: KnxDeviceType[] = ['light', 'switch', 'cover', 'climate', 'sensor_temperature', 'sensor_humidity', 'binary_sensor'];

/** Split one CSV line honoring simple double-quote quoting. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',' || c === ';') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const isGroupAddress = (s: string): boolean => /^\d+\/\d+\/\d+$/.test(s) || /^\d+\/\d+$/.test(s) || /^\d+$/.test(s);

/**
 * Parse the CSV content into validated KNX device definitions.
 *
 * @param {string} content - Raw CSV file content.
 * @returns {{ devices: KnxDeviceDef[]; errors: string[] }} Parsed devices and per-row errors.
 */
export function parseKnxCsv(content: string): { devices: KnxDeviceDef[]; errors: string[] } {
  const devices: KnxDeviceDef[] = [];
  const errors: string[] = [];

  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (lines.length === 0) return { devices, errors: ['CSV is empty'] };

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = (name: string): number => header.indexOf(name);

  const idx = {
    name: col('name'),
    write: col('group_address_write'),
    read: col('group_address_read'),
    state: col('group_address_state'),
    type: col('device_type'),
    dpt: col('dpt'),
    room: col('room'),
    comment: col('comment'),
  };

  if (idx.name < 0 || idx.type < 0 || idx.dpt < 0) {
    return { devices, errors: ['CSV header must contain at least: name, device_type, dpt'] };
  }

  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const get = (n: number): string => (n >= 0 && n < f.length ? f[n] : '');

    const name = get(idx.name);
    const deviceType = get(idx.type).toLowerCase() as KnxDeviceType;
    const dpt = get(idx.dpt);
    const write = get(idx.write);
    const read = get(idx.read);
    const state = get(idx.state);

    if (!name) {
      errors.push(`Row ${i + 1}: missing name`);
      continue;
    }
    if (!VALID_TYPES.includes(deviceType)) {
      errors.push(`Row ${i + 1} (${name}): invalid device_type "${deviceType}"`);
      continue;
    }
    if (!dpt) {
      errors.push(`Row ${i + 1} (${name}): missing dpt`);
      continue;
    }

    const readOnly = deviceType === 'sensor_temperature' || deviceType === 'sensor_humidity' || deviceType === 'binary_sensor';
    if (!readOnly && !write) {
      errors.push(`Row ${i + 1} (${name}): ${deviceType} requires group_address_write`);
      continue;
    }

    for (const [label, ga] of [
      ['group_address_write', write],
      ['group_address_read', read],
      ['group_address_state', state],
    ] as const) {
      if (ga && !isGroupAddress(ga)) errors.push(`Row ${i + 1} (${name}): invalid ${label} "${ga}"`);
    }

    devices.push({
      name,
      groupAddressWrite: write,
      groupAddressRead: read,
      // Default state to write GA so single-GA setups still receive feedback.
      groupAddressState: state || read || write,
      deviceType,
      dpt: dpt.replace(/^dpt[-\s]?/i, ''),
      room: get(idx.room),
      comment: get(idx.comment),
    });
  }

  return { devices, errors };
}
