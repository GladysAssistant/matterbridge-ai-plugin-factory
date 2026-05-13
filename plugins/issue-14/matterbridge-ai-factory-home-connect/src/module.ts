/**
 * Matterbridge Home Connect plugin.
 *
 * Exposes Home Connect appliances (dishwashers, ovens, washers, dryers, etc.)
 * as Matter devices with:
 *  - On/Off power control (BSH.Common.Setting.PowerState)
 *  - Door open/closed view (BSH.Common.Status.DoorState)
 *  - General operation state view (BSH.Common.Status.OperationState)
 *  - Active program view (BSH.Common.Root.ActiveProgram)
 *
 * Authorization uses the OAuth 2.0 Device Authorization Grant (RFC 8628).
 * Set `clientId` and (optionally) `country`, then enable `authorize` in the
 * plugin config. The plugin logs a URL + user code; open it, approve access,
 * and the refresh token is saved back into the plugin config automatically.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { contactSensor, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, onOffOutlet, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

type Country = 'Worldwide' | 'China';

const HC_HOSTS: Record<Country, string> = {
  Worldwide: 'https://api.home-connect.com',
  China: 'https://api.home-connect.cn',
};

const HC_SCOPES = 'IdentifyAppliance Monitor Settings Control';

interface HomeConnectConfig extends PlatformConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  country?: Country;
  authorize?: boolean;
  simulator?: boolean;
  pollIntervalSec?: number;
}

interface HCAppliance {
  haId: string;
  name: string;
  brand: string;
  vib: string;
  type: string;
  enumber: string;
  connected: boolean;
}

interface HCStatusItem {
  key: string;
  value: string | number | boolean;
}

interface ApplianceState {
  power: boolean;
  doorOpen: boolean;
  operationState: string;
  activeProgram: string;
}

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  id_token?: string;
}

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): HomeConnectPlatform {
  return new HomeConnectPlatform(matterbridge, log, config);
}

export class HomeConnectPlatform extends MatterbridgeDynamicPlatform {
  private accessToken: string | null = null;
  private accessTokenExpiry = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private deviceFlowAbort: AbortController | null = null;
  private readonly endpoints = new Map<string, MatterbridgeEndpoint>();
  private readonly state = new Map<string, ApplianceState>();
  private readonly hcConfig: HomeConnectConfig;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(`This plugin requires Matterbridge >= 3.4.0. Current: ${this.matterbridge.matterbridgeVersion}.`);
    }

    this.hcConfig = config as HomeConnectConfig;
    if (!this.hcConfig.country) this.hcConfig.country = 'Worldwide';
    this.log.info('Initializing matterbridge-ai-factory-home-connect...');
  }

  private get hcBase(): string {
    return HC_HOSTS[this.hcConfig.country ?? 'Worldwide'];
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart (${reason ?? 'none'})`);
    await this.ready;
    await this.clearSelect();

    if (this.hcConfig.simulator === true) {
      this.log.notice('Simulator mode enabled - exposing demo appliance.');
      await this.discoverSimulator();
      return;
    }

    if (!this.hcConfig.clientId) {
      this.log.error('Home Connect "clientId" missing. Create a Device Flow application at https://developer.home-connect.com/applications and enter the Client ID in the plugin config.');
      return;
    }

    if (this.hcConfig.authorize === true && !this.hcConfig.refreshToken) {
      this.log.notice('Authorization requested - starting Device Flow. Watch the log for the verification URL.');
      this.runDeviceFlow().catch((e) => this.log.error(`Device Flow failed: ${(e as Error).message}`));
      return;
    }

    if (!this.hcConfig.refreshToken) {
      this.log.error('Home Connect not authorized yet. Set "authorize": true in the plugin config (or enable simulator mode) and restart.');
      return;
    }

    try {
      await this.refreshAccessToken();
      await this.discoverAppliances();
    } catch (e) {
      this.log.error(`Failed to discover appliances from Home Connect: ${(e as Error).message}`);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure');

    for (const [haId, ep] of this.endpoints) {
      const s = this.state.get(haId);
      if (!s) continue;
      await ep.updateAttribute('OnOff', 'onOff', s.power, this.log);
      await ep.updateAttribute('BooleanState', 'stateValue', !s.doorOpen, this.log);
      await ep.addUserLabel('OperationState', s.operationState);
      await ep.addUserLabel('ActiveProgram', s.activeProgram);
    }

    const interval = Math.max(15, this.hcConfig.pollIntervalSec ?? 60) * 1000;
    if (this.accessToken && this.endpoints.size > 0) {
      this.pollTimer = setInterval(() => {
        this.pollAll().catch((e) => this.log.error(`Poll error: ${(e as Error).message}`));
      }, interval);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown (${reason ?? 'none'})`);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.deviceFlowAbort) {
      this.deviceFlowAbort.abort();
      this.deviceFlowAbort = null;
    }
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  // ------------------------------------------------------------------
  // OAuth2 - Device Authorization Grant (RFC 8628)
  // ------------------------------------------------------------------

  private async runDeviceFlow(): Promise<void> {
    const clientId = this.hcConfig.clientId ?? '';
    const body = new URLSearchParams({ client_id: clientId, scope: HC_SCOPES });

    const res = await fetch(`${this.hcBase}/security/oauth/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`device_authorization ${res.status}: ${await res.text()}`);
    const auth = (await res.json()) as DeviceAuthResponse;

    const url = auth.verification_uri_complete ?? `${auth.verification_uri}?user_code=${auth.user_code}`;
    this.log.notice('================================================================');
    this.log.notice('Home Connect authorization required.');
    this.log.notice(`Open this URL in a browser and approve access:`);
    this.log.notice(`  ${url}`);
    this.log.notice(`User code: ${auth.user_code}`);
    this.log.notice(`The plugin will poll for up to ${Math.round(auth.expires_in / 60)} minutes.`);
    this.log.notice('================================================================');

    this.deviceFlowAbort = new AbortController();
    const token = await this.pollDeviceToken(auth, clientId, this.deviceFlowAbort.signal);
    this.deviceFlowAbort = null;

    this.accessToken = token.access_token;
    this.accessTokenExpiry = Date.now() + (token.expires_in - 60) * 1000;
    this.hcConfig.refreshToken = token.refresh_token;
    this.hcConfig.authorize = false;
    this.saveConfig(this.hcConfig);
    this.log.notice('Home Connect authorization complete - refresh token saved. Discovering appliances...');

    try {
      await this.discoverAppliances();
    } catch (e) {
      this.log.error(`Failed to discover appliances after authorization: ${(e as Error).message}`);
    }
  }

  private async pollDeviceToken(auth: DeviceAuthResponse, clientId: string, signal: AbortSignal): Promise<TokenResponse> {
    const deadline = Date.now() + auth.expires_in * 1000;
    let interval = Math.max(5, auth.interval || 5) * 1000;

    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('aborted');
      await delay(interval, signal);

      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: auth.device_code,
        client_id: clientId,
      });
      if (this.hcConfig.clientSecret) body.set('client_secret', this.hcConfig.clientSecret);

      const res = await fetch(`${this.hcBase}/security/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const text = await res.text();
      let json: { error?: string; error_description?: string } & Partial<TokenResponse>;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`token poll ${res.status}: ${text}`);
      }
      if (res.ok && json.access_token && json.refresh_token) return json as TokenResponse;
      const err = json.error ?? `http_${res.status}`;
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') {
        interval += 5000;
        continue;
      }
      if (err === 'expired_token' || err === 'access_denied') throw new Error(`Authorization ${err}.`);
      throw new Error(`token poll error: ${err}: ${json.error_description ?? ''}`);
    }
    throw new Error('Device Flow expired before approval.');
  }

  private async refreshAccessToken(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.hcConfig.refreshToken ?? '',
      client_id: this.hcConfig.clientId ?? '',
    });
    if (this.hcConfig.clientSecret) body.set('client_secret', this.hcConfig.clientSecret);

    const res = await fetch(`${this.hcBase}/security/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`token refresh ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as TokenResponse;
    this.accessToken = j.access_token;
    this.accessTokenExpiry = Date.now() + (j.expires_in - 60) * 1000;
    if (j.refresh_token && j.refresh_token !== this.hcConfig.refreshToken) {
      this.hcConfig.refreshToken = j.refresh_token;
      this.saveConfig(this.hcConfig);
    }
    this.log.debug('Home Connect access token refreshed.');
  }

  private async ensureToken(): Promise<string> {
    if (!this.accessToken || Date.now() >= this.accessTokenExpiry) await this.refreshAccessToken();
    return this.accessToken as string;
  }

  private async hcGet<T>(path: string): Promise<T> {
    const token = await this.ensureToken();
    const res = await fetch(`${this.hcBase}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.bsh.sdk.v1+json' },
    });
    if (!res.ok) throw new Error(`GET ${path} ${res.status}`);
    return (await res.json()) as T;
  }

  private async hcPut(path: string, data: unknown): Promise<void> {
    const token = await this.ensureToken();
    const res = await fetch(`${this.hcBase}${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.bsh.sdk.v1+json',
        'Content-Type': 'application/vnd.bsh.sdk.v1+json',
      },
      body: JSON.stringify({ data }),
    });
    if (!res.ok) throw new Error(`PUT ${path} ${res.status}: ${await res.text()}`);
  }

  // ------------------------------------------------------------------
  // Discovery
  // ------------------------------------------------------------------

  private async discoverAppliances(): Promise<void> {
    const resp = await this.hcGet<{ data: { homeappliances: HCAppliance[] } }>('/api/homeappliances');
    const list = resp.data.homeappliances ?? [];
    this.log.info(`Discovered ${list.length} Home Connect appliances.`);
    for (const a of list) {
      this.setSelectDevice(a.haId, a.name);
      const selected = this.validateDevice([a.name, a.haId]);
      if (!selected) continue;
      await this.addAppliance(a, false);
    }
  }

  private async discoverSimulator(): Promise<void> {
    const sim: HCAppliance = {
      haId: 'SIEMENS-HCS06CM1-DEMO00000001',
      name: 'Demo Dishwasher',
      brand: 'Siemens',
      vib: 'HCS06CM1',
      type: 'Dishwasher',
      enumber: 'HCS06CM1/01',
      connected: true,
    };
    this.setSelectDevice(sim.haId, sim.name);
    const selected = this.validateDevice([sim.name, sim.haId]);
    if (selected) await this.addAppliance(sim, true);
  }

  private async addAppliance(a: HCAppliance, simulated: boolean): Promise<void> {
    const ep = new MatterbridgeEndpoint([onOffOutlet, contactSensor], { id: `hc_${a.haId}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        a.name,
        a.haId,
        this.matterbridge.aggregatorVendorId,
        a.brand || 'Home Connect',
        a.vib || a.type || 'Appliance',
        1,
        '1.0.0',
      )
      .createDefaultPowerSourceWiredClusterServer()
      .createDefaultOnOffClusterServer(false)
      .createDefaultBooleanStateClusterServer(true)
      .addRequiredClusterServers()
      .addCommandHandler('on', async () => {
        await this.setPower(a.haId, true);
      })
      .addCommandHandler('off', async () => {
        await this.setPower(a.haId, false);
      });

    const initial: ApplianceState = { power: false, doorOpen: false, operationState: 'Inactive', activeProgram: 'None' };

    if (!simulated && a.connected) {
      try {
        const status = await this.hcGet<{ data: { status: HCStatusItem[] } }>(`/api/homeappliances/${a.haId}/status`);
        for (const s of status.data.status ?? []) this.applyKeyToState(initial, s.key, s.value);
        try {
          const settings = await this.hcGet<{ data: { settings: HCStatusItem[] } }>(`/api/homeappliances/${a.haId}/settings`);
          for (const s of settings.data.settings ?? []) this.applyKeyToState(initial, s.key, s.value);
        } catch {
          /* settings unsupported on some appliances */
        }
        try {
          const prog = await this.hcGet<{ data: { key: string } }>(`/api/homeappliances/${a.haId}/programs/active`);
          if (prog?.data?.key) initial.activeProgram = shortKey(prog.data.key);
        } catch {
          /* no active program */
        }
      } catch (e) {
        this.log.warn(`Could not read initial state for ${a.name}: ${(e as Error).message}`);
      }
    } else if (simulated) {
      initial.power = true;
      initial.operationState = 'Run';
      initial.activeProgram = 'Auto2';
    }

    this.endpoints.set(a.haId, ep);
    this.state.set(a.haId, initial);

    await this.registerDevice(ep);
    this.log.info(`Registered ${a.brand} ${a.type} "${a.name}" (${a.haId})${simulated ? ' [SIM]' : ''}`);
  }

  // ------------------------------------------------------------------
  // Polling / state sync
  // ------------------------------------------------------------------

  private async pollAll(): Promise<void> {
    for (const haId of this.endpoints.keys()) {
      try {
        await this.pollOne(haId);
      } catch (e) {
        this.log.debug(`Poll ${haId} failed: ${(e as Error).message}`);
      }
    }
  }

  private async pollOne(haId: string): Promise<void> {
    const ep = this.endpoints.get(haId);
    const cur = this.state.get(haId);
    if (!ep || !cur) return;

    const status = await this.hcGet<{ data: { status: HCStatusItem[] } }>(`/api/homeappliances/${haId}/status`);
    const next: ApplianceState = { ...cur };
    for (const s of status.data.status ?? []) this.applyKeyToState(next, s.key, s.value);

    try {
      const settings = await this.hcGet<{ data: { settings: HCStatusItem[] } }>(`/api/homeappliances/${haId}/settings`);
      for (const s of settings.data.settings ?? []) this.applyKeyToState(next, s.key, s.value);
    } catch {
      /* ignore */
    }

    try {
      const prog = await this.hcGet<{ data: { key: string } }>(`/api/homeappliances/${haId}/programs/active`);
      next.activeProgram = prog?.data?.key ? shortKey(prog.data.key) : 'None';
    } catch {
      next.activeProgram = 'None';
    }

    await this.applyState(haId, next);
  }

  private applyKeyToState(s: ApplianceState, key: string, value: string | number | boolean): void {
    switch (key) {
      case 'BSH.Common.Setting.PowerState':
        s.power = String(value).endsWith('.On');
        break;
      case 'BSH.Common.Status.DoorState':
        s.doorOpen = String(value).endsWith('.Open');
        break;
      case 'BSH.Common.Status.OperationState':
        s.operationState = shortKey(String(value));
        break;
      default:
        break;
    }
  }

  private async applyState(haId: string, next: ApplianceState): Promise<void> {
    const ep = this.endpoints.get(haId);
    const cur = this.state.get(haId);
    if (!ep || !cur) return;

    if (next.power !== cur.power) await ep.updateAttribute('OnOff', 'onOff', next.power, this.log);
    if (next.doorOpen !== cur.doorOpen) await ep.updateAttribute('BooleanState', 'stateValue', !next.doorOpen, this.log);
    if (next.operationState !== cur.operationState) {
      this.log.info(`[${haId}] OperationState: ${next.operationState}`);
      await ep.addUserLabel('OperationState', next.operationState);
    }
    if (next.activeProgram !== cur.activeProgram) {
      this.log.info(`[${haId}] ActiveProgram: ${next.activeProgram}`);
      await ep.addUserLabel('ActiveProgram', next.activeProgram);
    }

    this.state.set(haId, next);
  }

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------

  private async setPower(haId: string, on: boolean): Promise<void> {
    const cur = this.state.get(haId);
    if (!cur) return;
    if (this.accessToken) {
      try {
        await this.hcPut(`/api/homeappliances/${haId}/settings/BSH.Common.Setting.PowerState`, {
          key: 'BSH.Common.Setting.PowerState',
          value: on ? 'BSH.Common.EnumType.PowerState.On' : 'BSH.Common.EnumType.PowerState.Off',
        });
      } catch (e) {
        this.log.error(`PowerState set failed for ${haId}: ${(e as Error).message}`);
        return;
      }
    } else {
      this.log.info(`[SIM] PowerState ${on ? 'On' : 'Off'} for ${haId}`);
    }
    await this.applyState(haId, { ...cur, power: on });
  }
}

function shortKey(k: string): string {
  const i = k.lastIndexOf('.');
  return i >= 0 ? k.slice(i + 1) : k;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
