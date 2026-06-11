/**
 * Matterbridge ESPHome Native API plugin.
 *
 * Connects to ESPHome DIY ESP32/ESP8266 devices over the Native API (TCP 6053),
 * discovers their entities dynamically and exposes them as Matter devices.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { readFileSync } from 'node:fs';

import {
  BasePlatformConfig,
  DeviceTypeDefinition,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  bridgedNode,
  colorTemperatureLight,
  contactSensor,
  coverDevice,
  dimmableLight,
  extendedColorLight,
  fanDevice,
  humiditySensor,
  lightSensor,
  occupancySensor,
  onOffLight,
  onOffOutlet,
  powerSource,
  pressureSensor,
  temperatureSensor,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import {
  BooleanState,
  ColorControl,
  FanControl,
  LevelControl,
  OnOff,
  WindowCovering,
} from 'matterbridge/matter/clusters';

import { EspHomeClient, type Entity } from 'esphome-client';

export type EspHomeDeviceConfig = {
  name?: string;
  host: string;
  port?: number;
  password?: string;
  encryption_key?: string;
};

export type EspHomePlatformConfig = BasePlatformConfig & {
  devices?: EspHomeDeviceConfig[];
  csvPath?: string;
  whiteList?: string[];
  blackList?: string[];
};

/** ESPHome ColorMode bit flags (subset). */
const COLORMODE_RGB = [35, 39, 47, 51];
const COLORMODE_CT = [11, 47, 51];
const COLORMODE_BRIGHTNESS = [3, 7, 11, 19, 35, 39, 47, 51];

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: EspHomePlatformConfig): EspHomePlatform {
  return new EspHomePlatform(matterbridge, log, config);
}

type EntityBinding = {
  endpoint: MatterbridgeEndpoint;
  entity: Entity;
  id: string; // command id: `${type}-${objectId}`
};

