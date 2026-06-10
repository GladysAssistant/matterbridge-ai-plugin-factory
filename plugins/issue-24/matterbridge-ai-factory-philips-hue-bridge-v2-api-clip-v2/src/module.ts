/**
 * Philips Hue Bridge v2 (CLIP v2 API) Matterbridge dynamic platform.
 *
 * Exposes Hue lights, smart plugs and sensors connected to a Hue Bridge as
 * Matter devices. Control is performed via the CLIP v2 REST API and state is
 * kept in sync through the bridge SSE event stream.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  colorTemperatureLight,
  dimmableLight,
  extendedColorLight,
  genericSwitch,
  lightSensor,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  occupancySensor,
  onOffOutlet,
  PlatformMatterbridge,
  temperatureSensor,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { ColorControl, IlluminanceMeasurement, LevelControl, OccupancySensing, OnOff, TemperatureMeasurement } from 'matterbridge/matter/clusters';

import { HueClient, HueResource } from './hue.js';

/** Instance configuration for this platform. */
export type HuePlatformConfig = BasePlatformConfig & {
  host?: string;
  applicationKey?: string;
  whiteList: string[];
  blackList: string[];
};

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger.
 * @param {HuePlatformConfig} config - Platform configuration.
 * @returns {HuePlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: HuePlatformConfig): HuePlatform {
  return new HuePlatform(matterbridge, log, config);
}

// ---- Unit conversions between Hue CLIP v2 and Matter ----------------------

/** Matter currentLevel (1..254) -> Hue brightness (0..100). */
const levelToBrightness = (level: number): number => Math.max(0, Math.min(100, ((level - 1) / 253) * 100));
/** Hue brightness (0..100) -> Matter currentLevel (1..254). */
const brightnessToLevel = (b: number): number => Math.max(1, Math.min(254, Math.round((b / 100) * 253) + 1));
/** Matter currentX/Y (0..65535) -> Hue xy (0..1). */
const matterToXy = (v: number): number => Math.max(0, Math.min(1, v / 65535));
/** Hue xy (0..1) -> Matter currentX/Y (0..65535). */
const xyToMatter = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 65535);

/**
 * Matterbridge dynamic platform bridging a Philips Hue Bridge v2.
 */
export class HuePlatform extends MatterbridgeDynamicPlatform {
  declare config: HuePlatformConfig;
  private client?: HueClient;
  /** Maps Hue light/plug resource id -> Matter endpoint. */
  private readonly lights = new Map<string, MatterbridgeEndpoint>();
  /** Maps Hue sensor resource id -> Matter endpoint. */
  private readonly sensors = new Map<string, MatterbridgeEndpoint>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: HuePlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.7.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.7.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`);
    }

    this.log.info('Initializing Philips Hue (Bridge v2 / CLIP v2) platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const host = this.config.host;
    const appKey = this.config.applicationKey;
    if (!host || !appKey) {
      this.log.error('Hue bridge "host" and "applicationKey" must be configured. Press the bridge link button and run pairing to obtain a key.');
      return;
    }

    this.client = new HueClient(host, appKey, this.log);
    this.client.on('update', (item: HueResource) => this.handleEvent(item));

    await this.discoverDevices();

    this.client.connectEventStream();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    if (!this.client) return;
    // Refresh persisted attributes from the current bridge state.
    try {
      for (const light of await this.client.getResources('light')) this.applyLightState(light);
      for (const motion of await this.client.getResources('motion')) this.applyMotionState(motion);
      for (const temp of await this.client.getResources('temperature')) this.applyTemperatureState(temp);
      for (const ll of await this.client.getResources('light_level')) this.applyLightLevelState(ll);
    } catch (e) {
      this.log.error(`onConfigure refresh failed: ${(e as Error).message}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    this.client?.close();
    this.client = undefined;
    this.lights.clear();
    this.sensors.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  // ---- Discovery ----------------------------------------------------------

