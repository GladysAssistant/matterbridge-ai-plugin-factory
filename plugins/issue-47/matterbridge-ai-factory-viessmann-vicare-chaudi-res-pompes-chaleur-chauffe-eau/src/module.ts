/**
 * Matterbridge plugin for Viessmann ViCare (chaudières, pompes à chaleur, chauffe-eau).
 *
 * Exposes ViCare heating circuits as thermostats, DHW as a thermostat, outside/supply/return/room
 * temperatures as temperature sensors, circuit pressure as a pressure sensor, burner/compressor
 * state as a contact sensor and Vitovent ventilation as a fan.
 *
 * @file module.ts
 * @author Matterbridge AI Factory
 * @version 1.0.0
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  contactSensor,
  fanDevice,
  powerSource,
  pressureSensor,
  temperatureSensor,
  thermostatDevice,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { FanControl, Thermostat } from 'matterbridge/matter/clusters';

import { getBoolean, getNumber, getString, ViCareClient, ViCareDevice } from './vicareClient.js';

/** Plugin configuration. */
export type VicarePlatformConfig = BasePlatformConfig & {
  clientId?: string;
  refreshToken?: string;
  accessToken?: string;
  apiBaseUrl?: string;
  pollInterval?: number;
  demoMode?: boolean;
  whiteList?: string[];
  blackList?: string[];
};

/** A registered Matter endpoint bound to a ViCare update function. */
interface Updater {
  device: MatterbridgeEndpoint;
  update: (dev: ViCareDevice) => Promise<void>;
}

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The plugin logger.
 * @param {VicarePlatformConfig} config - The plugin configuration.
 * @returns {VicarePlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: VicarePlatformConfig): VicarePlatform {
  return new VicarePlatform(matterbridge, log, config);
}

