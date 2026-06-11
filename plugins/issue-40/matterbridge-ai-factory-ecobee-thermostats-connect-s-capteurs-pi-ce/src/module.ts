/**
 * Matterbridge Ecobee plugin: thermostats and remote room sensors.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  humiditySensor,
  occupancySensor,
  temperatureSensor,
  thermostatDevice,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { FanControl, Thermostat } from 'matterbridge/matter/clusters';

import {
  EcobeeClient,
  EcobeeRemoteSensor,
  EcobeeThermostat,
  EcobeeTokens,
  celsiusToFahrenheitTenths,
  fahrenheitTenthsToCelsius,
} from './ecobee.js';

const VENDOR_ID = 0xfff1;
const TOKENS_KEY = 'ecobeeTokens';

/** Plugin configuration. */
export type EcobeePlatformConfig = BasePlatformConfig & {
  apiKey?: string;
  exposeRoomSensors?: boolean;
  pollInterval?: number;
  whiteList: string[];
  blackList: string[];
};

/**
 * Standard Matterbridge plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The logger.
 * @param {EcobeePlatformConfig} config - The platform configuration.
 * @returns {EcobeePlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: EcobeePlatformConfig): EcobeePlatform {
  return new EcobeePlatform(matterbridge, log, config);
}

/**
 * Ecobee dynamic platform.
 */
export class EcobeePlatform extends MatterbridgeDynamicPlatform {
  private client?: EcobeeClient;
  private pollTimer?: NodeJS.Timeout;
  /** Map of thermostat endpoint id -> Ecobee thermostat identifier. */
  private readonly thermostatIds = new Map<string, string>();

