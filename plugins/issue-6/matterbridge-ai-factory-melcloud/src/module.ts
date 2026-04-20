/**
 * Matterbridge MELCloud plugin.
 *
 * Exposes Mitsubishi MELCloud air-to-air units as Matter AirConditioner devices.
 * Supported capabilities: On/Off, target temperature, and mode (Heat / Cool / Auto).
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AirConditioner } from 'matterbridge/devices';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { Thermostat } from 'matterbridge/matter/clusters';

import { MelCloudClient, MelCloudDevice, OP_MODE } from './melcloudClient.js';

/**
 * Plugin entry point. Matterbridge calls this with the platform wiring.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Plugin logger.
 * @param {PlatformConfig} config - Plugin config.
 * @returns {MelCloudPlatform} platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): MelCloudPlatform {
  return new MelCloudPlatform(matterbridge, log, config);
}

interface DeviceEntry {
  melDevice: MelCloudDevice;
  endpoint: MatterbridgeEndpoint;
  setpoint: number;
  mode: number;
  power: boolean;
}

/**
 * DynamicPlatform that bridges MELCloud air conditioners to Matter.
 */
export class MelCloudPlatform extends MatterbridgeDynamicPlatform {
  private client?: MelCloudClient;
  private devices = new Map<number, DeviceEntry>();
  private pollTimer?: NodeJS.Timeout;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (this.verifyMatterbridgeVersion === undefined || typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info('Initializing MELCloud Platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const username = (this.config.username as string | undefined) ?? '';
    const password = (this.config.password as string | undefined) ?? '';
    if (!username || !password) {
      this.log.error('MELCloud username/password are not configured. Plugin will not expose any device.');
      return;
    }

    this.client = new MelCloudClient(username, password, this.log);

    try {
      const ok = await this.client.login();
      if (!ok) {
        this.log.error('MELCloud login failed.');
        return;
      }
      this.log.info('MELCloud login successful.');
      await this.discoverDevices();
    } catch (e) {
      this.log.error(`Error while starting MELCloud plugin: ${(e as Error).message}`);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    for (const entry of this.devices.values()) {
      await this.pushStateToMatter(entry).catch((e) => this.log.error(`Initial attribute push failed: ${(e as Error).message}`));
    }

    const intervalSec = Math.max(30, Number(this.config.pollIntervalSeconds ?? 60));
    this.pollTimer = setInterval(() => {
      this.pollAll().catch((e) => this.log.error(`Poll cycle error: ${(e as Error).message}`));
    }, intervalSec * 1000);
  }

  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private async discoverDevices(): Promise<void> {
    if (!this.client) return;

    let melDevices: MelCloudDevice[];
    try {
      melDevices = await this.client.listDevices();
    } catch (e) {
      this.log.error(`Unable to load MELCloud devices: ${(e as Error).message}`);
      return;
    }
    this.log.info(`Discovered ${melDevices.length} MELCloud device(s).`);

    for (const d of melDevices) {
      if (d.Device.DeviceType !== 0) {
        this.log.info(`Skipping non Air-To-Air device "${d.DeviceName}" (type=${d.Device.DeviceType}).`);
        continue;
      }

      const serial = `MEL-${d.DeviceID}`;
      this.setSelectDevice(serial, d.DeviceName);
      if (!this.validateDevice([d.DeviceName, serial])) continue;

      const heatMin = d.Device.MinTempHeat ?? 10;
      const heatMax = d.Device.MaxTempHeat ?? 31;
      const coolMin = d.Device.MinTempCoolDry ?? 16;
      const coolMax = d.Device.MaxTempCoolDry ?? 31;
      const local = d.Device.RoomTemperature ?? 23;
      const setpoint = d.Device.SetTemperature ?? 23;

      const endpoint = new AirConditioner(d.DeviceName, serial, {
        localTemperature: local,
        occupiedHeatingSetpoint: setpoint,
        occupiedCoolingSetpoint: setpoint,
        minHeatSetpointLimit: heatMin,
        maxHeatSetpointLimit: heatMax,
        minCoolSetpointLimit: coolMin,
        maxCoolSetpointLimit: coolMax,
        minSetpointDeadBand: 1,
      });

      const entry: DeviceEntry = {
        melDevice: d,
        endpoint,
        setpoint,
        mode: d.Device.OperationMode,
        power: d.Device.Power,
      };
      this.devices.set(d.DeviceID, entry);

      this.wireCommands(entry);

      await this.registerDevice(endpoint);
      this.log.info(`Registered MELCloud device "${d.DeviceName}" (${serial}).`);
    }
  }

  private wireCommands(entry: DeviceEntry): void {
    const { endpoint } = entry;

    endpoint.addCommandHandler('on', async () => {
      this.log.info(`[${entry.melDevice.DeviceName}] on`);
      entry.power = true;
      await this.pushPower(entry, true);
    });
    endpoint.addCommandHandler('off', async () => {
      this.log.info(`[${entry.melDevice.DeviceName}] off`);
      entry.power = false;
      await this.pushPower(entry, false);
    });
    endpoint.addCommandHandler('toggle', async () => {
      entry.power = !entry.power;
      this.log.info(`[${entry.melDevice.DeviceName}] toggle -> ${entry.power}`);
      await this.pushPower(entry, entry.power);
    });

    endpoint.subscribeAttribute(
      'Thermostat',
      'systemMode',
      (value: Thermostat.SystemMode) => {
        this.onSystemModeChange(entry, value).catch((e) => this.log.error(`systemMode handler error: ${(e as Error).message}`));
      },
      this.log,
    );
    endpoint.subscribeAttribute(
      'Thermostat',
      'occupiedHeatingSetpoint',
      (value: number) => {
        this.onSetpointChange(entry, value).catch((e) => this.log.error(`heat setpoint handler error: ${(e as Error).message}`));
      },
      this.log,
    );
    endpoint.subscribeAttribute(
      'Thermostat',
      'occupiedCoolingSetpoint',
      (value: number) => {
        this.onSetpointChange(entry, value).catch((e) => this.log.error(`cool setpoint handler error: ${(e as Error).message}`));
      },
      this.log,
    );
  }

  private async onSystemModeChange(entry: DeviceEntry, mode: Thermostat.SystemMode): Promise<void> {
    const name = entry.melDevice.DeviceName;
    if (mode === Thermostat.SystemMode.Off) {
      this.log.info(`[${name}] systemMode=Off -> power off`);
      entry.power = false;
      await this.pushPower(entry, false);
      return;
    }
    let melMode = entry.mode;
    if (mode === Thermostat.SystemMode.Heat) melMode = OP_MODE.HEAT;
    else if (mode === Thermostat.SystemMode.Cool) melMode = OP_MODE.COOL;
    else if (mode === Thermostat.SystemMode.Auto) melMode = OP_MODE.AUTO;
    else return;

    entry.mode = melMode;
    if (!entry.power) entry.power = true;
    this.log.info(`[${name}] systemMode=${Thermostat.SystemMode[mode]} -> MEL mode=${melMode}`);
    await this.pushPowerAndMode(entry);
  }

  private async onSetpointChange(entry: DeviceEntry, centi: number): Promise<void> {
    const value = centi / 100;
    if (value === entry.setpoint) return;
    entry.setpoint = value;
    this.log.info(`[${entry.melDevice.DeviceName}] setpoint -> ${value}`);
    await this.pushSetpoint(entry, value);
  }

  private async pushPower(entry: DeviceEntry, power: boolean): Promise<void> {
    if (!this.client) return;
    try {
      const state = await this.client.getDevice(entry.melDevice.DeviceID, entry.melDevice.BuildingID);
      state.EffectiveFlags = 1;
      state.Power = power;
      await this.client.setAta(state);
    } catch (e) {
      this.log.error(`pushPower error: ${(e as Error).message}`);
    }
  }

  private async pushPowerAndMode(entry: DeviceEntry): Promise<void> {
    if (!this.client) return;
    try {
      const state = await this.client.getDevice(entry.melDevice.DeviceID, entry.melDevice.BuildingID);
      state.EffectiveFlags = 1 | 2; // Power + OperationMode
      state.Power = entry.power;
      state.OperationMode = entry.mode;
      await this.client.setAta(state);
    } catch (e) {
      this.log.error(`pushPowerAndMode error: ${(e as Error).message}`);
    }
  }

  private async pushSetpoint(entry: DeviceEntry, value: number): Promise<void> {
    if (!this.client) return;
    try {
      const state = await this.client.getDevice(entry.melDevice.DeviceID, entry.melDevice.BuildingID);
      state.EffectiveFlags = 4;
      state.SetTemperature = value;
      await this.client.setAta(state);
    } catch (e) {
      this.log.error(`pushSetpoint error: ${(e as Error).message}`);
    }
  }

  private async pollAll(): Promise<void> {
    if (!this.client) return;
    for (const entry of this.devices.values()) {
      try {
        const state = await this.client.getDevice(entry.melDevice.DeviceID, entry.melDevice.BuildingID);
        entry.power = state.Power;
        entry.mode = state.OperationMode;
        entry.setpoint = state.SetTemperature;
        entry.melDevice.Device.RoomTemperature = state.RoomTemperature;
        await this.pushStateToMatter(entry);
      } catch (e) {
        this.log.error(`poll ${entry.melDevice.DeviceName}: ${(e as Error).message}`);
      }
    }
  }

  private async pushStateToMatter(entry: DeviceEntry): Promise<void> {
    const { endpoint, power, mode, setpoint, melDevice } = entry;
    const systemMode = this.melModeToSystemMode(power, mode);

    await endpoint.setAttribute('OnOff', 'onOff', power, this.log);
    await endpoint.setAttribute('Thermostat', 'systemMode', systemMode, this.log);
    await endpoint.setAttribute('Thermostat', 'localTemperature', Math.round(melDevice.Device.RoomTemperature * 100), this.log);
    await endpoint.setAttribute('Thermostat', 'occupiedHeatingSetpoint', Math.round(setpoint * 100), this.log);
    await endpoint.setAttribute('Thermostat', 'occupiedCoolingSetpoint', Math.round(setpoint * 100), this.log);
  }

  private melModeToSystemMode(power: boolean, melMode: number): Thermostat.SystemMode {
    if (!power) return Thermostat.SystemMode.Off;
    switch (melMode) {
      case OP_MODE.HEAT:
        return Thermostat.SystemMode.Heat;
      case OP_MODE.COOL:
      case OP_MODE.DRY:
        return Thermostat.SystemMode.Cool;
      case OP_MODE.AUTO:
      case OP_MODE.FAN:
      default:
        return Thermostat.SystemMode.Auto;
    }
  }
}
