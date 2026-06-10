/**
 * Matterbridge plugin for TP-Link Kasa & Tapo devices.
 *
 * Exposes plugs, switches, dimmers and lights over local LAN, plus energy
 * monitoring for supported plugs. Kasa devices use the tplink-smarthome-api
 * (local UDP/TCP); Tapo devices use tp-link-tapo-connect (KLAP, account login).
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  colorTemperatureLight,
  dimmableLight,
  DeviceTypeDefinition,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  onOffLight,
  onOffOutlet,
  onOffSwitch,
  PlatformMatterbridge,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { ColorControl, ElectricalEnergyMeasurement, ElectricalPowerMeasurement, LevelControl, OnOff } from 'matterbridge/matter/clusters';
import { Client } from 'tplink-smarthome-api';

import { DeviceCategory, DeviceConn, kelvinToMireds, levelToPercent, miredsToKelvin, percentToLevel, TpLinkPlatformConfig } from './deviceConn.js';
import { connectKasaDevice, discoverKasaDevices } from './kasa.js';
import { connectTapoDevice } from './tapo.js';

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The logger instance.
 * @param {TpLinkPlatformConfig} config - The platform configuration.
 * @returns {TpLinkPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: TpLinkPlatformConfig): TpLinkPlatform {
  return new TpLinkPlatform(matterbridge, log, config);
}

/** DynamicPlatform exposing TP-Link Kasa & Tapo devices to Matter. */
export class TpLinkPlatform extends MatterbridgeDynamicPlatform {
  private readonly conns = new Map<string, DeviceConn>();
  private readonly endpoints = new Map<MatterbridgeEndpoint, DeviceConn>();
  private readonly kasaClient = new Client();
  private pollTimer?: NodeJS.Timeout;

  /**
   * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
   * @param {AnsiLogger} log - The logger instance.
   * @param {TpLinkPlatformConfig} config - The platform configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: TpLinkPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.7.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.7.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`);
    }

    this.log.info('Initializing TP-Link Kasa & Tapo platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const config = this.config as TpLinkPlatformConfig;

    // 1) Kasa broadcast discovery.
    if (config.enableKasaDiscovery !== false) {
      const timeoutMs = Math.max(1, Number(config.discoveryTimeout ?? 5)) * 1000;
      this.log.info(`Discovering Kasa devices (${timeoutMs / 1000}s)...`);
      try {
        const discovered = await discoverKasaDevices(this.kasaClient, timeoutMs, this.log);
        for (const conn of discovered) await this.registerConn(conn);
      } catch (error) {
        this.log.error(`Kasa discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 2) Manually configured devices.
    for (const entry of config.devices ?? []) {
      if (!entry?.host) continue;
      if (entry.protocol === 'tapo') {
        const conn = await connectTapoDevice(config.username ?? '', config.password ?? '', entry.host, entry.name, this.log);
        if (conn) await this.registerConn(conn);
      } else {
        const conn = await connectKasaDevice(this.kasaClient, entry.host, this.log);
        if (conn) await this.registerConn(conn);
      }
    }

    this.log.info(`Registered ${this.conns.size} TP-Link device(s).`);
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    // Prime device state once, then start polling.
    for (const [endpoint, conn] of this.endpoints) await this.updateFromConn(endpoint, conn);

    const intervalMs = Math.max(2, Number((this.config as TpLinkPlatformConfig).pollInterval ?? 5)) * 1000;
    this.pollTimer = setInterval(() => void this.pollAll(), intervalMs);
    this.log.info(`Polling every ${intervalMs / 1000}s.`);
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
    for (const conn of this.conns.values()) conn.close();
    try {
      this.kasaClient.stopDiscovery();
    } catch {
      // ignore: discovery may already be stopped.
    }
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Map a device category to its Matter device type definition.
   *
   * @param {DeviceCategory} category - The device category.
   * @returns {DeviceTypeDefinition} The Matter device type.
   */
  private deviceTypeFor(category: DeviceCategory): DeviceTypeDefinition {
    switch (category) {
      case 'colorlight':
        return colorTemperatureLight;
      case 'light':
      case 'dimmer':
        return dimmableLight;
      case 'switch':
        return onOffSwitch;
      case 'outlet':
        return onOffOutlet;
      default:
        return onOffLight;
    }
  }