  /**
   * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
   * @param {AnsiLogger} log - The logger.
   * @param {EcobeePlatformConfig} config - The platform configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: EcobeePlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info('Initializing Ecobee platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const config = this.config as EcobeePlatformConfig;
    if (!config.apiKey) {
      this.log.error('No Ecobee API Key (client_id) configured. Register an app at https://www.ecobee.com/developers/ and set "apiKey" in the plugin config.');
      return;
    }

    const tokens = await this.context?.get<EcobeeTokens | undefined>(TOKENS_KEY, undefined);
    this.client = new EcobeeClient(config.apiKey, this.log, tokens);

    if (!this.client.isAuthorized()) {
      await this.authorize();
    }
    if (!this.client.isAuthorized()) {
      this.log.error('Ecobee authorization not completed. Devices will be discovered after the PIN is authorized and the plugin restarts.');
      return;
    }

    await this.discoverDevices();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    await this.poll();

    const config = this.config as EcobeePlatformConfig;
    const interval = Math.max(60, config.pollInterval ?? 180) * 1000;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, interval);
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
   * Run the ecobee PIN authorization flow and persist the tokens.
   *
   * @returns {Promise<void>}
   */
  private async authorize(): Promise<void> {
    if (!this.client) return;
    try {
      const pin = await this.client.requestPin();
      this.log.warn('='.repeat(60));
      this.log.warn(`ECOBEE AUTHORIZATION REQUIRED`);
      this.log.warn(`Enter this PIN at https://www.ecobee.com/consumerportal/index.html`);
      this.log.warn(`(My Apps > Add Application):   PIN = ${pin.pin}`);
      this.log.warn(`Waiting up to ${pin.expiresIn} minutes for authorization...`);
      this.log.warn('='.repeat(60));
      this.wssSendSnackbarMessage?.(`Ecobee: enter PIN ${pin.pin} at ecobee.com`, 0, 'info');

      const deadline = Date.now() + pin.expiresIn * 60_000;
      const intervalMs = Math.max(5, pin.interval) * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, intervalMs));
        try {
          const tokens = await this.client.exchangePin(pin.code);
          await this.context?.set(TOKENS_KEY, tokens);
          this.log.info('Ecobee authorization successful, tokens stored.');
          return;
        } catch {
          this.log.debug('PIN not yet authorized, retrying...');
        }
      }
      this.log.error('Ecobee PIN authorization timed out.');
    } catch (error) {
      this.log.error(`Ecobee authorization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Discover thermostats and room sensors and register them.
   *
   * @returns {Promise<void>}
   */
  private async discoverDevices(): Promise<void> {
    if (!this.client) return;
    this.log.info('Discovering Ecobee devices...');
    let thermostats: EcobeeThermostat[];
    try {
      thermostats = await this.client.getThermostats();
    } catch (error) {
      this.log.error(`Failed to fetch thermostats: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const config = this.config as EcobeePlatformConfig;
    for (const t of thermostats) {
      await this.registerThermostat(t);
      if (config.exposeRoomSensors !== false) {
        for (const sensor of t.remoteSensors ?? []) {
          await this.registerRoomSensor(t, sensor);
        }
      }
    }
  }

  /**
   * Create and register a thermostat endpoint.
   *
   * @param {EcobeeThermostat} t - The Ecobee thermostat.
   * @returns {Promise<void>}
   */
  private async registerThermostat(t: EcobeeThermostat): Promise<void> {
    const id = `ecobee-tstat-${t.identifier}`;
    const serial = `EB-${t.identifier}`;
    this.setSelectDevice(serial, t.name);
    if (!this.validateDevice([t.name, serial])) return;

    const localTemp = fahrenheitTenthsToCelsius(t.runtime.actualTemperature);
    const heatC = fahrenheitTenthsToCelsius(t.runtime.desiredHeat);
    const coolC = fahrenheitTenthsToCelsius(t.runtime.desiredCool);

    const device = new MatterbridgeEndpoint(thermostatDevice, { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(t.name, serial, VENDOR_ID, t.brand || 'ecobee', t.modelNumber || 'ecobee thermostat', 1, '1.0.0')
      .createDefaultIdentifyClusterServer()
      .createDefaultThermostatClusterServer(localTemp, heatC, coolC)
      .createDefaultFanControlClusterServer(FanControl.FanMode.Auto, FanControl.FanModeSequence.OffHighAuto)
      .createDefaultRelativeHumidityMeasurementClusterServer(Math.round((t.runtime.actualHumidity ?? 0) * 100))
      .addRequiredClusterServers();

    this.thermostatIds.set(id, t.identifier);

    device.subscribeAttribute(
      Thermostat.Cluster.id,
      'systemMode',
      (value: Thermostat.SystemMode) => {
        void this.onSystemModeChange(t.identifier, value);
      },
      device.log,
    );
    device.subscribeAttribute(
      Thermostat.Cluster.id,
      'occupiedHeatingSetpoint',
      (value: number) => {
        void this.onHeatSetpointChange(t.identifier, value);
      },
      device.log,
    );
    device.subscribeAttribute(
      Thermostat.Cluster.id,
      'occupiedCoolingSetpoint',
      (value: number) => {
        void this.onCoolSetpointChange(t.identifier, value);
      },
      device.log,
    );
    device.subscribeAttribute(
      FanControl.Cluster.id,
      'fanMode',
      (value: FanControl.FanMode) => {
        void this.onFanModeChange(t.identifier, value);
      },
      device.log,
    );

    await this.registerDevice(device);
  }

  /**
   * Create and register a remote room sensor endpoint (temperature + occupancy + humidity).
   *
   * @param {EcobeeThermostat} t - The owning thermostat.
   * @param {EcobeeRemoteSensor} sensor - The remote sensor.
   * @returns {Promise<void>}
   */
  private async registerRoomSensor(t: EcobeeThermostat, sensor: EcobeeRemoteSensor): Promise<void> {
    const hasTemp = sensor.capability.some((c) => c.type === 'temperature');
    const hasOccupancy = sensor.capability.some((c) => c.type === 'occupancy');
    const hasHumidity = sensor.capability.some((c) => c.type === 'humidity');
    if (!hasTemp && !hasOccupancy && !hasHumidity) return;

    const id = `ecobee-sensor-${t.identifier}-${sensor.id}`;
    const serial = `EB-${t.identifier}-${sensor.id}`;
    const name = `${sensor.name}`;
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;

    const types = [] as typeof temperatureSensor[];
    if (hasTemp) types.push(temperatureSensor);
    if (hasOccupancy) types.push(occupancySensor);
    if (hasHumidity) types.push(humiditySensor);

    const device = new MatterbridgeEndpoint(types as never, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(
      name,
      serial,
      VENDOR_ID,
      'ecobee',
      'ecobee room sensor',
      1,
      '1.0.0',
    ).createDefaultIdentifyClusterServer();

    if (hasTemp) device.createDefaultTemperatureMeasurementClusterServer(this.sensorTemperature(sensor));
    if (hasOccupancy) device.createDefaultOccupancySensingClusterServer(this.sensorOccupancy(sensor));
    if (hasHumidity) device.createDefaultRelativeHumidityMeasurementClusterServer(this.sensorHumidity(sensor));

    device.addRequiredClusterServers();
    await this.registerDevice(device);
  }

  /**
   * Poll the Ecobee API and update all registered devices.
   *
   * @returns {Promise<void>}
   */
  private async poll(): Promise<void> {
    if (!this.client?.isAuthorized()) return;
    let thermostats: EcobeeThermostat[];
    try {
      thermostats = await this.client.getThermostats();
      const tokens = this.client.getTokens();
      if (tokens) await this.context?.set(TOKENS_KEY, tokens);
    } catch (error) {
      this.log.error(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const byId = new Map(thermostats.map((t) => [t.identifier, t]));
    for (const device of this.getDevices()) {
      const tstatId = this.thermostatIds.get(device.id ?? '');
      if (tstatId) {
        const t = byId.get(tstatId);
        if (t) await this.updateThermostat(device, t);
        continue;
      }
      await this.updateSensorDevice(device, thermostats);
    }
  }

  /**
   * Update a thermostat endpoint from fresh API data.
   *
   * @param {MatterbridgeEndpoint} device - The endpoint.
   * @param {EcobeeThermostat} t - The thermostat data.
   * @returns {Promise<void>}
   */
  private async updateThermostat(device: MatterbridgeEndpoint, t: EcobeeThermostat): Promise<void> {
    await device.updateAttribute(Thermostat.Cluster.id, 'localTemperature', Math.round(fahrenheitTenthsToCelsius(t.runtime.actualTemperature) * 100), device.log);
    await device.updateAttribute(Thermostat.Cluster.id, 'occupiedHeatingSetpoint', Math.round(fahrenheitTenthsToCelsius(t.runtime.desiredHeat) * 100), device.log);
    await device.updateAttribute(Thermostat.Cluster.id, 'occupiedCoolingSetpoint', Math.round(fahrenheitTenthsToCelsius(t.runtime.desiredCool) * 100), device.log);
    await device.updateAttribute(Thermostat.Cluster.id, 'systemMode', this.toMatterSystemMode(t.settings.hvacMode), device.log);
    if (device.hasAttributeServer(Thermostat.Cluster.id, 'systemMode')) {
      await device.updateAttribute(FanControl.Cluster.id, 'fanMode', t.settings.fanMinOnTime > 0 ? FanControl.FanMode.On : FanControl.FanMode.Auto, device.log);
    }
    await device.updateAttribute('RelativeHumidityMeasurement', 'measuredValue', Math.round((t.runtime.actualHumidity ?? 0) * 100), device.log);
  }

  /**
   * Update a room sensor endpoint from fresh API data.
   *
   * @param {MatterbridgeEndpoint} device - The endpoint.
   * @param {EcobeeThermostat[]} thermostats - All thermostats with their sensors.
   * @returns {Promise<void>}
   */
  private async updateSensorDevice(device: MatterbridgeEndpoint, thermostats: EcobeeThermostat[]): Promise<void> {
    for (const t of thermostats) {
      for (const sensor of t.remoteSensors ?? []) {
        if (device.id !== `ecobee-sensor-${t.identifier}-${sensor.id}`) continue;
        if (device.hasAttributeServer('TemperatureMeasurement', 'measuredValue')) {
          await device.updateAttribute('TemperatureMeasurement', 'measuredValue', this.sensorTemperature(sensor), device.log);
        }
        if (device.hasAttributeServer('OccupancySensing', 'occupancy')) {
          await device.updateAttribute('OccupancySensing', 'occupancy', { occupied: this.sensorOccupancy(sensor) }, device.log);
        }
        if (device.hasAttributeServer('RelativeHumidityMeasurement', 'measuredValue')) {
          await device.updateAttribute('RelativeHumidityMeasurement', 'measuredValue', this.sensorHumidity(sensor), device.log);
        }
        return;
      }
    }
  }

  /**
   * @param {EcobeeRemoteSensor} sensor - The sensor.
   * @returns {number} The temperature in Matter units (Celsius x 100).
   */
  private sensorTemperature(sensor: EcobeeRemoteSensor): number {
    const cap = sensor.capability.find((c) => c.type === 'temperature');
    const raw = cap ? Number(cap.value) : NaN;
    if (!Number.isFinite(raw)) return 0;
    return Math.round(fahrenheitTenthsToCelsius(raw) * 100);
  }

  /**
   * @param {EcobeeRemoteSensor} sensor - The sensor.
   * @returns {boolean} True if occupancy is detected.
   */
  private sensorOccupancy(sensor: EcobeeRemoteSensor): boolean {
    const cap = sensor.capability.find((c) => c.type === 'occupancy');
    return cap?.value === 'true';
  }

  /**
   * @param {EcobeeRemoteSensor} sensor - The sensor.
   * @returns {number} The humidity in Matter units (% x 100).
   */
  private sensorHumidity(sensor: EcobeeRemoteSensor): number {
    const cap = sensor.capability.find((c) => c.type === 'humidity');
    const raw = cap ? Number(cap.value) : NaN;
    if (!Number.isFinite(raw)) return 0;
    return Math.round(raw * 100);
  }

  /**
   * Map an Ecobee HVAC mode to a Matter Thermostat SystemMode.
   *
   * @param {string} mode - The Ecobee hvacMode.
   * @returns {Thermostat.SystemMode} The Matter system mode.
   */
  private toMatterSystemMode(mode: string): Thermostat.SystemMode {
    switch (mode) {
      case 'heat':
        return Thermostat.SystemMode.Heat;
      case 'cool':
        return Thermostat.SystemMode.Cool;
      case 'auto':
        return Thermostat.SystemMode.Auto;
      case 'auxHeatOnly':
        return Thermostat.SystemMode.EmergencyHeat;
      case 'off':
      default:
        return Thermostat.SystemMode.Off;
    }
  }

  /**
   * Map a Matter Thermostat SystemMode to an Ecobee HVAC mode.
   *
   * @param {Thermostat.SystemMode} mode - The Matter system mode.
   * @returns {string} The Ecobee hvacMode.
   */
  private toEcobeeHvacMode(mode: Thermostat.SystemMode): string {
    switch (mode) {
      case Thermostat.SystemMode.Heat:
        return 'heat';
      case Thermostat.SystemMode.Cool:
        return 'cool';
      case Thermostat.SystemMode.Auto:
        return 'auto';
      case Thermostat.SystemMode.EmergencyHeat:
        return 'auxHeatOnly';
      default:
        return 'off';
    }
  }

  /**
   * Handle a Matter system mode change by writing to Ecobee.
   *
   * @param {string} thermostatId - The Ecobee thermostat id.
   * @param {Thermostat.SystemMode} value - The new Matter system mode.
   * @returns {Promise<void>}
   */
  private async onSystemModeChange(thermostatId: string, value: Thermostat.SystemMode): Promise<void> {
    try {
      await this.client?.updateSettings(thermostatId, { hvacMode: this.toEcobeeHvacMode(value) });
      this.log.info(`Set Ecobee ${thermostatId} hvacMode to ${this.toEcobeeHvacMode(value)}`);
    } catch (error) {
      this.log.error(`Failed to set hvacMode: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle a Matter heat setpoint change by writing a hold to Ecobee.
   *
   * @param {string} thermostatId - The Ecobee thermostat id.
   * @param {number} value - The new heat setpoint in Celsius x 100.
   * @returns {Promise<void>}
   */
  private async onHeatSetpointChange(thermostatId: string, value: number): Promise<void> {
    try {
      const device = this.getDevices().find((d) => this.thermostatIds.get(d.id ?? '') === thermostatId);
      const coolC = (device?.getAttribute(Thermostat.Cluster.id, 'occupiedCoolingSetpoint') as number | undefined) ?? value + 200;
      await this.client?.setHold(thermostatId, celsiusToFahrenheitTenths(value / 100), celsiusToFahrenheitTenths(coolC / 100));
      this.log.info(`Set Ecobee ${thermostatId} heat setpoint to ${(value / 100).toFixed(1)}C`);
    } catch (error) {
      this.log.error(`Failed to set heat setpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle a Matter cool setpoint change by writing a hold to Ecobee.
   *
   * @param {string} thermostatId - The Ecobee thermostat id.
   * @param {number} value - The new cool setpoint in Celsius x 100.
   * @returns {Promise<void>}
   */
  private async onCoolSetpointChange(thermostatId: string, value: number): Promise<void> {
    try {
      const device = this.getDevices().find((d) => this.thermostatIds.get(d.id ?? '') === thermostatId);
      const heatC = (device?.getAttribute(Thermostat.Cluster.id, 'occupiedHeatingSetpoint') as number | undefined) ?? value - 200;
      await this.client?.setHold(thermostatId, celsiusToFahrenheitTenths(heatC / 100), celsiusToFahrenheitTenths(value / 100));
      this.log.info(`Set Ecobee ${thermostatId} cool setpoint to ${(value / 100).toFixed(1)}C`);
    } catch (error) {
      this.log.error(`Failed to set cool setpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle a Matter fan mode change by writing to Ecobee.
   *
   * @param {string} thermostatId - The Ecobee thermostat id.
   * @param {FanControl.FanMode} value - The new fan mode.
   * @returns {Promise<void>}
   */
  private async onFanModeChange(thermostatId: string, value: FanControl.FanMode): Promise<void> {
    try {
      const fanMinOnTime = value === FanControl.FanMode.Auto || value === FanControl.FanMode.Off ? 0 : 20;
      await this.client?.updateSettings(thermostatId, { fanMinOnTime });
      this.log.info(`Set Ecobee ${thermostatId} fanMinOnTime to ${fanMinOnTime}`);
    } catch (error) {
      this.log.error(`Failed to set fan mode: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
