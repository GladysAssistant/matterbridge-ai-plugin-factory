/**
 * Matterbridge MELCloud Plugin
 * Integrates Mitsubishi MELCloud air conditioners and heat pumps with Matter.
 *
 * @file module.ts
 */

import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, airConditioner, powerSource, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import MELCloudAPI, { DeviceInfo } from 'melcloud-api';

// Derive logger type from Matterbridge itself to avoid dual-package hazard
type MatterbridgeLog = ConstructorParameters<typeof MatterbridgeDynamicPlatform>[1];

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: MatterbridgeLog, config: PlatformConfig): MelCloudPlatform {
  return new MelCloudPlatform(matterbridge, log, config);
}

export class MelCloudPlatform extends MatterbridgeDynamicPlatform {
  private client: InstanceType<typeof MELCloudAPI> | undefined;
  private pollInterval: ReturnType<typeof setInterval> | undefined;

  // Map deviceId -> MatterbridgeEndpoint
  private deviceMap = new Map<number, MatterbridgeEndpoint>();

  constructor(matterbridge: PlatformMatterbridge, log: MatterbridgeLog, config: PlatformConfig) {
    super(matterbridge, log, config);
    this.log.info('MELCloud plugin initializing...');
  }

  override async onStart(reason?: string) {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const email = (this.config['email'] as string) ?? '';
    const password = (this.config['password'] as string) ?? '';

    if (!email || !password) {
      this.log.error('MELCloud email and password must be configured. Set them in the plugin config.');
      return;
    }

    this.client = new MELCloudAPI(email, password);

    try {
      this.log.info('Logging in to MELCloud...');
      await this.client.login();
      this.log.info('MELCloud login successful.');
      await this.discoverDevices();
    } catch (err) {
      this.log.error(`MELCloud login failed: ${(err as Error).message}`);
    }
  }

  override async onConfigure() {
    await super.onConfigure();
    this.log.info('onConfigure called');

    // Start polling after configure
    const pollSeconds = ((this.config['pollInterval'] as number) ?? 60) * 1000;
    this.pollInterval = setInterval(() => {
      this.pollDevices().catch((e) => this.log.error(`Poll error: ${(e as Error).message}`));
    }, pollSeconds);
    this.log.info(`Polling MELCloud every ${pollSeconds / 1000}s`);

    // Initial poll
    await this.pollDevices();
  }

  override async onShutdown(reason?: string) {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }

    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private async discoverDevices() {
    if (!this.client) return;

    let devices: DeviceInfo[] = [];
    try {
      devices = await this.client.getDevices();
    } catch (err) {
      this.log.error(`Failed to get MELCloud devices: ${(err as Error).message}`);
      return;
    }

    this.log.info(`Found ${devices.length} MELCloud device(s).`);

    for (const dev of devices) {
      const serialStr = String(dev.id);
      const deviceName = dev.name || `MELCloud-${dev.id}`;
      const endpointId = `melcloud-${dev.id}`;

      this.setSelectDevice(serialStr, deviceName);
      const selected = this.validateDevice([deviceName, serialStr]);
      if (!selected) {
        this.log.info(`Skipping device ${deviceName} (not selected)`);
        continue;
      }

      const localTempCentidegrees = Math.round((dev.roomTemperature ?? 20) * 100);
      const setpointCentidegrees = Math.round((dev.temperature ?? 22) * 100);

      const endpoint = new MatterbridgeEndpoint([airConditioner, powerSource], { id: endpointId })
        .createDefaultBridgedDeviceBasicInformationClusterServer(deviceName, serialStr, this.matterbridge.aggregatorVendorId, 'Mitsubishi Electric', 'MELCloud Device')
        .createDefaultThermostatClusterServer(
          localTempCentidegrees, // localTemperature in 0.01°C units
          setpointCentidegrees, // occupiedHeatingSetpoint
          setpointCentidegrees, // occupiedCoolingSetpoint
        )
        .createDefaultFanControlClusterServer()
        .createDefaultPowerSourceWiredClusterServer()
        .addRequiredClusterServers();

      // Handle thermostat setpoint changes
      endpoint.addCommandHandler('setpointRaiseLower', async (data: { request: { amount: number } }) => {
        if (!this.client) return;
        const amount = data.request.amount;
        const currentTemp = dev.temperature ?? 22;
        const newTemp = currentTemp + amount / 10;
        this.log.info(`Setting temperature for device ${dev.id} to ${newTemp}°C`);
        try {
          await this.client!.setTemperature(dev.id, newTemp);
          dev.temperature = newTemp;
        } catch (e) {
          this.log.error(`Failed to set temperature: ${(e as Error).message}`);
        }
      });

      await this.registerDevice(endpoint);
      this.deviceMap.set(dev.id, endpoint);
      this.log.info(`Registered MELCloud device: ${deviceName} (id=${dev.id}, type=${dev.type === 1 ? 'HeatPump' : 'AirConditioner'})`);
    }
  }

  private async pollDevices() {
    if (!this.client || this.deviceMap.size === 0) return;

    for (const [deviceId, endpoint] of this.deviceMap.entries()) {
      try {
        const dev = await this.client.getDevice(deviceId);

        // Update local temperature attribute (centidegrees)
        const localTempCentidegrees = Math.round((dev.roomTemperature ?? 20) * 100);
        await endpoint.setAttribute('thermostat', 'localTemperature', localTempCentidegrees, this.log);

        // Update setpoint
        const setpointCentidegrees = Math.round((dev.temperature ?? 22) * 100);
        await endpoint.setAttribute('thermostat', 'occupiedHeatingSetpoint', setpointCentidegrees, this.log);
        await endpoint.setAttribute('thermostat', 'occupiedCoolingSetpoint', setpointCentidegrees, this.log);

        this.log.debug(`Polled ${dev.name}: room=${dev.roomTemperature}°C, set=${dev.temperature}°C`);
      } catch (e) {
        this.log.error(`Failed to poll device ${deviceId}: ${(e as Error).message}`);
      }
    }
  }
}
