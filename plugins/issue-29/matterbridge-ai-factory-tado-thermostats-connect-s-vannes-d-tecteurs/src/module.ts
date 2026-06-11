/**
 * Matterbridge Tado plugin.
 *
 * Exposes Tado heating zones, AC zones, hot water, valves and sensors to Matter.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { BasePlatformConfig, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformMatterbridge, humiditySensor, temperatureSensor, thermostatDevice } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { Tado } from 'node-tado-client';
import type { Power, Zone, ZoneState } from 'node-tado-client';

/** Instance config for the Tado platform. */
export type TadoPlatformConfig = BasePlatformConfig & {
  homeId: number;
  pollInterval: number;
  whiteList: string[];
  blackList: string[];
};

/** Matter Thermostat SystemMode values. */
const SystemMode = { Off: 0, Auto: 1, Cool: 3, Heat: 4 } as const;

/** Internal bookkeeping for a registered Tado zone. */
interface TadoZone {
  zoneId: number;
  type: Zone['type'];
  device: MatterbridgeEndpoint;
}

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger instance.
 * @param {TadoPlatformConfig} config - Platform configuration.
 * @returns {TadoPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: TadoPlatformConfig): TadoPlatform {
  return new TadoPlatform(matterbridge, log, config);
}

/** Tado dynamic platform. */
export class TadoPlatform extends MatterbridgeDynamicPlatform {
  private readonly tado = new Tado();
  private homeId = 0;
  private pollTimer?: NodeJS.Timeout;
  private weatherDevice?: MatterbridgeEndpoint;
  private readonly zones = new Map<string, TadoZone>();