  private async discoverDevices(): Promise<void> {
    if (!this.client) return;
    this.log.info('Discovering Hue devices...');

    const [lights, devices, motions, temps, levels, buttons] = await Promise.all([
      this.client.getResources('light'),
      this.client.getResources('device'),
      this.client.getResources('motion'),
      this.client.getResources('temperature'),
      this.client.getResources('light_level'),
      this.client.getResources('button'),
    ]);

    // Index device names by service rid to provide friendly names.
    const nameByService = new Map<string, string>();
    for (const dev of devices) {
      const name = dev.metadata?.name ?? 'Hue Device';
      for (const svc of dev.services ?? []) nameByService.set(svc.rid, name);
    }

    for (const light of lights) await this.registerLight(light, nameByService.get(light.id) ?? light.metadata?.name ?? 'Hue Light');
    for (const motion of motions) await this.registerMotion(motion, nameByService.get(motion.id) ?? 'Hue Motion');
    for (const temp of temps) await this.registerTemperature(temp, nameByService.get(temp.id) ?? 'Hue Temperature');
    for (const level of levels) await this.registerLightLevel(level, nameByService.get(level.id) ?? 'Hue Light Level');
    for (const button of buttons) await this.registerButton(button, nameByService.get(button.id) ?? 'Hue Switch');
  }

  /** Determine whether a light resource is actually a smart plug. */
  private isPlug(light: HueResource): boolean {
    const archetype: string = light.metadata?.archetype ?? '';
    return archetype.includes('plug') || archetype.includes('outlet');
  }