export class EspHomePlatform extends MatterbridgeDynamicPlatform {
  private readonly clients = new Map<string, EspHomeClient>();
  // device host -> (entity key -> binding)
  private readonly bindings = new Map<string, Map<number, EntityBinding>>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: EspHomePlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }
    this.log.info('Initializing ESPHome Native API platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const devices = this.loadDeviceList();
    if (devices.length === 0) {
      this.log.warn('No ESPHome devices configured. Add devices in the plugin config or provide a csvPath.');
      return;
    }

    await Promise.all(devices.map((d) => this.connectDevice(d)));
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    for (const client of this.clients.values()) {
      try {
        client.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.bindings.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /** Merge config.devices with an optional CSV file. */
  private loadDeviceList(): EspHomeDeviceConfig[] {
    const cfg = this.config as EspHomePlatformConfig;
    const list: EspHomeDeviceConfig[] = Array.isArray(cfg.devices) ? [...cfg.devices] : [];

    if (cfg.csvPath) {
      try {
        const text = readFileSync(cfg.csvPath, 'utf8');
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        const header = lines.shift()?.toLowerCase().split(',').map((h) => h.trim()) ?? [];
        const idx = (k: string) => header.indexOf(k);
        for (const line of lines) {
          const cols = line.split(',').map((c) => c.trim());
          const host = cols[idx('host')];
          if (!host) continue;
          list.push({
            name: cols[idx('name')] || host,
            host,
            port: cols[idx('port')] ? Number(cols[idx('port')]) : 6053,
            encryption_key: cols[idx('encryption_key')] || undefined,
          });
        }
      } catch (e) {
        this.log.error(`Failed to read csvPath "${cfg.csvPath}": ${(e as Error).message}`);
      }
    }
    return list.filter((d) => d && d.host);
  }

  private connectDevice(dev: EspHomeDeviceConfig): Promise<void> {
    const host = dev.host;
    const port = dev.port ?? 6053;
    const label = dev.name || host;

    const client = new EspHomeClient({
      host,
      port,
      psk: dev.encryption_key || null,
      logger: {
        debug: (m: string) => this.log.debug(`[${label}] ${m}`),
        info: (m: string) => this.log.debug(`[${label}] ${m}`),
        warn: (m: string) => this.log.warn(`[${label}] ${m}`),
        error: (m: string) => this.log.error(`[${label}] ${m}`),
      },
    });

    this.clients.set(host, client);
    this.bindings.set(host, new Map());

    client.on('connect', () => this.log.info(`Connected to ESPHome device "${label}" (${host}:${port})`));
    client.on('disconnect', (reason) => this.log.warn(`Disconnected from "${label}": ${reason ?? 'unknown'}`));
    // EventEmitter 'error' is not in the typed event map; attach defensively to avoid unhandled throws.
    (client as unknown as { on(e: string, l: (...a: unknown[]) => void): void }).on('error', (err: unknown) =>
      this.log.error(`Error from "${label}": ${(err as Error)?.message ?? String(err)}`),
    );

    client.on('entities', (entities) => {
      void this.onEntities(dev, label, client, entities);
    });

    // State updates.
    client.on('switch', (e) => void this.applyState(host, e.key, (b) => b.endpoint.setAttribute(OnOff.Cluster.id, 'onOff', !!e.state, b.endpoint.log)));
    client.on('light', (e) => void this.onLightState(host, e));
    client.on('cover', (e) => void this.onCoverState(host, e));
    client.on('fan', (e) => void this.onFanState(host, e));
    client.on('binary_sensor', (e) => void this.onBinaryState(host, e));
    client.on('sensor', (e) => void this.onSensorState(host, e));

    try {
      client.connect();
    } catch (e) {
      this.log.error(`Failed to connect to "${label}": ${(e as Error).message}`);
    }
    return Promise.resolve();
  }

  private async onEntities(dev: EspHomeDeviceConfig, label: string, client: EspHomeClient, entities: Entity[]): Promise<void> {
    this.log.info(`Discovered ${entities.length} entities on "${label}"`);
    const map = this.bindings.get(dev.host)!;

    for (const entity of entities) {
      const endpoint = this.buildEndpoint(dev, label, client, entity);
      if (!endpoint) continue;

      const serial = `${dev.host}-${entity.type}-${entity.objectId}`;
      const friendly = `${label} ${entity.name || entity.objectId}`;
      this.setSelectDevice(serial, friendly);
      if (!this.validateDevice([friendly, serial])) continue;

      try {
        await this.registerDevice(endpoint);
        const cmdId = `${entity.type}-${entity.objectId}`;
        map.set(entity.key, { endpoint, entity, id: cmdId });
        if (entity.type === 'fan') {
          await endpoint.subscribeAttribute(
            FanControl.Cluster.id,
            'percentSetting',
            (value: number | null) => client.sendFanCommand(cmdId, { state: (value ?? 0) > 0, speedLevel: value ?? 0 }),
            endpoint.log,
          );
        }
        this.log.debug(`Registered ${entity.type} "${friendly}"`);
      } catch (e) {
        this.log.error(`Failed to register "${friendly}": ${(e as Error).message}`);
      }
    }
  }

  /** Build a Matter endpoint for an ESPHome entity, or null if unsupported. */
  private buildEndpoint(dev: EspHomeDeviceConfig, label: string, client: EspHomeClient, entity: Entity): MatterbridgeEndpoint | null {
    const serial = `${dev.host}-${entity.type}-${entity.objectId}`.slice(0, 32);
    const friendly = `${label} ${entity.name || entity.objectId}`;
    const id = `${entity.type}-${entity.objectId}`;

    const base = (deviceType: DeviceTypeDefinition) =>
      new MatterbridgeEndpoint([deviceType, bridgedNode, powerSource], { id: serial.replace(/[^a-zA-Z0-9_-]/g, '_') })
        .createDefaultBridgedDeviceBasicInformationClusterServer(friendly, serial, 0xfff1, 'ESPHome', entity.type, 1, '1.0.0')
        .createDefaultPowerSourceWiredClusterServer();

    switch (entity.type) {
      case 'switch': {
        const ep = base(onOffOutlet).createDefaultIdentifyClusterServer().createDefaultOnOffClusterServer().addRequiredClusterServers();
        ep.addCommandHandler('on', () => client.sendSwitchCommand(id, true));
        ep.addCommandHandler('off', () => client.sendSwitchCommand(id, false));
        return ep;
      }
      case 'light':
        return this.buildLight(base, client, id, entity);
      case 'cover': {
        const ep = base(coverDevice).createDefaultIdentifyClusterServer().createDefaultLiftTiltWindowCoveringClusterServer().addRequiredClusterServers();
        ep.addCommandHandler('upOrOpen', () => client.sendCoverCommand(id, { position: 1.0 }));
        ep.addCommandHandler('downOrClose', () => client.sendCoverCommand(id, { position: 0.0 }));
        ep.addCommandHandler('stopMotion', () => client.sendCoverCommand(id, { stop: true }));
        ep.addCommandHandler('goToLiftPercentage', ({ request }) => {
          const pct = (request as WindowCovering.GoToLiftPercentageRequest).liftPercent100thsValue ?? 0;
          client.sendCoverCommand(id, { position: 1 - pct / 10000 });
        });
        return ep;
      }
      case 'fan': {
        // Fan write handlers are wired with subscribeAttribute after registration.
        return base(fanDevice).createDefaultIdentifyClusterServer().createDefaultFanControlClusterServer().addRequiredClusterServers();
      }
      case 'binary_sensor': {
        const dc = (entity as { deviceClass?: string }).deviceClass ?? '';
        if (/motion|occupancy|presence/i.test(dc)) {
          return base(occupancySensor).createDefaultIdentifyClusterServer().createDefaultOccupancySensingClusterServer(false).addRequiredClusterServers();
        }
        return base(contactSensor).createDefaultIdentifyClusterServer().createDefaultBooleanStateClusterServer(true).addRequiredClusterServers();
      }
      case 'sensor':
        return this.buildSensor(base, entity);
      default:
        this.log.debug(`Skipping unsupported entity type "${entity.type}" (${friendly})`);
        return null;
    }
  }

  private buildLight(
    base: (dt: DeviceTypeDefinition) => MatterbridgeEndpoint,
    client: EspHomeClient,
    id: string,
    entity: Entity,
  ): MatterbridgeEndpoint {
    const modes = (entity as { supportedColorModes?: number[] }).supportedColorModes ?? [];
    const hasRgb = modes.some((m) => COLORMODE_RGB.includes(m));
    const hasCt = modes.some((m) => COLORMODE_CT.includes(m));
    const hasBrightness = modes.some((m) => COLORMODE_BRIGHTNESS.includes(m));

    let ep: MatterbridgeEndpoint;
    if (hasRgb) {
      ep = base(extendedColorLight).createDefaultIdentifyClusterServer().createDefaultOnOffClusterServer().createDefaultLevelControlClusterServer().createDefaultColorControlClusterServer();
    } else if (hasCt) {
      ep = base(colorTemperatureLight).createDefaultIdentifyClusterServer().createDefaultOnOffClusterServer().createDefaultLevelControlClusterServer().createDefaultColorControlClusterServer();
    } else if (hasBrightness) {
      ep = base(dimmableLight).createDefaultIdentifyClusterServer().createDefaultOnOffClusterServer().createDefaultLevelControlClusterServer();
    } else {
      ep = base(onOffLight).createDefaultIdentifyClusterServer().createDefaultOnOffClusterServer();
    }
    ep.addRequiredClusterServers();

    ep.addCommandHandler('on', () => client.sendLightCommand(id, { state: true }));
    ep.addCommandHandler('off', () => client.sendLightCommand(id, { state: false }));

    if (hasBrightness || hasCt || hasRgb) {
      const onLevel = ({ request }: { request: LevelControl.MoveToLevelRequest }) => {
        client.sendLightCommand(id, { state: true, brightness: clamp01((request.level ?? 0) / 254) });
      };
      ep.addCommandHandler('moveToLevel', onLevel);
      ep.addCommandHandler('moveToLevelWithOnOff', onLevel);
    }
    if (hasCt) {
      ep.addCommandHandler('moveToColorTemperature', ({ request }) => {
        client.sendLightCommand(id, { state: true, colorTemperature: (request as ColorControl.MoveToColorTemperatureRequest).colorTemperatureMireds });
      });
    }
    if (hasRgb) {
      ep.addCommandHandler('moveToHueAndSaturation', ({ request }) => {
        const r = request as ColorControl.MoveToHueAndSaturationRequest;
        const rgb = hsvToRgb((r.hue ?? 0) / 254, (r.saturation ?? 0) / 254, 1);
        client.sendLightCommand(id, { state: true, rgb });
      });
    }
    return ep;
  }

  private buildSensor(base: (dt: DeviceTypeDefinition) => MatterbridgeEndpoint, entity: Entity): MatterbridgeEndpoint | null {
    const e = entity as { deviceClass?: string; unitOfMeasurement?: string };
    const dc = (e.deviceClass ?? '').toLowerCase();
    const unit = (e.unitOfMeasurement ?? '').toLowerCase();

    if (dc.includes('temperature') || unit.includes('°c') || unit === 'c' || unit.includes('°f')) {
      return base(temperatureSensor).createDefaultIdentifyClusterServer().createDefaultTemperatureMeasurementClusterServer().addRequiredClusterServers();
    }
    if (dc.includes('humidity') || unit === '%' && dc.includes('humidity')) {
      return base(humiditySensor).createDefaultIdentifyClusterServer().createDefaultRelativeHumidityMeasurementClusterServer().addRequiredClusterServers();
    }
    if (dc.includes('humidity')) {
      return base(humiditySensor).createDefaultIdentifyClusterServer().createDefaultRelativeHumidityMeasurementClusterServer().addRequiredClusterServers();
    }
    if (dc.includes('pressure') || unit.includes('hpa') || unit.includes('pa')) {
      return base(pressureSensor).createDefaultIdentifyClusterServer().createDefaultPressureMeasurementClusterServer().addRequiredClusterServers();
    }
    if (dc.includes('illuminance') || unit === 'lx' || unit === 'lux') {
      return base(lightSensor).createDefaultIdentifyClusterServer().createDefaultIlluminanceMeasurementClusterServer().addRequiredClusterServers();
    }
    this.log.debug(`Skipping sensor "${entity.name}" (deviceClass=${dc}, unit=${unit}) - no Matter mapping`);
    return null;
  }

  // ---- State handlers -------------------------------------------------------

  private async applyState(host: string, key: number, fn: (b: EntityBinding) => Promise<unknown> | unknown): Promise<void> {
    const b = this.bindings.get(host)?.get(key);
    if (!b) return;
    try {
      await fn(b);
    } catch (e) {
      this.log.debug(`State update failed for ${b.id}: ${(e as Error).message}`);
    }
  }

  private onLightState(host: string, e: { key: number; state?: boolean; brightness?: number; red?: number; green?: number; blue?: number }): Promise<void> {
    return this.applyState(host, e.key, async (b) => {
      const ep = b.endpoint;
      if (e.state !== undefined) await ep.setAttribute(OnOff.Cluster.id, 'onOff', !!e.state, ep.log);
      if (e.brightness !== undefined) await ep.setAttribute(LevelControl.Cluster.id, 'currentLevel', Math.max(1, Math.round(clamp01(e.brightness) * 254)), ep.log);
      if (e.red !== undefined && e.green !== undefined && e.blue !== undefined) {
        const { h, s } = rgbToHsv(e.red, e.green, e.blue);
        await ep.setAttribute(ColorControl.Cluster.id, 'currentHue', Math.round(h * 254), ep.log);
        await ep.setAttribute(ColorControl.Cluster.id, 'currentSaturation', Math.round(s * 254), ep.log);
      }
    });
  }

  private onCoverState(host: string, e: { key: number; position?: number }): Promise<void> {
    return this.applyState(host, e.key, async (b) => {
      if (e.position === undefined) return;
      const pct = Math.round((1 - clamp01(e.position)) * 10000); // 0=open .. 10000=closed
      await b.endpoint.setAttribute(WindowCovering.Cluster.id, 'currentPositionLiftPercent100ths', pct, b.endpoint.log);
      await b.endpoint.setAttribute(WindowCovering.Cluster.id, 'targetPositionLiftPercent100ths', pct, b.endpoint.log);
    });
  }

  private onFanState(host: string, e: { key: number; state?: boolean; speedLevel?: number }): Promise<void> {
    return this.applyState(host, e.key, async (b) => {
      const pct = e.state === false ? 0 : Math.max(0, Math.min(100, Math.round(e.speedLevel ?? (e.state ? 100 : 0))));
      await b.endpoint.setAttribute(FanControl.Cluster.id, 'percentCurrent', pct, b.endpoint.log);
      await b.endpoint.setAttribute(FanControl.Cluster.id, 'percentSetting', pct, b.endpoint.log);
    });
  }

  private onBinaryState(host: string, e: { key: number; state?: boolean }): Promise<void> {
    return this.applyState(host, e.key, async (b) => {
      if (e.state === undefined) return;
      if (b.entity.type === 'binary_sensor' && /motion|occupancy|presence/i.test((b.entity as { deviceClass?: string }).deviceClass ?? '')) {
        await b.endpoint.setAttribute('OccupancySensing', 'occupancy', { occupied: !!e.state }, b.endpoint.log);
      } else {
        // Matter contact sensor: true = closed/no-contact-detected. ESPHome true = detected/open.
        await b.endpoint.setAttribute(BooleanState.Cluster.id, 'stateValue', !e.state, b.endpoint.log);
      }
    });
  }

  private onSensorState(host: string, e: { key: number; state?: number }): Promise<void> {
    return this.applyState(host, e.key, async (b) => {
      if (e.state === undefined || e.state === null || Number.isNaN(e.state)) return;
      const ep = b.endpoint;
      const v = e.state;
      const unit = ((b.entity as { unitOfMeasurement?: string }).unitOfMeasurement ?? '').toLowerCase();
      const dc = ((b.entity as { deviceClass?: string }).deviceClass ?? '').toLowerCase();

      if (dc.includes('temperature') || unit.includes('°c') || unit.includes('°f') || unit === 'c') {
        await ep.setAttribute('TemperatureMeasurement', 'measuredValue', Math.round(v * 100), ep.log);
      } else if (dc.includes('humidity')) {
        await ep.setAttribute('RelativeHumidityMeasurement', 'measuredValue', Math.round(v * 100), ep.log);
      } else if (dc.includes('pressure') || unit.includes('hpa') || unit.includes('pa')) {
        await ep.setAttribute('PressureMeasurement', 'measuredValue', Math.round(v), ep.log);
      } else if (dc.includes('illuminance') || unit === 'lx' || unit === 'lux') {
        const measured = v > 0 ? Math.round(10000 * Math.log10(v) + 1) : 0;
        await ep.setAttribute('IlluminanceMeasurement', 'measuredValue', Math.max(0, Math.min(0xfffe, measured)), ep.log);
      }
    });
  }
}

// ---- Helpers ----------------------------------------------------------------

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** h,s,v in 0..1 -> rgb in 0..1 */
function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return { r, g, b };
}

/** rgb in 0..1 -> h,s in 0..1 */
function rgbToHsv(r: number, g: number, b: number): { h: number; s: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s };
}
