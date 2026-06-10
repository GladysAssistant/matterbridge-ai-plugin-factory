/**
 * Minimal client for the HomeWizard Energy local API (v1).
 *
 * The API is 100% local (no cloud). The user must enable "Local API" in the
 * HomeWizard Energy app: Settings -> Meters -> [device] -> Local API.
 *
 * @file homewizardApi.ts
 * @license Apache-2.0
 */

/** Device information returned by `GET /api`. */
export interface HomeWizardInfo {
  product_name?: string;
  product_type?: string;
  serial?: string;
  firmware_version?: string;
  api_version?: string;
}

/** Measurement payload returned by `GET /api/v1/data`. Fields depend on the product. */
export interface HomeWizardData {
  wifi_ssid?: string;
  wifi_strength?: number;
  // Energy (P1 / kWh / socket)
  total_power_import_kwh?: number;
  total_power_export_kwh?: number;
  active_power_w?: number;
  active_power_l1_w?: number;
  active_power_l2_w?: number;
  active_power_l3_w?: number;
  active_voltage_v?: number;
  active_voltage_l1_v?: number;
  active_voltage_l2_v?: number;
  active_voltage_l3_v?: number;
  active_current_a?: number;
  active_current_l1_a?: number;
  active_current_l2_a?: number;
  active_current_l3_a?: number;
  active_frequency_hz?: number;
  active_tariff?: number;
  // Watermeter (HWE-WTR)
  active_liter_lpm?: number;
  total_liter_m3?: number;
}

/** Relay state returned by `GET /api/v1/state` (energy socket only). */
export interface HomeWizardState {
  power_on?: boolean;
  switch_lock?: boolean;
  brightness?: number;
}

/**
 * Thin HTTP wrapper around a single HomeWizard device.
 */
export class HomeWizardApi {
  private readonly base: string;
  private readonly headers: Record<string, string>;

  /**
   * @param {string} host - Hostname or IP of the device.
   * @param {string} [token] - Optional bearer token for newer firmwares.
   */
  constructor(host: string, token?: string) {
    const h = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.base = `http://${h}`;
    this.headers = token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { headers: this.headers });
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Reads device information.
   *
   * @returns {Promise<HomeWizardInfo>} The device info.
   */
  async getInfo(): Promise<HomeWizardInfo> {
    return this.get<HomeWizardInfo>('/api');
  }

  /**
   * Reads the latest measurements.
   *
   * @returns {Promise<HomeWizardData>} The measurement payload.
   */
  async getData(): Promise<HomeWizardData> {
    return this.get<HomeWizardData>('/api/v1/data');
  }

  /**
   * Reads the relay state (energy socket only).
   *
   * @returns {Promise<HomeWizardState>} The relay state.
   */
  async getState(): Promise<HomeWizardState> {
    return this.get<HomeWizardState>('/api/v1/state');
  }

  /**
   * Sets the relay state (energy socket only).
   *
   * @param {HomeWizardState} state - Partial state to apply.
   * @returns {Promise<HomeWizardState>} The resulting state.
   */
  async setState(state: HomeWizardState): Promise<HomeWizardState> {
    const res = await fetch(`${this.base}/api/v1/state`, {
      method: 'PUT',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    if (!res.ok) throw new Error(`PUT /api/v1/state -> HTTP ${res.status}`);
    return (await res.json()) as HomeWizardState;
  }
}

/** Product type families. */
export type HomeWizardKind = 'energy' | 'socket' | 'water';

/**
 * Maps a HomeWizard `product_type` (or user hint) to a device family.
 *
 * @param {string} [productType] - The HomeWizard product type, e.g. `HWE-P1`.
 * @returns {HomeWizardKind} The mapped device family.
 */
export function kindFromProductType(productType?: string): HomeWizardKind {
  const t = (productType ?? '').toUpperCase();
  if (t.includes('WTR') || t.includes('WATER')) return 'water';
  if (t.includes('SKT') || t.includes('SOCKET') || t.includes('PLUG')) return 'socket';
  return 'energy'; // HWE-P1, HWE-KWH1, HWE-KWH3, SDM230, SDM630, ...
}
