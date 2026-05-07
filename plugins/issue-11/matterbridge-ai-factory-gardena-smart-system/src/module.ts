/**
 * Matterbridge plugin for the Gardena Smart System.
 *
 * Exposes:
 *  - POWER_SOCKET services (e.g. connected pump) as on/off outlets.
 *  - SOIL_SENSOR services as combined humidity + temperature sensors.
 *
 * Live updates are received over the Husqvarna Smart System websocket.
 */

import {
  humiditySensor,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  onOffOutlet,
  PlatformConfig,
  PlatformMatterbridge,
  temperatureSensor,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { GardenaClient, GardenaDevice, GardenaResource } from './gardenaClient.js';

/**
 * Matterbridge plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger.
 * @param {PlatformConfig} config - Plugin config.
 * @returns {GardenaPlatform} The platform.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): GardenaPlatform {
  return new GardenaPlatform(matterbridge, log, config);
}

interface PowerSocketBinding {
  kind: 'power-socket';
  serviceId: string;
  endpoint: MatterbridgeEndpoint;
}
interface SensorBinding {
  kind: 'sensor';
  serviceId: string;
  endpoint: MatterbridgeEndpoint;
}
type Binding = PowerSocketBinding | SensorBinding;

export class GardenaPlatform extends MatterbridgeDynamicPlatform {
  private client?: GardenaClient;
  /** Map of Gardena service id -> Matter endpoint binding. */
  private readonly bindings = new Map<string, Binding>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);
    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(`This plugin requires Matterbridge >= 3.4.0. Current: ${this.matterbridge.matterbridgeVersion}`);
    }
    this.log.info('Initializing Gardena Smart System platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart (${reason ?? 'none'})`);
    await this.ready;
    await this.clearSelect();

    const apiKey = (this.config.apiKey as string | undefined)?.trim();
    const apiSecret = (this.config.apiSecret as string | undefined)?.trim();
    const locationId = (this.config.locationId as string | undefined)?.trim() || undefined;

    if (!apiKey || !apiSecret) {
      this.log.error('Gardena: apiKey and apiSecret are required in the plugin config.');
      return;
    }

    this.client = new GardenaClient(apiKey, apiSecret, this.log, locationId);

    try {
      await this.client.authenticate();
      const location = await this.client.loadLocation();
      this.log.info(`Gardena: location "${location.name}" with ${location.devices.size} devices`);
      for (const device of location.devices.values()) {
        await this.registerGardenaDevice(device);
      }
      // Open WS to get live updates.
      this.client.on('resource', (r) => this.handleResourceUpdate(r));
      await this.client.startWebsocket();
    } catch (err) {
      this.log.error(`Gardena startup failed: ${(err as Error).message}`);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure: pushing initial attribute values');
    if (!this.client?.location) return;
    for (const dev of this.client.location.devices.values()) {
      for (const svc of dev.services.values()) {
        await this.applyResourceToEndpoint(svc);
      }
    }
  }

  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown (${reason ?? 'none'})`);
    this.client?.shutdown();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /** Build and register Matter endpoints for one Gardena device. */
  private async registerGardenaDevice(device: GardenaDevice): Promise<void> {
    const baseSerial = device.serial ?? device.id;
    const types = [...device.serviceTypes].join(',');
    this.log.info(`Gardena: device "${device.name}" (${device.id}) services=[${types}]`);
    let exposed = 0;
    for (const svc of device.services.values()) {
      if (svc.type === 'POWER_SOCKET') {
        await this.registerPowerSocket(device, svc, baseSerial);
        exposed++;
      } else if (svc.type === 'SOIL_SENSOR' || svc.type === 'SENSOR') {
        await this.registerSoilSensor(device, svc, baseSerial);
        exposed++;
      }
    }
    if (exposed === 0) {
      this.log.warn(`Gardena: device "${device.name}" exposes no supported service types (got: ${types || 'none'})`);
    }
  }

  private async registerPowerSocket(device: GardenaDevice, svc: GardenaResource, baseSerial: string): Promise<void> {
    const name = `${device.name} Pump`;
    const serial = `${baseSerial}-${svc.id}`.slice(0, 32);
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;

    const endpoint = new MatterbridgeEndpoint(onOffOutlet, { id: `gardena-ps-${svc.id}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        name,
        serial,
        this.matterbridge.aggregatorVendorId,
        'Gardena',
        device.modelType ?? 'Smart Power Socket',
        1,
        '1.0.0',
      )
      .createDefaultPowerSourceWiredClusterServer()
      .addRequiredClusterServers()
      .addCommandHandler('on', async () => {
        this.log.info(`Gardena: ON ${name}`);
        try {
          await this.client?.setPowerSocket(svc.id, true);
        } catch (e) {
          this.log.error(`Gardena ON failed: ${(e as Error).message}`);
        }
      })
      .addCommandHandler('off', async () => {
        this.log.info(`Gardena: OFF ${name}`);
        try {
          await this.client?.setPowerSocket(svc.id, false);
        } catch (e) {
          this.log.error(`Gardena OFF failed: ${(e as Error).message}`);
        }
      });

    await this.registerDevice(endpoint);
    this.bindings.set(svc.id, { kind: 'power-socket', serviceId: svc.id, endpoint });
  }

  private async registerSoilSensor(device: GardenaDevice, svc: GardenaResource, baseSerial: string): Promise<void> {
    const name = `${device.name} Soil`;
    const serial = `${baseSerial}-${svc.id}`.slice(0, 32);
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;

    const endpoint = new MatterbridgeEndpoint([temperatureSensor, humiditySensor], { id: `gardena-soil-${svc.id}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        name,
        serial,
        this.matterbridge.aggregatorVendorId,
        'Gardena',
        device.modelType ?? 'Soil Sensor',
        1,
        '1.0.0',
      )
      .createDefaultPowerSourceReplaceableBatteryClusterServer(100)
      .addRequiredClusterServers();

    await this.registerDevice(endpoint);
    this.bindings.set(svc.id, { kind: 'sensor', serviceId: svc.id, endpoint });
  }

  /** Live websocket update for a resource. */
  private handleResourceUpdate(resource: GardenaResource): void {
    void this.applyResourceToEndpoint(resource);
  }

  private async applyResourceToEndpoint(resource: GardenaResource): Promise<void> {
    const binding = this.bindings.get(resource.id);
    if (!binding) return;
    const attrs = (resource.attributes ?? {}) as Record<string, { value: unknown } | undefined>;

    if (binding.kind === 'power-socket') {
      const activity = attrs.activity?.value as string | undefined;
      // POWER_SOCKET activity values include FOREVER_ON, TIME_LIMITED_ON, SCHEDULED_ON, OFF
      if (activity) {
        const on = activity !== 'OFF';
        await binding.endpoint.updateAttribute('OnOff', 'onOff', on, this.log);
      }
    } else {
      const humidity = attrs.soilHumidity?.value as number | undefined;
      const temperature = attrs.soilTemperature?.value as number | undefined;
      if (typeof humidity === 'number') {
        await binding.endpoint.updateAttribute('RelativeHumidityMeasurement', 'measuredValue', Math.round(humidity * 100), this.log);
      }
      if (typeof temperature === 'number') {
        await binding.endpoint.updateAttribute('TemperatureMeasurement', 'measuredValue', Math.round(temperature * 100), this.log);
      }
    }
  }
}