/** ViCare dynamic platform. */
export class VicarePlatform extends MatterbridgeDynamicPlatform {
  private client?: ViCareClient;
  private readonly vicareDevices = new Map<string, ViCareDevice>();
  private readonly updaters = new Map<string, Updater[]>();
  private pollTimer?: NodeJS.Timeout;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: VicarePlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }
    this.log.info('Initializing Viessmann ViCare platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const cfg = this.config as VicarePlatformConfig;

    if (cfg.demoMode) {
      this.log.notice('ViCare demoMode enabled: creating sample devices (no cloud connection).');
      await this.buildDevice(this.demoDevice());
      return;
    }

    if (!cfg.clientId || !cfg.refreshToken) {
      this.log.warn('ViCare not configured: set "clientId" and "refreshToken" in the plugin config. Enable "demoMode" to preview devices. No devices created.');
      return;
    }

    this.client = new ViCareClient(cfg.clientId, this.log, cfg.apiBaseUrl);
    this.client.setTokens(cfg.refreshToken, cfg.accessToken);

    try {
      const devices = await this.client.discoverDevices();
      this.log.info(`ViCare discovered ${devices.length} device(s).`);
      for (const dev of devices) await this.buildDevice(dev);
    } catch (err) {
      this.log.error(`ViCare discovery failed: ${(err as Error).message}`);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    for (const [key, updaters] of this.updaters) {
      const dev = this.vicareDevices.get(key);
      if (!dev) continue;
      for (const u of updaters) await u.update(dev).catch((e) => this.log.error(`ViCare configure update error: ${(e as Error).message}`));
    }

    const interval = Math.max(60, (this.config as VicarePlatformConfig).pollInterval ?? 120) * 1000;
    if (this.client) {
      this.pollTimer = setInterval(() => void this.poll(), interval);
      this.log.info(`ViCare polling every ${interval / 1000}s`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Poll the ViCare cloud and push updated attributes to all endpoints.
   *
   * @returns {Promise<void>} Resolves when polling completes.
   */
  private async poll(): Promise<void> {
    if (!this.client) return;
    for (const [key, dev] of this.vicareDevices) {
      try {
        await this.client.loadFeatures(dev);
        for (const u of this.updaters.get(key) ?? []) await u.update(dev);
      } catch (err) {
        this.log.error(`ViCare poll error for ${key}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Build all Matter endpoints for one ViCare device based on its available features.
   *
   * @param {ViCareDevice} dev - The ViCare device.
   * @returns {Promise<void>} Resolves when endpoints are registered.
   */
  private async buildDevice(dev: ViCareDevice): Promise<void> {
    const key = `${dev.gatewaySerial}-${dev.deviceId}`;
    const label = `${dev.modelId} (${key})`;
    this.setSelectDevice(key, label);
    if (!this.validateDevice([label, key])) return;

    this.vicareDevices.set(key, dev);
    const updaters: Updater[] = [];

    // Heating circuits -> thermostats.
    for (let c = 0; c < 4; c++) {
      if (!dev.features.has(`heating.circuits.${c}`) && !dev.features.has(`heating.circuits.${c}.operating.modes.active`)) continue;
      const u = await this.buildHeatingCircuit(dev, key, c);
      if (u) updaters.push(u);
    }

    // DHW (eau chaude) -> thermostat.
    if (dev.features.has('heating.dhw') || dev.features.has('heating.dhw.temperature.main')) {
      const u = await this.buildDhw(dev, key);
      if (u) updaters.push(u);
    }

    // Outside temperature.
    if (dev.features.has('heating.sensors.temperature.outside')) {
      updaters.push(await this.buildTempSensor(dev, key, 'outside', 'Température extérieure', 'heating.sensors.temperature.outside'));
    }
    // Supply / return temperatures.
    if (dev.features.has('heating.circuits.0.sensors.temperature.supply')) {
      updaters.push(await this.buildTempSensor(dev, key, 'supply', 'Température départ', 'heating.circuits.0.sensors.temperature.supply'));
    }
    if (dev.features.has('heating.sensors.temperature.return')) {
      updaters.push(await this.buildTempSensor(dev, key, 'return', 'Température retour', 'heating.sensors.temperature.return'));
    }
    // Room temperature (ViCare sensors).
    if (dev.features.has('heating.circuits.0.sensors.temperature.room')) {
      updaters.push(await this.buildTempSensor(dev, key, 'room', 'Température pièce', 'heating.circuits.0.sensors.temperature.room'));
    }

    // Circuit pressure.
    if (dev.features.has('heating.sensors.pressure.supply')) {
      updaters.push(await this.buildPressureSensor(dev, key));
    }

    // Burner / compressor state.
    const burnerFeature = dev.features.has('heating.burners.0') ? 'heating.burners.0' : dev.features.has('heating.compressors.0') ? 'heating.compressors.0' : undefined;
    if (burnerFeature) {
      updaters.push(await this.buildStateSensor(dev, key, burnerFeature));
    }

    // Ventilation (Vitovent) -> fan.
    if (dev.features.has('ventilation.operating.modes.active') || dev.features.has('ventilation.levels')) {
      const u = await this.buildVentilation(dev, key);
      if (u) updaters.push(u);
    }

    this.updaters.set(key, updaters);
  }

  /**
   * Build a heating-circuit thermostat with writable comfort setpoint and on/off mode.
   *
   * @param {ViCareDevice} dev - The ViCare device.
   * @param {string} key - The device key.
   * @param {number} c - The circuit index.
   * @returns {Promise<Updater | undefined>} The updater, or undefined if registration failed.
   */
  private async buildHeatingCircuit(dev: ViCareDevice, key: string, c: number): Promise<Updater | undefined> {
    const comfortFeature = `heating.circuits.${c}.operating.programs.comfort`;
    const modeFeature = `heating.circuits.${c}.operating.modes.active`;
    const supplyFeature = `heating.circuits.${c}.sensors.temperature.supply`;
    const setpoint = getNumber(dev, comfortFeature, 'temperature') ?? 21;
    const local = getNumber(dev, supplyFeature) ?? setpoint;

    const ep = new MatterbridgeEndpoint([thermostatDevice, powerSource], { id: `${key}-circuit${c}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(`Circuit ${c} chauffage`, `${key}-c${c}`, this.matterbridge.aggregatorVendorId, 'Viessmann', dev.modelId, 1, '1.0.0')
      .createDefaultHeatingThermostatClusterServer(local, setpoint, 10, 30)
      .createDefaultPowerSourceWiredClusterServer()
      .addRequiredClusterServers();

    await this.registerDevice(ep);

    // Subscriptions must be added after registration (construction must be Active).
    await ep.subscribeAttribute(
      Thermostat.Cluster.id,
      'occupiedHeatingSetpoint',
      (value: number) => void this.setComfortTemperature(dev, comfortFeature, Math.round(value / 100)),
      this.log,
    );
    await ep.subscribeAttribute(Thermostat.Cluster.id, 'systemMode', (value: number) => void this.setHeatingMode(dev, modeFeature, value), this.log);

    return {
      device: ep,
      update: async (d) => {
        const sp = getNumber(d, comfortFeature, 'temperature');
        const lt = getNumber(d, supplyFeature);
        const mode = getString(d, modeFeature, 'value');
        if (sp !== undefined) await ep.setAttribute(Thermostat.Cluster.id, 'occupiedHeatingSetpoint', Math.round(sp * 100), this.log);
        if (lt !== undefined) await ep.setAttribute(Thermostat.Cluster.id, 'localTemperature', Math.round(lt * 100), this.log);
        if (mode !== undefined) {
          const off = mode === 'standby' || mode === 'off';
          await ep.setAttribute(Thermostat.Cluster.id, 'systemMode', off ? Thermostat.SystemMode.Off : Thermostat.SystemMode.Heat, this.log);
        }
      },
    };
  }

  /**
   * Build the DHW (domestic hot water) thermostat with writable target temperature.
   *
   * @param {ViCareDevice} dev - The ViCare device.
   * @param {string} key - The device key.
   * @returns {Promise<Updater | undefined>} The updater, or undefined if registration failed.
   */
  private async buildDhw(dev: ViCareDevice, key: string): Promise<Updater | undefined> {
    const tempFeature = 'heating.dhw.temperature.main';
    const sensorFeature = 'heating.dhw.sensors.temperature.hotWaterStorage';
    const setpoint = getNumber(dev, tempFeature) ?? 50;
    const local = getNumber(dev, sensorFeature) ?? setpoint;

    const ep = new MatterbridgeEndpoint([thermostatDevice, powerSource], { id: `${key}-dhw` })
      .createDefaultBridgedDeviceBasicInformationClusterServer('Eau chaude sanitaire (ECS)', `${key}-dhw`, this.matterbridge.aggregatorVendorId, 'Viessmann', dev.modelId, 1, '1.0.0')
      .createDefaultHeatingThermostatClusterServer(local, setpoint, 30, 60)
      .createDefaultPowerSourceWiredClusterServer()
      .addRequiredClusterServers();

    await this.registerDevice(ep);

    // Subscriptions must be added after registration (construction must be Active).
    await ep.subscribeAttribute(
      Thermostat.Cluster.id,
      'occupiedHeatingSetpoint',
      (value: number) => void this.setDhwTemperature(dev, tempFeature, Math.round(value / 100)),
      this.log,
    );

    return {
      device: ep,
      update: async (d) => {
        const sp = getNumber(d, tempFeature);
        const lt = getNumber(d, sensorFeature);
        if (sp !== undefined) await ep.setAttribute(Thermostat.Cluster.id, 'occupiedHeatingSetpoint', Math.round(sp * 100), this.log);
        if (lt !== undefined) await ep.setAttribute(Thermostat.Cluster.id, 'localTemperature', Math.round(lt * 100), this.log);
      },
    };
  }

  /**
   * Build a read-only temperature sensor endpoint.
   *
   * @param {ViCareDevice} dev - The ViCare device.
   * @param {string} key - The device key.
   * @param {string} suffix - The endpoint id suffix.
   * @param {string} name - The human-readable device name.
   * @param {string} feature - The ViCare feature id holding the temperature.
   * @returns {Promise<Updater>} The updater.
   */
  private async buildTempSensor(dev: ViCareDevice, key: string, suffix: string, name: string, feature: string): Promise<Updater> {
    const value = getNumber(dev, feature);
    const ep = new MatterbridgeEndpoint(temperatureSensor, { id: `${key}-${suffix}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, `${key}-${suffix}`, this.matterbridge.aggregatorVendorId, 'Viessmann', dev.modelId, 1, '1.0.0')
      .createDefaultTemperatureMeasurementClusterServer(value !== undefined ? Math.round(value * 100) : null)
      .addRequiredClusterServers();
    await this.registerDevice(ep);
    return {
      device: ep,
      update: async (d) => {
        const v = getNumber(d, feature);
        if (v !== undefined) await ep.setAttribute('TemperatureMeasurement', 'measuredValue', Math.round(v * 100), this.log);
      },
    };
  }

  /**
   * Build a read-only circuit-pressure sensor endpoint.
   *
   * @param {ViCareDevice} dev - The ViCare device.
   * @param {string} key - The device key.
   * @returns {Promise<Updater>} The updater.
   */
  private async buildPressureSensor(dev: ViCareDevice, key: string): Promise<Updater> {
    const feature = 'heating.sensors.pressure.supply';
    const toKpaTenths = (bar: number): number => Math.round(bar * 1000); // 1 bar = 100 kPa = 1000 * 0.1 kPa
    const value = getNumber(dev, feature);
    const ep = new MatterbridgeEndpoint(pressureSensor, { id: `${key}-pressure` })
      .createDefaultBridgedDeviceBasicInformationClusterServer('Pression circuit', `${key}-pressure`, this.matterbridge.aggregatorVendorId, 'Viessmann', dev.modelId, 1, '1.0.0')
      .createDefaultPressureMeasurementClusterServer(value !== undefined ? toKpaTenths(value) : null)
      .addRequiredClusterServers();
    await this.registerDevice(ep);
    return {
      device: ep,
      update: async (d) => {
        const v = getNumber(d, feature);
        if (v !== undefined) await ep.setAttribute('PressureMeasurement', 'measuredValue', toKpaTenths(v), this.log);
      },
    };
  }

  /**
   * Build a read-only burner/compressor state endpoint (contact sensor: closed = active).
   *
   * @param {ViCareDevice} dev - The ViCare device.
   * @param {string} key - The device key.
   * @param {string} feature - The ViCare burner/compressor feature id.
   * @returns {Promise<Updater>} The updater.
   */
  private async buildStateSensor(dev: ViCareDevice, key: string, feature: string): Promise<Updater> {
    const name = feature.includes('compressor') ? 'État compresseur' : 'État brûleur';
    const active = getBoolean(dev, feature, 'active') ?? false;
    const ep = new MatterbridgeEndpoint(contactSensor, { id: `${key}-burner` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, `${key}-burner`, this.matterbridge.aggregatorVendorId, 'Viessmann', dev.modelId, 1, '1.0.0')
      .createDefaultBooleanStateClusterServer(!active)
      .addRequiredClusterServers();
    await this.registerDevice(ep);
    return {
      device: ep,
      update: async (d) => {
        const a = getBoolean(d, feature, 'active');
        if (a !== undefined) await ep.setAttribute('BooleanState', 'stateValue', !a, this.log);
      },
    };
  }

  /**
   * Build a Vitovent ventilation fan endpoint.
   *
   * @param {ViCareDevice} dev - The ViCare device.
   * @param {string} key - The device key.
   * @returns {Promise<Updater | undefined>} The updater, or undefined if registration failed.
   */
  private async buildVentilation(dev: ViCareDevice, key: string): Promise<Updater | undefined> {
    const modeFeature = 'ventilation.operating.modes.active';
    const levels = ['levelOne', 'levelTwo', 'levelThree', 'levelFour'];
    const toPercent = (mode?: string): number => {
      const idx = levels.indexOf(mode ?? '');
      return idx >= 0 ? Math.round(((idx + 1) / levels.length) * 100) : 0;
    };
    const current = getString(dev, modeFeature, 'value');

    const ep = new MatterbridgeEndpoint(fanDevice, { id: `${key}-ventilation` })
      .createDefaultBridgedDeviceBasicInformationClusterServer('Ventilation Vitovent', `${key}-ventilation`, this.matterbridge.aggregatorVendorId, 'Viessmann', dev.modelId, 1, '1.0.0')
      .createDefaultFanControlClusterServer(FanControl.FanMode.Auto, FanControl.FanModeSequence.OffLowMedHighAuto, toPercent(current), toPercent(current))
      .addRequiredClusterServers();

    await this.registerDevice(ep);

    return {
      device: ep,
      update: async (d) => {
        const m = getString(d, modeFeature, 'value');
        await ep.setAttribute('FanControl', 'percentCurrent', toPercent(m), this.log);
      },
    };
  }

  /**
   * Send the heating-circuit comfort program target temperature command.
   *
   * @param {ViCareDevice} dev - The ViCare device.
   * @param {string} feature - The comfort program feature id.
   * @param {number} celsius - The target temperature in °C.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  private async setComfortTemperature(dev: ViCareDevice, feature: string, celsius: number): Promise<void> {
    await this.runCommand(dev, feature, ['setTemperature'], { targetTemperature: celsius });
  }

  /**
   * Send the DHW target temperature command.
   *
   * @param {ViCareDevice} dev - The ViCare device.
   * @param {string} feature - The DHW temperature feature id.
   * @param {number} celsius - The target temperature in °C.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  private async setDhwTemperature(dev: ViCareDevice, feature: string, celsius: number): Promise<void> {
    await this.runCommand(dev, feature, ['setTargetTemperature', 'setTemperature'], { temperature: celsius });
  }

  /**
   * Set the heating-circuit operating mode from a Matter system mode.
   *
   * @param {ViCareDevice} dev - The ViCare device.
   * @param {string} feature - The operating modes feature id.
   * @param {number} systemMode - The Matter Thermostat.SystemMode value.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  private async setHeatingMode(dev: ViCareDevice, feature: string, systemMode: number): Promise<void> {
    const mode = systemMode === Thermostat.SystemMode.Off ? 'standby' : 'heating';
    await this.runCommand(dev, feature, ['setMode'], { mode });
  }

  /**
   * Execute the first available command of a feature with the given payload.
   *
   * @param {ViCareDevice} dev - The ViCare device.
   * @param {string} feature - The feature id.
   * @param {string[]} commandNames - Preferred command names in priority order.
   * @param {Record<string, unknown>} payload - The command payload.
   * @returns {Promise<void>} Resolves when the command is sent (no-op in demo mode).
   */
  private async runCommand(dev: ViCareDevice, feature: string, commandNames: string[], payload: Record<string, unknown>): Promise<void> {
    if (!this.client) {
      this.log.info(`ViCare demo: would send ${commandNames[0]} ${JSON.stringify(payload)} to ${feature}`);
      return;
    }
    const commands = dev.features.get(feature)?.commands ?? {};
    const name = commandNames.find((n) => commands[n]?.isExecutable);
    if (!name) {
      this.log.warn(`ViCare: no executable command (${commandNames.join('/')}) on ${feature}`);
      return;
    }
    try {
      await this.client.executeCommand(commands[name].uri, payload);
      this.log.info(`ViCare: sent ${name} ${JSON.stringify(payload)} to ${feature}`);
    } catch (err) {
      this.log.error(`ViCare command failed: ${(err as Error).message}`);
    }
  }

  /**
   * Create a synthetic ViCare device used by demoMode for offline previewing.
   *
   * @returns {ViCareDevice} A demo device populated with representative features.
   */
  private demoDevice(): ViCareDevice {
    const f = (value: unknown, prop = 'value', unit = 'celsius') => ({
      feature: '',
      isEnabled: true,
      isReady: true,
      properties: { [prop]: { type: typeof value, value, unit } },
      commands: {},
    });
    const features = new Map<string, any>([
      ['heating.circuits.0', f(true, 'active', '')],
      ['heating.circuits.0.operating.modes.active', f('heating', 'value', '')],
      ['heating.circuits.0.operating.programs.comfort', f(22, 'temperature')],
      ['heating.circuits.0.sensors.temperature.supply', f(45)],
      ['heating.circuits.0.sensors.temperature.room', f(21)],
      ['heating.dhw', f(true, 'active', '')],
      ['heating.dhw.temperature.main', f(50)],
      ['heating.dhw.sensors.temperature.hotWaterStorage', f(48)],
      ['heating.sensors.temperature.outside', f(12)],
      ['heating.sensors.temperature.return', f(38)],
      ['heating.sensors.pressure.supply', f(1.6, 'value', 'bar')],
      ['heating.burners.0', f(true, 'active', '')],
      ['ventilation.operating.modes.active', f('levelTwo', 'value', '')],
    ]);
    return { installationId: 0, gatewaySerial: 'DEMO', deviceId: '0', modelId: 'Vitodens 200-W', deviceType: 'heating', features };
  }
}
