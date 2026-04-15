/**
 * Matterbridge MELCloud Plugin
 * Controls Mitsubishi Air Conditioning devices via MELCloud cloud API.
 *
 * Capabilities: On/Off, Temperature Setpoint, AC Mode (Heat/Cool/Auto)
 */

import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, MatterbridgeThermostatServer, airConditioner, powerSource, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { MelCloudClient, MelCloudDeviceInfo, melcloudModeToMatter, matterModeToMelcloud } from './melcloud.js';

interface MelCloudConfig extends PlatformConfig {
  email?: string;
  password?: string;
  pollInterval?: number;
}

interface TrackedDevice {
  endpoint: MatterbridgeEndpoint;
  deviceId: number;
  buildingId: number;
}

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): MelCloudPlatform {
  return new MelCloudPlatform(matterbridge, log, config);
}

export class MelCloudPlatform extends MatterbridgeDynamicPlatform {
  private client: MelCloudClient = new MelCloudClient();
  private trackedDevices: Map<number, TrackedDevice> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (this.verifyMatterbridgeVersion === undefined || typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge.`);
    }

    this.log.info('MELCloud platform initializing...');
  }

  override async onStart(reason?: string) {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const cfg = this.config as MelCloudConfig;

    if (!cfg.email || !cfg.password) {
      this.log.error('MELCloud: email and password must be configured.');
      return;
    }

    try {
      this.log.info('MELCloud: logging in...');
      await this.client.login(cfg.email, cfg.password);
      this.log.info('MELCloud: logged in successfully.');
    } catch (err) {
      this.log.error(`MELCloud: login failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    await this.discoverDevices();

    const pollInterval = (cfg.pollInterval ?? 60) * 1000;
    this.pollTimer = setInterval(() => {
      this.pollDevices().catch((e) => this.log.error(`MELCloud poll error: ${e instanceof Error ? e.message : String(e)}`));
    }, pollInterval);
  }

