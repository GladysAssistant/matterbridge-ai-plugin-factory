/**
 * Matterbridge HomeWizard Energy plugin.
 *
 * Exposes HomeWizard local-API devices (Energy P1, kWh Meter, Watermeter,
 * Plug/Socket, ...) to Matter:
 *  - Active power, voltage, current, frequency -> Electrical Power Measurement
 *  - Energy import/export (kWh)               -> Electrical Energy Measurement
 *  - Relay on/off (energy socket)             -> On/Off Outlet
 *  - Water flow (L/min)                       -> Flow Measurement (best effort)
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { BasePlatformConfig, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformMatterbridge, electricalSensor, flowSensor, onOffOutlet } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { HomeWizardApi, HomeWizardData, HomeWizardKind, kindFromProductType } from './homewizardApi.js';

/** Configuration for a single HomeWizard device. */
export interface HomeWizardDeviceConfig {
  name: string;
  host: string;
  type?: string;
  token?: string;
}

/** Plugin configuration. */
export type HomeWizardPlatformConfig = BasePlatformConfig & {
  devices?: HomeWizardDeviceConfig[];
  pollInterval?: number;
  whiteList?: string[];
  blackList?: string[];
};

interface ManagedDevice {
  cfg: HomeWizardDeviceConfig;
  api: HomeWizardApi;
  kind: HomeWizardKind;
  endpoint: MatterbridgeEndpoint;
}

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The logger.
 * @param {HomeWizardPlatformConfig} config - The platform configuration.
 * @returns {HomeWizardPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: HomeWizardPlatformConfig): HomeWizardPlatform {
  return new HomeWizardPlatform(matterbridge, log, config);
}

/**
 * HomeWizard dynamic platform.
 */
export class HomeWizardPlatform extends MatterbridgeDynamicPlatform {
  private readonly managed: ManagedDevice[] = [];
  private pollTimer?: NodeJS.Timeout;