  private async registerLight(light: HueResource, name: string): Promise<void> {
    const serial = `hue-light-${light.id}`;
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;

    const hasColor = !!light.color;
    const hasTemp = !!light.color_temperature;
    const hasDimming = !!light.dimming;
    const plug = this.isPlug(light);

    let deviceType = onOffOutlet;
    if (!plug) {
      if (hasColor) deviceType = extendedColorLight;
      else if (hasTemp) deviceType = colorTemperatureLight;
      else if (hasDimming) deviceType = dimmableLight;
      else deviceType = onOffOutlet;
    }

    const endpoint = new MatterbridgeEndpoint(deviceType, { id: serial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Signify', 'Philips Hue', 1, '1.0.0')
      .createDefaultIdentifyClusterServer()
      .createDefaultOnOffClusterServer(!!light.on?.on);

    if (!plug && hasDimming) endpoint.createDefaultLevelControlClusterServer(brightnessToLevel(light.dimming?.brightness ?? 100));
    if (!plug && (hasColor || hasTemp)) endpoint.createDefaultColorControlClusterServer(0, 0, 0, 0, light.color_temperature?.mirek ?? 250, 153, 500);

    endpoint.addRequiredClusterServers();

    // Command handlers -> Hue CLIP v2.
    endpoint.addCommandHandler('on', () => void this.client?.setOn(light.id, true));
    endpoint.addCommandHandler('off', () => void this.client?.setOn(light.id, false));
    if (!plug && hasDimming) {
      const onLevel = (data: any): void => {
        const level: number = data.request.level;
        void this.client?.updateLight(light.id, { dimming: { brightness: levelToBrightness(level) } });
      };
      endpoint.addCommandHandler('moveToLevel', onLevel);
      endpoint.addCommandHandler('moveToLevelWithOnOff', onLevel);
    }
    if (!plug && hasTemp) {
      endpoint.addCommandHandler('moveToColorTemperature', (data: any) => {
        const mirek = Math.max(153, Math.min(500, data.request.colorTemperatureMireds));
        void this.client?.updateLight(light.id, { color_temperature: { mirek } });
      });
    }
    if (!plug && hasColor) {
      endpoint.addCommandHandler('moveToColor', (data: any) => {
        void this.client?.updateLight(light.id, { color: { xy: { x: matterToXy(data.request.colorX), y: matterToXy(data.request.colorY) } } });
      });
    }

    await this.registerDevice(endpoint);
    this.lights.set(light.id, endpoint);
  }

  private async registerMotion(motion: HueResource, name: string): Promise<void> {
    const serial = `hue-motion-${motion.id}`;
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;
    const endpoint = new MatterbridgeEndpoint(occupancySensor, { id: serial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Signify', 'Philips Hue Motion', 1, '1.0.0')
      .createDefaultIdentifyClusterServer()
      .createDefaultOccupancySensingClusterServer(!!motion.motion?.motion)
      .addRequiredClusterServers();
    await this.registerDevice(endpoint);
    this.sensors.set(motion.id, endpoint);
  }

  private async registerTemperature(temp: HueResource, name: string): Promise<void> {
    const serial = `hue-temp-${temp.id}`;
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;
    const value = temp.temperature?.temperature;
    const endpoint = new MatterbridgeEndpoint(temperatureSensor, { id: serial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Signify', 'Philips Hue Temperature', 1, '1.0.0')
      .createDefaultIdentifyClusterServer()
      .createDefaultTemperatureMeasurementClusterServer(typeof value === 'number' ? Math.round(value * 100) : null)
      .addRequiredClusterServers();
    await this.registerDevice(endpoint);
    this.sensors.set(temp.id, endpoint);
  }

  private async registerLightLevel(level: HueResource, name: string): Promise<void> {
    const serial = `hue-lightlevel-${level.id}`;
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;
    const lux = level.light?.light_level;
    const endpoint = new MatterbridgeEndpoint(lightSensor, { id: serial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Signify', 'Philips Hue Light Level', 1, '1.0.0')
      .createDefaultIdentifyClusterServer()
      .createDefaultIlluminanceMeasurementClusterServer(typeof lux === 'number' ? lux : null)
      .addRequiredClusterServers();
    await this.registerDevice(endpoint);
    this.sensors.set(level.id, endpoint);
  }

  private async registerButton(button: HueResource, name: string): Promise<void> {
    const serial = `hue-button-${button.id}`;
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;
    const endpoint = new MatterbridgeEndpoint(genericSwitch, { id: serial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Signify', 'Philips Hue Switch', 1, '1.0.0')
      .createDefaultIdentifyClusterServer()
      .createDefaultMomentarySwitchClusterServer()
      .addRequiredClusterServers();
    await this.registerDevice(endpoint);
    this.sensors.set(button.id, endpoint);
  }

  // ---- Event stream / state sync -----------------------------------------

  private handleEvent(item: HueResource): void {
    switch (item.type) {
      case 'light':
        this.applyLightState(item);
        break;
      case 'motion':
        this.applyMotionState(item);
        break;
      case 'temperature':
        this.applyTemperatureState(item);
        break;
      case 'light_level':
        this.applyLightLevelState(item);
        break;
      case 'button':
        this.applyButtonState(item);
        break;
      default:
        break;
    }
  }

  private applyLightState(light: HueResource): void {
    const endpoint = this.lights.get(light.id);
    if (!endpoint) return;
    if (light.on) void endpoint.setAttribute(OnOff.Cluster.id, 'onOff', !!light.on.on, endpoint.log);
    if (light.dimming) void endpoint.setAttribute(LevelControl.Cluster.id, 'currentLevel', brightnessToLevel(light.dimming.brightness), endpoint.log);
    if (light.color_temperature?.mirek) void endpoint.setAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds', light.color_temperature.mirek, endpoint.log);
    if (light.color?.xy) {
      void endpoint.setAttribute(ColorControl.Cluster.id, 'currentX', xyToMatter(light.color.xy.x), endpoint.log);
      void endpoint.setAttribute(ColorControl.Cluster.id, 'currentY', xyToMatter(light.color.xy.y), endpoint.log);
    }
  }

  private applyMotionState(motion: HueResource): void {
    const endpoint = this.sensors.get(motion.id);
    if (!endpoint || motion.motion?.motion === undefined) return;
    void endpoint.setAttribute(OccupancySensing.Cluster.id, 'occupancy', { occupied: !!motion.motion.motion }, endpoint.log);
  }

  private applyTemperatureState(temp: HueResource): void {
    const endpoint = this.sensors.get(temp.id);
    const value = temp.temperature?.temperature;
    if (!endpoint || typeof value !== 'number') return;
    void endpoint.setAttribute(TemperatureMeasurement.Cluster.id, 'measuredValue', Math.round(value * 100), endpoint.log);
  }

  private applyLightLevelState(level: HueResource): void {
    const endpoint = this.sensors.get(level.id);
    const lux = level.light?.light_level;
    if (!endpoint || typeof lux !== 'number') return;
    void endpoint.setAttribute(IlluminanceMeasurement.Cluster.id, 'measuredValue', lux, endpoint.log);
  }

  private applyButtonState(button: HueResource): void {
    const endpoint = this.sensors.get(button.id);
    const event: string | undefined = button.button?.last_event ?? button.button?.button_report?.event;
    if (!endpoint || !event) return;
    // Map Hue button events to Matter generic switch events (best effort).
    this.log.info(`Hue button ${button.id} event: ${event}`);
    if (event === 'initial_press') void endpoint.triggerSwitchEvent('Press', endpoint.log);
    else if (event === 'short_release') void endpoint.triggerSwitchEvent('Release', endpoint.log);
  }
}