  override async onConfigure() {
    await super.onConfigure();
    this.log.info('onConfigure called');

    for (const [deviceId, tracked] of this.trackedDevices) {
      try {
        const state = await this.client.getDeviceState(tracked.deviceId, tracked.buildingId);
        await this.updateEndpoint(tracked.endpoint, state);
      } catch (err) {
        this.log.error(`MELCloud configure error for device ${deviceId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  override async onChangeLoggerLevel(logLevel: LogLevel) {
    this.log.info(`onChangeLoggerLevel: ${logLevel}`);
  }

  override async onShutdown(reason?: string) {
    await super.onShutdown(reason);
    this.log.info(`onShutdown: ${reason ?? 'none'}`);

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private async discoverDevices() {
    let devices: MelCloudDeviceInfo[];

    try {
      devices = await this.client.listDevices();
    } catch (err) {
      this.log.error(`MELCloud: failed to list devices: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    this.log.info(`MELCloud: found ${devices.length} device(s).`);

    for (const device of devices) {
      await this.registerMelCloudDevice(device);
    }
  }

  private async registerMelCloudDevice(device: MelCloudDeviceInfo) {
    const deviceName = device.DeviceName || `AC ${device.DeviceID}`;
    const serial = String(device.DeviceID);
    const uniqueId = `melcloud-${device.DeviceID}`;

    this.log.info(`MELCloud: registering device "${deviceName}" (ID: ${device.DeviceID}, Building: ${device.BuildingID})`);

    // Initial Matter values
    const localTemp = Math.round(device.RoomTemperature * 100);
    const heatSetpoint = Math.round(device.SetTemperature * 100);
    const coolSetpoint = Math.round(device.SetTemperature * 100);
    const minHeat = Math.round((device.MinTemperature ?? 10) * 100);
    const maxHeat = Math.round((device.MaxTemperature ?? 32) * 100);
    const minCool = Math.round((device.MinTemperature ?? 10) * 100);
    const maxCool = Math.round((device.MaxTemperature ?? 32) * 100);

    const endpoint = new MatterbridgeEndpoint([airConditioner, powerSource], { id: uniqueId })
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        deviceName,
        serial,
        this.matterbridge.aggregatorVendorId,
        'Mitsubishi Electric',
        'MELCloud AC',
      )
      .createDefaultPowerSourceWiredClusterServer()
      .createDeadFrontOnOffClusterServer(device.Power)
      .createDefaultThermostatClusterServer(
        localTemp,
        heatSetpoint,
        coolSetpoint,
        100, // minSetpointDeadBand 1°C
        minHeat,
        maxHeat,
        minCool,
        maxCool,
      )
      .createDefaultThermostatUserInterfaceConfigurationClusterServer()
      .createDefaultFanControlClusterServer()
      .addRequiredClusterServers();

    // Set initial systemMode
    const initialMode = device.Power ? (melcloudModeToMatter[device.OperationMode] ?? 1) : 0;
    await endpoint.setAttribute('thermostat', 'systemMode', initialMode, this.log);

    // Handle On command
    endpoint.addCommandHandler('on', async () => {
      this.log.info(`MELCloud [${deviceName}]: power ON`);
      try {
        await this.client.setPower(device.DeviceID, device.BuildingID, true);
        // Also restore last mode - set via systemMode attribute if we have it
        const mode = endpoint.getAttribute('thermostat', 'systemMode', this.log) as number;
        const melMode = mode === 0 ? 8 : matterModeToMelcloud[mode] ?? 8;
        await this.client.setOperationMode(device.DeviceID, device.BuildingID, melMode);
      } catch (err) {
        this.log.error(`MELCloud setPower ON error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // Handle Off command
    endpoint.addCommandHandler('off', async () => {
      this.log.info(`MELCloud [${deviceName}]: power OFF`);
      try {
        await this.client.setPower(device.DeviceID, device.BuildingID, false);
      } catch (err) {
        this.log.error(`MELCloud setPower OFF error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    this.setSelectDevice(serial, deviceName);
    const selected = this.validateDevice([deviceName, serial]);
    if (!selected) return;

    await this.registerDevice(endpoint);

    // Subscribe to thermostat attribute changes AFTER registration
    await endpoint.subscribeAttribute(MatterbridgeThermostatServer, 'systemMode', async (newValue, oldValue) => {
      if (newValue === oldValue) return;
      this.log.info(`MELCloud [${deviceName}]: systemMode changed ${oldValue} -> ${newValue}`);
      try {
        if (newValue === 0) {
          // Off
          await this.client.setPower(device.DeviceID, device.BuildingID, false);
        } else {
          const melMode = matterModeToMelcloud[newValue];
          if (melMode !== undefined) {
            // Make sure power is on
            await this.client.setPower(device.DeviceID, device.BuildingID, true);
            await this.client.setOperationMode(device.DeviceID, device.BuildingID, melMode);
          }
        }
      } catch (err) {
        this.log.error(`MELCloud setMode error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, this.log);

    await endpoint.subscribeAttribute(MatterbridgeThermostatServer, 'occupiedHeatingSetpoint', async (newValue, oldValue) => {
      if (newValue === oldValue) return;
      const tempC = newValue / 100;
      this.log.info(`MELCloud [${deviceName}]: heating setpoint -> ${tempC}°C`);
      try {
        await this.client.setTemperature(device.DeviceID, device.BuildingID, tempC);
      } catch (err) {
        this.log.error(`MELCloud setTemperature error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, this.log);

    await endpoint.subscribeAttribute(MatterbridgeThermostatServer, 'occupiedCoolingSetpoint', async (newValue, oldValue) => {
      if (newValue === oldValue) return;
      const tempC = newValue / 100;
      this.log.info(`MELCloud [${deviceName}]: cooling setpoint -> ${tempC}°C`);
      try {
        await this.client.setTemperature(device.DeviceID, device.BuildingID, tempC);
      } catch (err) {
        this.log.error(`MELCloud setTemperature error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, this.log);

    this.trackedDevices.set(device.DeviceID, {
      endpoint,
      deviceId: device.DeviceID,
      buildingId: device.BuildingID,
    });
  }

  private async pollDevices() {
    for (const [, tracked] of this.trackedDevices) {
      try {
        const state = await this.client.getDeviceState(tracked.deviceId, tracked.buildingId);
        await this.updateEndpoint(tracked.endpoint, state);
      } catch (err) {
        this.log.error(`MELCloud poll error for device ${tracked.deviceId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async updateEndpoint(endpoint: MatterbridgeEndpoint, state: MelCloudDeviceInfo) {
    // Update OnOff
    await endpoint.setAttribute('onOff', 'onOff', state.Power, this.log);

    // Update localTemperature
    const localTemp = Math.round(state.RoomTemperature * 100);
    await endpoint.setAttribute('thermostat', 'localTemperature', localTemp, this.log);

    // Update setpoints
    const setpoint = Math.round(state.SetTemperature * 100);
    await endpoint.setAttribute('thermostat', 'occupiedHeatingSetpoint', setpoint, this.log);
    await endpoint.setAttribute('thermostat', 'occupiedCoolingSetpoint', setpoint, this.log);

    // Update systemMode
    const systemMode = state.Power ? (melcloudModeToMatter[state.OperationMode] ?? 1) : 0;
    await endpoint.setAttribute('thermostat', 'systemMode', systemMode, this.log);
  }
}