  /**
   * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
   * @param {AnsiLogger} log - The logger.
   * @param {HomeWizardPlatformConfig} config - The platform configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: HomeWizardPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.7.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.7.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`);
    }

    this.log.info('Initializing HomeWizard Energy platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();
    await this.discoverDevices();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    const interval = Math.max(2, (this.config as HomeWizardPlatformConfig).pollInterval ?? 10) * 1000;
    await this.pollAll();
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, interval);
    this.log.info(`Polling ${this.managed.length} device(s) every ${interval / 1000}s`);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
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
    this.managed.length = 0;
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  private async discoverDevices(): Promise<void> {
    const devices = (this.config as HomeWizardPlatformConfig).devices ?? [];
    if (devices.length === 0) {
      this.log.warn('No devices configured. Add devices in the plugin config (name, host, optional type/token).');
      return;
    }

    for (const cfg of devices) {
      if (!cfg?.host || !cfg?.name) {
        this.log.warn(`Skipping invalid device entry: ${JSON.stringify(cfg)}`);
        continue;
      }
      try {
        const api = new HomeWizardApi(cfg.host, cfg.token);

        // Resolve product type / serial from the device when possible.
        let productType = cfg.type;
        let serial = `hwe-${cfg.name}-${cfg.host}`;
        try {
          const info = await api.getInfo();
          productType = productType ?? info.product_type;
          if (info.serial) serial = info.serial;
        } catch (e) {
          this.log.debug(`GET /api failed for ${cfg.name}: ${(e as Error).message}`);
        }
        const kind = kindFromProductType(productType);

        this.setSelectDevice(serial, cfg.name);
        if (!this.validateDevice([cfg.name, serial])) continue;

        const endpoint = this.buildEndpoint(cfg, kind, serial, productType, api);
        await this.registerDevice(endpoint);
        this.managed.push({ cfg, api, kind, endpoint });
        this.log.info(`Registered ${cfg.name} (${productType ?? 'unknown'} -> ${kind}) at ${cfg.host}`);
      } catch (e) {
        this.log.error(`Failed to set up device ${cfg.name}: ${(e as Error).message}`);
      }
    }
  }

  private buildEndpoint(cfg: HomeWizardDeviceConfig, kind: HomeWizardKind, serial: string, productType: string | undefined, api: HomeWizardApi): MatterbridgeEndpoint {
    const id = `${cfg.name}-${serial}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 32) || 'hwedevice';
    const model = productType ?? 'HomeWizard';

    if (kind === 'water') {
      return new MatterbridgeEndpoint(flowSensor, { id })
        .createDefaultBridgedDeviceBasicInformationClusterServer(cfg.name, serial, this.matterbridge.aggregatorVendorId, 'HomeWizard', model, 1, '1.0.0')
        .createDefaultFlowMeasurementClusterServer(0, 0, 65534)
        .addRequiredClusterServers();
    }

    if (kind === 'socket') {
      const endpoint = new MatterbridgeEndpoint([onOffOutlet, electricalSensor], { id })
        .createDefaultBridgedDeviceBasicInformationClusterServer(cfg.name, serial, this.matterbridge.aggregatorVendorId, 'HomeWizard', model, 1, '1.0.0')
        .createDefaultOnOffClusterServer(false)
        .createDefaultElectricalPowerMeasurementClusterServer()
        .createDefaultElectricalEnergyMeasurementClusterServer()
        .addRequiredClusterServers();
      endpoint.addCommandHandler('on', () => {
        void api.setState({ power_on: true }).catch((e) => this.log.error(`setState on failed for ${cfg.name}: ${(e as Error).message}`));
      });
      endpoint.addCommandHandler('off', () => {
        void api.setState({ power_on: false }).catch((e) => this.log.error(`setState off failed for ${cfg.name}: ${(e as Error).message}`));
      });
      return endpoint;
    }

    // energy: P1 / kWh meters
    return new MatterbridgeEndpoint(electricalSensor, { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(cfg.name, serial, this.matterbridge.aggregatorVendorId, 'HomeWizard', model, 1, '1.0.0')
      .createDefaultElectricalPowerMeasurementClusterServer()
      .createDefaultElectricalEnergyMeasurementClusterServer()
      .addRequiredClusterServers();
  }

  private async pollAll(): Promise<void> {
    await Promise.all(this.managed.map((m) => this.pollDevice(m)));
  }

  private async pollDevice(m: ManagedDevice): Promise<void> {
    try {
      const data = await m.api.getData();
      if (m.kind === 'water') {
        await this.updateWater(m, data);
      } else {
        await this.updateEnergy(m, data);
        if (m.kind === 'socket') {
          try {
            const state = await m.api.getState();
            if (typeof state.power_on === 'boolean') await m.endpoint.updateAttribute('OnOff', 'onOff', state.power_on, m.endpoint.log);
          } catch (e) {
            m.endpoint.log.debug(`getState failed: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      m.endpoint.log.debug(`Poll failed for ${m.cfg.name}: ${(e as Error).message}`);
    }
  }

  private async updateEnergy(m: ManagedDevice, data: HomeWizardData): Promise<void> {
    const ep = m.endpoint;
    const voltage = data.active_voltage_v ?? data.active_voltage_l1_v;
    const current = data.active_current_a ?? data.active_current_l1_a;
    const power = data.active_power_w;
    const freq = data.active_frequency_hz;

    if (typeof voltage === 'number') await ep.updateAttribute('ElectricalPowerMeasurement', 'voltage', Math.round(voltage * 1000), ep.log);
    if (typeof current === 'number') await ep.updateAttribute('ElectricalPowerMeasurement', 'activeCurrent', Math.round(current * 1000), ep.log);
    if (typeof power === 'number') await ep.updateAttribute('ElectricalPowerMeasurement', 'activePower', Math.round(power * 1000), ep.log);
    if (typeof freq === 'number') await ep.updateAttribute('ElectricalPowerMeasurement', 'frequency', Math.round(freq * 1000), ep.log);

    if (typeof data.total_power_import_kwh === 'number') {
      await ep.updateAttribute('ElectricalEnergyMeasurement', 'cumulativeEnergyImported', { energy: Math.round(data.total_power_import_kwh * 1_000_000) }, ep.log);
    }
    if (typeof data.total_power_export_kwh === 'number') {
      await ep.updateAttribute('ElectricalEnergyMeasurement', 'cumulativeEnergyExported', { energy: Math.round(data.total_power_export_kwh * 1_000_000) }, ep.log);
    }
  }

  private async updateWater(m: ManagedDevice, data: HomeWizardData): Promise<void> {
    if (typeof data.active_liter_lpm !== 'number') return;
    // Matter FlowMeasurement uses 0.1 m3/h units. L/min -> m3/h = lpm * 0.06; in 0.1 units => lpm * 0.6.
    const value = Math.max(0, Math.round(data.active_liter_lpm * 0.6));
    await m.endpoint.updateAttribute('FlowMeasurement', 'measuredValue', value, m.endpoint.log);
  }
}