  /**
   * Build, validate and register a Matter endpoint for a device connection.
   *
   * @param {DeviceConn} conn - The unified device handle.
   * @returns {Promise<void>} Resolves once registered (or skipped).
   */
  private async registerConn(conn: DeviceConn): Promise<void> {
    if (this.conns.has(conn.id)) return;

    this.setSelectDevice(conn.serial, conn.name);
    if (!this.validateDevice([conn.name, conn.serial], true)) return;

    const dimmable = conn.category === 'light' || conn.category === 'dimmer' || conn.category === 'colorlight';
    const endpoint = new MatterbridgeEndpoint(this.deviceTypeFor(conn.category), { id: conn.id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(conn.name, conn.serial, this.matterbridge.aggregatorVendorId, 'TP-Link', conn.model)
      .createDefaultPowerSourceWiredClusterServer();

    if (conn.category === 'colorlight') {
      const minK = conn.ctMinKelvin ?? 2500;
      const maxK = conn.ctMaxKelvin ?? 6500;
      // Note: smallest mireds == highest Kelvin, so min/max mireds are swapped vs Kelvin.
      endpoint.createDefaultColorControlClusterServer(undefined, undefined, undefined, undefined, kelvinToMireds(4000), kelvinToMireds(maxK), kelvinToMireds(minK));
    }

    if (conn.hasEnergy) {
      endpoint.createDefaultPowerTopologyClusterServer().createDefaultElectricalPowerMeasurementClusterServer().createDefaultElectricalEnergyMeasurementClusterServer();
    }

    endpoint.addRequiredClusterServers();

    endpoint.addCommandHandler('on', async () => {
      await this.safe(conn, () => conn.setOn(true));
      await endpoint.setAttribute(OnOff.Cluster.id, 'onOff', true, this.log);
    });
    endpoint.addCommandHandler('off', async () => {
      await this.safe(conn, () => conn.setOn(false));
      await endpoint.setAttribute(OnOff.Cluster.id, 'onOff', false, this.log);
    });

    if (dimmable) {
      const onMoveToLevel = async (level: number, withOnOff: boolean): Promise<void> => {
        await this.safe(conn, () => conn.setBrightness(levelToPercent(level)));
        await endpoint.setAttribute(LevelControl.Cluster.id, 'currentLevel', level, this.log);
        if (withOnOff) await endpoint.setAttribute(OnOff.Cluster.id, 'onOff', level > 0, this.log);
      };
      endpoint.addCommandHandler('moveToLevel', (data) => onMoveToLevel((data as { request: { level: number } }).request.level, false));
      endpoint.addCommandHandler('moveToLevelWithOnOff', (data) => onMoveToLevel((data as { request: { level: number } }).request.level, true));
    }

    if (conn.category === 'colorlight') {
      endpoint.addCommandHandler('moveToColorTemperature', async (data) => {
        const mireds = (data as { request: { colorTemperatureMireds: number } }).request.colorTemperatureMireds;
        await this.safe(conn, () => conn.setColorTempKelvin(miredsToKelvin(mireds)));
        await endpoint.setAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds', mireds, this.log);
      });
    }

    await this.registerDevice(endpoint);
    this.conns.set(conn.id, conn);
    this.endpoints.set(endpoint, conn);
    this.log.info(`Registered ${conn.category} "${conn.name}" (${conn.model}) energy=${conn.hasEnergy}`);
  }

  /** Poll every registered device and push fresh state into Matter. */
  private async pollAll(): Promise<void> {
    for (const [endpoint, conn] of this.endpoints) await this.updateFromConn(endpoint, conn);
  }

  /**
   * Read a device and update its Matter attributes.
   *
   * @param {MatterbridgeEndpoint} endpoint - The Matter endpoint.
   * @param {DeviceConn} conn - The device connection.
   * @returns {Promise<void>} Resolves once attributes are updated.
   */
  private async updateFromConn(endpoint: MatterbridgeEndpoint, conn: DeviceConn): Promise<void> {
    let state;
    try {
      state = await conn.poll();
    } catch (error) {
      this.log.debug(`Poll failed for ${conn.name}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (typeof state.on === 'boolean' && endpoint.hasAttributeServer(OnOff.Cluster.id, 'onOff')) {
      await endpoint.updateAttribute(OnOff.Cluster.id, 'onOff', state.on, this.log);
    }
    if (typeof state.brightness === 'number' && endpoint.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')) {
      await endpoint.updateAttribute(LevelControl.Cluster.id, 'currentLevel', percentToLevel(state.brightness), this.log);
    }
    if (typeof state.colorTempKelvin === 'number' && endpoint.hasAttributeServer(ColorControl.Cluster.id, 'colorTemperatureMireds')) {
      await endpoint.updateAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds', kelvinToMireds(state.colorTempKelvin), this.log);
    }
    if (typeof state.powerW === 'number' && endpoint.hasAttributeServer(ElectricalPowerMeasurement.Cluster.id, 'activePower')) {
      await endpoint.updateAttribute(ElectricalPowerMeasurement.Cluster.id, 'activePower', Math.round(state.powerW * 1000), this.log);
    }
    if (typeof state.voltageV === 'number' && endpoint.hasAttributeServer(ElectricalPowerMeasurement.Cluster.id, 'voltage')) {
      await endpoint.updateAttribute(ElectricalPowerMeasurement.Cluster.id, 'voltage', Math.round(state.voltageV * 1000), this.log);
    }
    if (typeof state.energyKwh === 'number' && endpoint.hasAttributeServer(ElectricalEnergyMeasurement.Cluster.id, 'cumulativeEnergyImported')) {
      await endpoint.updateAttribute(ElectricalEnergyMeasurement.Cluster.id, 'cumulativeEnergyImported', { energy: Math.round(state.energyKwh * 1_000_000) }, this.log);
    }
  }

  /**
   * Run a backend command, logging (but not throwing) on failure.
   *
   * @param {DeviceConn} conn - The device connection.
   * @param {() => Promise<void>} fn - The command to run.
   * @returns {Promise<void>} Always resolves.
   */
  private async safe(conn: DeviceConn, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.log.error(`Command failed for ${conn.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