  /**
   * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
   * @param {AnsiLogger} log - Logger instance.
   * @param {TadoPlatformConfig} config - Platform configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: TadoPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`);
    }

    this.log.info('Initializing Tado platform...');

    // Persist the refresh token whenever it is renewed so device pairing is only needed once.
    this.tado.setTokenCallback((token) => {
      void this.context?.set('refreshToken', token.refresh_token);
    });
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    if (!(await this.authenticate())) return;
    await this.discoverDevices();
  }

  /**
   * Authenticate against Tado using the OAuth2 Device Code Flow.
   *
   * A stored refresh token is reused when available; otherwise a pairing code and URL
   * are printed to the logs and frontend for the user to authorize the plugin.
   *
   * @returns {Promise<boolean>} True when authentication succeeded.
   */
  private async authenticate(): Promise<boolean> {
    const refreshToken = (await this.context?.get<string>('refreshToken', '')) || undefined;
    try {
      const [verify, tokenPromise] = await this.tado.authenticate(refreshToken);
      if (verify) {
        const msg = `Tado pairing required: open ${verify.verification_uri_complete} and enter code ${verify.user_code}`;
        this.log.notice(`*** ${msg} ***`);
        this.wssSendSnackbarMessage(msg, 0, 'warning');
      }
      await tokenPromise;
      this.log.info('Tado authentication successful.');
      return true;
    } catch (error) {
      this.log.error(`Tado authentication failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async discoverDevices(): Promise<void> {
    this.log.info('Discovering Tado devices...');

    // Resolve the home id.
    this.homeId = Number(this.config.homeId) || 0;
    if (!this.homeId) {
      const me = await this.tado.getMe();
      this.homeId = me.homes[0]?.id ?? 0;
    }
    if (!this.homeId) {
      this.log.error('No Tado home found for this account.');
      return;
    }
    this.log.info(`Using Tado home id ${this.homeId}.`);

    const zones = await this.tado.getZones(this.homeId);
    for (const zone of zones) {
      const serial = `tado-${this.homeId}-${zone.id}`;
      this.setSelectDevice(serial, zone.name);
      if (!this.validateDevice([zone.name, serial])) continue;
      await this.createZoneDevice(zone, serial);
    }

    // Outside temperature sensor (from weather).
    await this.createWeatherDevice();

    // Initial state refresh and polling loop.
    await this.refreshAll();
    this.pollTimer = setInterval(() => void this.refreshAll(), Math.max(60, Number(this.config.pollInterval) || 120) * 1000);
  }

  /**
   * Create and register a Matter device for a Tado zone.
   *
   * @param {Zone} zone - The Tado zone.
   * @param {string} serial - Stable serial/unique id for the endpoint.
   */
  private async createZoneDevice(zone: Zone, serial: string): Promise<void> {
    const id = serial.replace(/[^A-Za-z0-9]/g, '');
    const device = new MatterbridgeEndpoint([thermostatDevice, humiditySensor], { id }).createDefaultBridgedDeviceBasicInformationClusterServer(
      zone.name,
      serial,
      0xfff1,
      'Tado',
      zone.type,
      1,
      '1.0.0',
    );

    if (zone.type === 'AIR_CONDITIONING') {
      // AC zones support heat and cool.
      device.createDefaultThermostatClusterServer(20, 21, 21);
    } else {
      // HEATING and HOT_WATER zones are heating-only.
      device.createDefaultHeatingThermostatClusterServer(20, 21, 5, 30);
    }
    device.createDefaultRelativeHumidityMeasurementClusterServer().addRequiredClusterServers();

    await this.registerDevice(device);
    this.zones.set(serial, { zoneId: zone.id, type: zone.type, device });

    // React to setpoint and mode changes coming from a Matter controller.
    await device.subscribeAttribute(
      'Thermostat',
      'occupiedHeatingSetpoint',
      (newValue: number, _oldValue: number, context) => {
        if (context?.offline === true) return;
        void this.onSetpoint(serial, newValue);
      },
      this.log,
    );
    if (zone.type === 'AIR_CONDITIONING') {
      await device.subscribeAttribute(
        'Thermostat',
        'occupiedCoolingSetpoint',
        (newValue: number, _oldValue: number, context) => {
          if (context?.offline === true) return;
          void this.onSetpoint(serial, newValue);
        },
        this.log,
      );
    }
    await device.subscribeAttribute(
      'Thermostat',
      'systemMode',
      (newValue: number, _oldValue: number, context) => {
        if (context?.offline === true) return;
        void this.onSystemMode(serial, newValue);
      },
      this.log,
    );

    this.log.info(`Registered Tado zone "${zone.name}" (${zone.type}, id ${zone.id}).`);
  }

  private async createWeatherDevice(): Promise<void> {
    const serial = `tado-${this.homeId}-weather`;
    this.setSelectDevice(serial, 'Outside Temperature');
    if (!this.validateDevice(['Outside Temperature', serial])) return;
    this.weatherDevice = new MatterbridgeEndpoint(temperatureSensor, { id: serial.replace(/[^A-Za-z0-9]/g, '') })
      .createDefaultBridgedDeviceBasicInformationClusterServer('Outside Temperature', serial, 0xfff1, 'Tado', 'Weather', 1, '1.0.0')
      .createDefaultTemperatureMeasurementClusterServer()
      .addRequiredClusterServers();
    await this.registerDevice(this.weatherDevice);
  }

  /**
   * Apply a temperature setpoint to a Tado zone via an overlay.
   *
   * @param {string} serial - The zone serial.
   * @param {number} matterValue - Setpoint from Matter in 0.01°C units.
   */
  private async onSetpoint(serial: string, matterValue: number): Promise<void> {
    const zone = this.zones.get(serial);
    if (!zone) return;
    const celsius = Math.round((matterValue / 100) * 10) / 10;
    try {
      await this.tado.setZoneOverlay(this.homeId, zone.zoneId, 'ON' as Power, celsius, 'MANUAL');
      this.log.info(`Set zone ${zone.zoneId} setpoint to ${celsius}°C.`);
    } catch (error) {
      this.log.error(`Failed to set zone ${zone.zoneId} setpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Apply a system mode (on/off) to a Tado zone via an overlay.
   *
   * @param {string} serial - The zone serial.
   * @param {number} mode - Matter Thermostat SystemMode value.
   */
  private async onSystemMode(serial: string, mode: number): Promise<void> {
    const zone = this.zones.get(serial);
    if (!zone) return;
    try {
      if (mode === SystemMode.Off) {
        await this.tado.setZoneOverlay(this.homeId, zone.zoneId, 'OFF' as Power, undefined, 'MANUAL');
        this.log.info(`Turned zone ${zone.zoneId} off.`);
      } else {
        // Returning to schedule is the closest match for "auto"; on for heat/cool.
        if (mode === SystemMode.Auto) {
          await this.tado.clearZoneOverlay(this.homeId, zone.zoneId);
          this.log.info(`Zone ${zone.zoneId} returned to schedule.`);
        } else {
          const setpoint = this.getNumberAttr(zone.device, 'occupiedHeatingSetpoint', 2100) / 100;
          await this.tado.setZoneOverlay(this.homeId, zone.zoneId, 'ON' as Power, setpoint, 'MANUAL');
          this.log.info(`Turned zone ${zone.zoneId} on at ${setpoint}°C.`);
        }
      }
    } catch (error) {
      this.log.error(`Failed to set zone ${zone.zoneId} mode: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private getNumberAttr(device: MatterbridgeEndpoint, attribute: string, fallback: number): number {
    const value = device.getAttribute('Thermostat', attribute, this.log) as number | null | undefined;
    return typeof value === 'number' ? value : fallback;
  }

  /** Refresh all zones and the weather sensor from the Tado API. */
  private async refreshAll(): Promise<void> {
    try {
      for (const [, zone] of this.zones) {
        const state = await this.tado.getZoneState(this.homeId, zone.zoneId);
        await this.applyZoneState(zone, state);
      }
      if (this.weatherDevice) {
        const weather = await this.tado.getWeather(this.homeId);
        await this.weatherDevice.updateAttribute('TemperatureMeasurement', 'measuredValue', Math.round(weather.outsideTemperature.celsius * 100), this.log);
      }
      const rate = this.tado.getRatelimit();
      if (rate) this.log.debug(`Tado rate limit remaining: ${JSON.stringify(rate)}`);
    } catch (error) {
      this.log.error(`Failed to refresh Tado state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Map a Tado zone state onto the Matter device attributes.
   *
   * @param {TadoZone} zone - The internal zone record.
   * @param {ZoneState} state - The Tado zone state.
   */
  private async applyZoneState(zone: TadoZone, state: ZoneState): Promise<void> {
    const sensors = state.sensorDataPoints;
    const inside = sensors && 'insideTemperature' in sensors ? sensors.insideTemperature?.celsius : undefined;
    const humidity = sensors && 'humidity' in sensors ? sensors.humidity?.percentage : undefined;

    if (typeof inside === 'number') {
      await zone.device.updateAttribute('Thermostat', 'localTemperature', Math.round(inside * 100), this.log);
    }
    if (typeof humidity === 'number') {
      await zone.device.updateAttribute('RelativeHumidityMeasurement', 'measuredValue', Math.round(humidity * 100), this.log);
    }

    const setting = state.setting;
    const power = setting?.power ?? 'OFF';
    const setpoint = setting?.temperature?.celsius;
    if (typeof setpoint === 'number') {
      const attr = zone.type === 'AIR_CONDITIONING' && setting.type === 'AIR_CONDITIONING' ? 'occupiedCoolingSetpoint' : 'occupiedHeatingSetpoint';
      await zone.device.updateAttribute('Thermostat', attr, Math.round(setpoint * 100), this.log);
    }

    const mode = power === 'OFF' ? SystemMode.Off : zone.type === 'AIR_CONDITIONING' ? SystemMode.Cool : SystemMode.Heat;
    await zone.device.updateAttribute('Thermostat', 'systemMode', mode, this.log);
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    await this.refreshAll();
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
    this.zones.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }
}
