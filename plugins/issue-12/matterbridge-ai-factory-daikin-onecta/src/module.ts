/**
 * matterbridge-ai-factory-daikin-onecta
 *
 * Bridges Daikin Onecta cloud air conditioners (BRP069C4x) into Matter.
 * Uses the daikin-controller-cloud library (OIDC) and exposes each climate
 * control management point as a Matter Thermostat (Heat / Cool / Auto / Off
 * via SystemMode, plus heating / cooling setpoints and current temperature).
 */

import path from 'node:path';

import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge, thermostatDevice } from 'matterbridge';
import { Thermostat } from 'matterbridge/matter/clusters';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

// daikin-controller-cloud has no ESM exports; import the class via a runtime require.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { DaikinCloudController } from 'daikin-controller-cloud';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DaikinDevice = any;

const DAIKIN_ON = 'on';
const DAIKIN_OFF = 'off';
const MODE_HEATING = 'heating';
const MODE_COOLING = 'cooling';
const MODE_AUTO = 'auto';

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): DaikinOnectaPlatform {
  return new DaikinOnectaPlatform(matterbridge, log, config);
}

interface ManagedDevice {
  device: DaikinDevice;
  endpoint: MatterbridgeEndpoint;
  managementPointId: string;
  name: string;
}

export class DaikinOnectaPlatform extends MatterbridgeDynamicPlatform {
  private controller?: DaikinCloudController;
  private managed = new Map<string, ManagedDevice>();
  private pollTimer?: NodeJS.Timeout;
  private authRetryTimer?: NodeJS.Timeout;
  private updatingFromCloud = false;
  private authorizationUrl?: string;
  private authorized = false;
  private discoveryInProgress = false;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(`This plugin requires Matterbridge >= 3.4.0. Current: ${this.matterbridge.matterbridgeVersion}`);
    }

    this.log.info('Initializing Daikin Onecta platform...');
  }

  override async onStart(reason?: string) {
    this.log.info(`onStart (${reason ?? 'none'})`);
    await this.ready;
    await this.clearSelect();

    const clientId = this.config.oidcClientId as string | undefined;
    const clientSecret = this.config.oidcClientSecret as string | undefined;
    const externalAddress = this.config.oidcCallbackServerExternalAddress as string | undefined;
    const port = (this.config.oidcCallbackServerPort as number | undefined) ?? 8765;

    if (!clientId || !clientSecret || !externalAddress) {
      this.log.error(
        'Missing Daikin Onecta credentials. Configure oidcClientId, oidcClientSecret and oidcCallbackServerExternalAddress in the plugin config.',
      );
      this.log.error(
        `Register a Developer App at https://developer.cloud.daikineurope.com and set its Redirect URI to: https://${externalAddress ?? '<address>'}:${port}/daikin-oauth-callback`,
      );
      return;
    }

    const tokenSetFilePath = path.join(this.matterbridge.matterbridgePluginDirectory ?? process.cwd(), 'matterbridge-ai-factory-daikin-onecta.tokenset.json');

    this.controller = new DaikinCloudController({
      oidcClientId: clientId,
      oidcClientSecret: clientSecret,
      oidcCallbackServerExternalAddress: externalAddress,
      oidcCallbackServerPort: port,
      oidcCallbackServerBindAddr: '0.0.0.0',
      // Long timeout (30 min) so the user has time to open the URL and approve.
      oidcAuthorizationTimeoutS: 1800,
      oidcTokenSetFilePath: tokenSetFilePath,
    });

    this.controller.on('authorization_request', (url: string) => {
      this.authorizationUrl = url;
      this.logAuthorizationInstructions(externalAddress, port);
    });
    this.controller.on('token_update', () => {
      this.authorized = true;
      this.log.notice('Daikin Onecta authorization succeeded; token stored.');
    });
    this.controller.on('error', (err: Error) => {
      this.log.error(`Daikin controller error: ${err.message}`);
    });
    this.controller.on('rate_limit_status', (status) => {
      this.log.debug(`Daikin rate-limit: minute=${status.remainingMinute}/${status.limitMinute} day=${status.remainingDay}/${status.limitDay}`);
    });

    // Kick off discovery in the background so plugin startup is not blocked by
    // the OIDC authorization round-trip. The user must visit the authorization
    // URL printed in the logs to complete authorization the first time.
    void this.discoverDevicesWithRetry();
  }

  /**
   * Print authorization URL and instructions prominently in the log. Called
   * every time the controller emits 'authorization_request' and on each retry
   * so the URL is easy to find.
   */
  private logAuthorizationInstructions(externalAddress: string, port: number) {
    if (!this.authorizationUrl) return;
    this.log.notice('==================================================================');
    this.log.notice('Daikin Onecta authorization required.');
    this.log.notice('Open this URL in your browser to authorize the plugin:');
    this.log.notice(this.authorizationUrl);
    this.log.notice(`After approval Daikin will redirect to https://${externalAddress}:${port}/daikin-oauth-callback`);
    this.log.notice('The redirect server uses a self-signed certificate; accept the browser warning.');
    this.log.notice('Authorization stays valid until you revoke it; the token is cached on disk.');
    this.log.notice('==================================================================');
  }

  /**
   * Try to discover Daikin devices. If authorization is not yet complete this
   * blocks on getCloudDevices() until either the user completes the OIDC flow
   * or the configured timeout fires. On timeout/error, schedule a retry so the
   * URL is re-printed and the auth flow can be completed later.
   */
  private async discoverDevicesWithRetry(): Promise<void> {
    if (!this.controller || this.discoveryInProgress) return;
    this.discoveryInProgress = true;
    try {
      const devices: DaikinDevice[] = await this.controller.getCloudDevices();
      this.authorized = true;
      this.log.info(`Discovered ${devices.length} Daikin device(s)`);
      for (const device of devices) {
        try {
          await this.registerDaikinDevice(device);
        } catch (err) {
          this.log.error(`Failed to register Daikin device: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      this.log.error(`Failed to fetch Daikin devices: ${msg}`);
      if (/timeout|timed? out/i.test(msg) || !this.authorized) {
        const retryS = 60;
        this.log.notice(`Will retry Daikin authorization in ${retryS}s. Complete the authorization URL above to finish the flow.`);
        this.authRetryTimer = setTimeout(() => {
          this.authRetryTimer = undefined;
          // Re-print the URL on each retry so it stays visible in the log.
          if (this.authorizationUrl) {
            const ext = this.config.oidcCallbackServerExternalAddress as string;
            const p = (this.config.oidcCallbackServerPort as number | undefined) ?? 8765;
            this.logAuthorizationInstructions(ext, p);
          }
          void this.discoverDevicesWithRetry();
        }, retryS * 1000);
      }
    } finally {
      this.discoveryInProgress = false;
    }
  }

  override async onConfigure() {
    await super.onConfigure();
    this.log.info('onConfigure');

    for (const md of this.managed.values()) {
      await this.pushDeviceStateToMatter(md);
    }

    const intervalMinutes = (this.config.pollIntervalMinutes as number | undefined) ?? 15;
    const intervalMs = Math.max(5, intervalMinutes) * 60 * 1000;
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, intervalMs);
    this.log.info(`Polling Daikin cloud every ${intervalMinutes} minute(s)`);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel) {
    this.log.info(`onChangeLoggerLevel: ${logLevel}`);
  }

  override async onShutdown(reason?: string) {
    await super.onShutdown(reason);
    this.log.info(`onShutdown (${reason ?? 'none'})`);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.authRetryTimer) {
      clearTimeout(this.authRetryTimer);
      this.authRetryTimer = undefined;
    }
    this.managed.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  private async pollAll() {
    if (!this.controller) return;
    if (!this.authorized) {
      // Authorization not complete yet; nothing to poll.
      return;
    }
    if (this.managed.size === 0) {
      // Authorized but no devices registered yet (e.g. discovery succeeded
      // after onConfigure). Try discovery again.
      void this.discoverDevicesWithRetry();
      return;
    }
    try {
      await this.controller.updateAllDeviceData();
      for (const md of this.managed.values()) {
        await this.pushDeviceStateToMatter(md);
      }
    } catch (err) {
      this.log.error(`Poll failed: ${(err as Error).message}`);
    }
  }

  private async registerDaikinDevice(device: DaikinDevice) {
    const id: string = device.getId();
    const desc = device.getDescription();
    const mps: Array<{ embeddedId: string }> = desc.managementPoints ?? [];
    const climateMp = mps.find((m) => m.embeddedId === 'climateControl');
    if (!climateMp) {
      this.log.info(`Skipping device ${id}: no climateControl management point`);
      return;
    }
    const mpId = climateMp.embeddedId;

    const nameDp = device.getData(mpId, 'name', undefined);
    const modelDp = device.getData(mpId, 'modelInfo', undefined);
    const name: string = (nameDp && nameDp.value) || `Daikin ${id.slice(0, 6)}`;
    const model: string = (modelDp && modelDp.value) || 'Daikin Onecta';
    const serial = id.slice(0, 30);

    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) {
      this.log.info(`Device ${name} (${serial}) filtered out by white/black list`);
      return;
    }

    // Determine setpoint ranges from device for room temperature in cooling/heating modes.
    const coolSp = device.getData(mpId, 'temperatureControl', `/operationModes/${MODE_COOLING}/setpoints/roomTemperature`);
    const heatSp = device.getData(mpId, 'temperatureControl', `/operationModes/${MODE_HEATING}/setpoints/roomTemperature`);
    const minHeat = (heatSp && typeof heatSp.minValue === 'number') ? heatSp.minValue : 10;
    const maxHeat = (heatSp && typeof heatSp.maxValue === 'number') ? heatSp.maxValue : 30;
    const minCool = (coolSp && typeof coolSp.minValue === 'number') ? coolSp.minValue : 16;
    const maxCool = (coolSp && typeof coolSp.maxValue === 'number') ? coolSp.maxValue : 32;
    const initialHeatSp = (heatSp && typeof heatSp.value === 'number') ? heatSp.value : 21;
    const initialCoolSp = (coolSp && typeof coolSp.value === 'number') ? coolSp.value : 25;

    const sensorRoom = device.getData(mpId, 'sensoryData', '/roomTemperature');
    const initialLocal = (sensorRoom && typeof sensorRoom.value === 'number') ? sensorRoom.value : 22;

    const endpoint = new MatterbridgeEndpoint(thermostatDevice, { id: serial.replace(/[^A-Za-z0-9]/g, '') })
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, 0xfff1, 'Daikin', model)
      .createDefaultThermostatClusterServer(initialLocal, initialHeatSp, initialCoolSp, 1, minHeat, maxHeat, minCool, maxCool)
      .addRequiredClusterServers();

    const md: ManagedDevice = { device, endpoint, managementPointId: mpId, name };

    // Subscribe to systemMode (Off / Heat / Cool / Auto)
    await endpoint.subscribeAttribute(
      Thermostat.Cluster.id,
      'systemMode',
      (newValue: number) => {
        if (this.updatingFromCloud) return;
        void this.handleSystemModeChange(md, newValue);
      },
      this.log,
    );

    await endpoint.subscribeAttribute(
      Thermostat.Cluster.id,
      'occupiedHeatingSetpoint',
      (newValue: number) => {
        if (this.updatingFromCloud) return;
        void this.handleSetpointChange(md, MODE_HEATING, newValue / 100);
      },
      this.log,
    );

    await endpoint.subscribeAttribute(
      Thermostat.Cluster.id,
      'occupiedCoolingSetpoint',
      (newValue: number) => {
        if (this.updatingFromCloud) return;
        void this.handleSetpointChange(md, MODE_COOLING, newValue / 100);
      },
      this.log,
    );

    device.on('updated', () => {
      void this.pushDeviceStateToMatter(md);
    });

    await this.registerDevice(endpoint);
    this.managed.set(serial, md);
    this.log.info(`Registered Daikin device "${name}" (${serial})`);
  }

  private async pushDeviceStateToMatter(md: ManagedDevice) {
    const { device, endpoint, managementPointId: mpId } = md;
    try {
      this.updatingFromCloud = true;

      const onOff = device.getData(mpId, 'onOffMode', undefined);
      const opMode = device.getData(mpId, 'operationMode', undefined);
      const sensor = device.getData(mpId, 'sensoryData', '/roomTemperature');
      const heatSp = device.getData(mpId, 'temperatureControl', `/operationModes/${MODE_HEATING}/setpoints/roomTemperature`);
      const coolSp = device.getData(mpId, 'temperatureControl', `/operationModes/${MODE_COOLING}/setpoints/roomTemperature`);

      let systemMode = Thermostat.SystemMode.Off;
      if (onOff && onOff.value === DAIKIN_ON) {
        switch (opMode?.value) {
          case MODE_HEATING:
            systemMode = Thermostat.SystemMode.Heat;
            break;
          case MODE_COOLING:
            systemMode = Thermostat.SystemMode.Cool;
            break;
          case MODE_AUTO:
            systemMode = Thermostat.SystemMode.Auto;
            break;
          default:
            systemMode = Thermostat.SystemMode.Auto;
        }
      }
      await endpoint.updateAttribute(Thermostat.Cluster.id, 'systemMode', systemMode, this.log);

      if (sensor && typeof sensor.value === 'number') {
        await endpoint.updateAttribute(Thermostat.Cluster.id, 'localTemperature', Math.round(sensor.value * 100), this.log);
      }
      if (heatSp && typeof heatSp.value === 'number') {
        await endpoint.updateAttribute(Thermostat.Cluster.id, 'occupiedHeatingSetpoint', Math.round(heatSp.value * 100), this.log);
      }
      if (coolSp && typeof coolSp.value === 'number') {
        await endpoint.updateAttribute(Thermostat.Cluster.id, 'occupiedCoolingSetpoint', Math.round(coolSp.value * 100), this.log);
      }
    } catch (err) {
      this.log.error(`Failed to update Matter state for ${md.name}: ${(err as Error).message}`);
    } finally {
      this.updatingFromCloud = false;
    }
  }

  private async handleSystemModeChange(md: ManagedDevice, newValue: number) {
    const { device, managementPointId: mpId } = md;
    this.log.info(`[${md.name}] SET systemMode=${newValue}`);
    try {
      if (newValue === Thermostat.SystemMode.Off) {
        await device.setData(mpId, 'onOffMode', undefined, DAIKIN_OFF);
        return;
      }
      let daikinMode = MODE_AUTO;
      if (newValue === Thermostat.SystemMode.Heat) daikinMode = MODE_HEATING;
      else if (newValue === Thermostat.SystemMode.Cool) daikinMode = MODE_COOLING;
      else if (newValue === Thermostat.SystemMode.Auto) daikinMode = MODE_AUTO;

      await device.setData(mpId, 'operationMode', undefined, daikinMode);
      await device.setData(mpId, 'onOffMode', undefined, DAIKIN_ON);
    } catch (err) {
      this.log.error(`[${md.name}] systemMode set failed: ${(err as Error).message}`);
    }
  }

  private async handleSetpointChange(md: ManagedDevice, mode: string, valueC: number) {
    const { device, managementPointId: mpId } = md;
    const rounded = Math.round(valueC * 2) / 2;
    this.log.info(`[${md.name}] SET ${mode} setpoint=${rounded}°C`);
    try {
      await device.setData(mpId, 'temperatureControl', `/operationModes/${mode}/setpoints/roomTemperature`, rounded);
    } catch (err) {
      this.log.error(`[${md.name}] setpoint set failed: ${(err as Error).message}`);
    }
  }
}
