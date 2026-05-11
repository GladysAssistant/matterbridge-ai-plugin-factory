/**
 * matterbridge-ai-factory-daikin-onecta
 *
 * Bridges Daikin Onecta cloud air conditioners (BRP069C4x) into Matter as
 * airConditioner endpoints with: OnOff, Thermostat (heat/cool/auto/dry/fanOnly
 * via SystemMode plus heating / cooling setpoints and current room
 * temperature), FanControl (fan speed + optional swing/rocking), and optional
 * child OnOff switches for vendor-specific feature toggles (powerful, econo,
 * streamer, outdoor silent, indoor quiet).
 */

import path from 'node:path';

import {
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformConfig,
  PlatformMatterbridge,
  airConditioner,
  onOffSwitch,
  powerSource,
} from 'matterbridge';
import { FanControl, OnOff, Thermostat } from 'matterbridge/matter/clusters';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { DaikinCloudController } from 'daikin-controller-cloud';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DaikinDevice = any;

const DAIKIN_ON = 'on';
const DAIKIN_OFF = 'off';
const MODE_HEATING = 'heating';
const MODE_COOLING = 'cooling';
const MODE_AUTO = 'auto';
const MODE_DRY = 'dry';
const MODE_FAN_ONLY = 'fanOnly';

interface ExtraModeDef {
  /** Config flag name in PlatformConfig. */
  flag: string;
  /** Daikin onecta data point used by setData / getData. */
  dp: string;
  /** Optional sub-path passed to getData/setData (some toggles use a path like '/silentMode'). */
  subPath?: string;
  /** Short human label for the child endpoint name. */
  label: string;
  /** Endpoint id suffix. */
  idSuffix: string;
}

const EXTRA_MODES: ExtraModeDef[] = [
  { flag: 'showPowerfulMode', dp: 'powerfulMode', label: 'Powerful', idSuffix: 'Powerful' },
  { flag: 'showEconoMode', dp: 'econoMode', label: 'Econo', idSuffix: 'Econo' },
  { flag: 'showStreamerMode', dp: 'streamerMode', label: 'Streamer', idSuffix: 'Streamer' },
  { flag: 'showOutdoorSilentMode', dp: 'outdoorSilentMode', label: 'Outdoor Silent', idSuffix: 'OutdoorSilent' },
  // Virtual mode toggles: ON switches operationMode to dry/fanOnly (and powers the unit on),
  // OFF powers the unit off. Marked with operationMode so handlers know to special-case them.
  { flag: 'showDryMode', dp: 'operationMode', subPath: undefined, label: 'Dry Mode', idSuffix: 'DryMode' },
  { flag: 'showFanOnlyMode', dp: 'operationMode', subPath: undefined, label: 'Fan Only', idSuffix: 'FanOnly' },
];

/** Map an ExtraModeDef idSuffix to the Daikin operationMode value it represents. */
const OPERATION_MODE_BY_SUFFIX: Record<string, string> = {
  DryMode: MODE_DRY,
  FanOnly: MODE_FAN_ONLY,
};

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): DaikinOnectaPlatform {
  return new DaikinOnectaPlatform(matterbridge, log, config);
}

interface ManagedDevice {
  device: DaikinDevice;
  endpoint: MatterbridgeEndpoint;
  managementPointId: string;
  name: string;
  extraEndpoints: Map<string, { endpoint: MatterbridgeEndpoint; def: ExtraModeDef }>;
  hasSwing: boolean;
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

    const tokenSetFilePath = path.join(
      this.matterbridge.matterbridgePluginDirectory ?? process.cwd(),
      'matterbridge-ai-factory-daikin-onecta.tokenset.json',
    );

    this.controller = new DaikinCloudController({
      oidcClientId: clientId,
      oidcClientSecret: clientSecret,
      oidcCallbackServerExternalAddress: externalAddress,
      oidcCallbackServerPort: port,
      oidcCallbackServerBindAddr: '0.0.0.0',
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

    await this.discoverDevicesWithRetry();
  }

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
      await this.subscribeDeviceAttributes(md);
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
    if (!this.authorized) return;
    if (this.managed.size === 0) {
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

    if (this.managed.has(serial)) {
      this.log.info(`Skipping device ${name} (${serial}): already registered`);
      return;
    }

    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) {
      this.log.info(`Device ${name} (${serial}) filtered out by white/black list`);
      return;
    }

    const coolSp = device.getData(mpId, 'temperatureControl', `/operationModes/${MODE_COOLING}/setpoints/roomTemperature`);
    const heatSp = device.getData(mpId, 'temperatureControl', `/operationModes/${MODE_HEATING}/setpoints/roomTemperature`);
    const minHeat = heatSp && typeof heatSp.minValue === 'number' ? heatSp.minValue : 10;
    const maxHeat = heatSp && typeof heatSp.maxValue === 'number' ? heatSp.maxValue : 30;
    const minCool = coolSp && typeof coolSp.minValue === 'number' ? coolSp.minValue : 16;
    const maxCool = coolSp && typeof coolSp.maxValue === 'number' ? coolSp.maxValue : 32;
    const initialHeatSp = heatSp && typeof heatSp.value === 'number' ? heatSp.value : 21;
    const initialCoolSp = coolSp && typeof coolSp.value === 'number' ? coolSp.value : 25;

    const sensorRoom = device.getData(mpId, 'sensoryData', '/roomTemperature');
    const initialLocal = sensorRoom && typeof sensorRoom.value === 'number' ? sensorRoom.value : 22;

    // Detect swing support: Daikin uses fanControl/operationModes/<mode>/fanDirection
    // (horizontal/vertical) on supporting units. Probe heating first then cooling.
    const swingHeat = device.getData(mpId, 'fanControl', `/operationModes/${MODE_HEATING}/fanDirection/vertical/currentMode`);
    const swingCool = device.getData(mpId, 'fanControl', `/operationModes/${MODE_COOLING}/fanDirection/vertical/currentMode`);
    const swingHorizHeat = device.getData(mpId, 'fanControl', `/operationModes/${MODE_HEATING}/fanDirection/horizontal/currentMode`);
    const hasVerticalSwing = !!(swingHeat || swingCool);
    const hasHorizontalSwing = !!swingHorizHeat;
    const hasSwing = hasVerticalSwing || hasHorizontalSwing;

    const endpoint = new MatterbridgeEndpoint([airConditioner, powerSource], { id: serial.replace(/[^A-Za-z0-9]/g, '') })
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, 0xfff1, 'Daikin', model)
      .createDefaultPowerSourceWiredClusterServer()
      .createDeadFrontOnOffClusterServer(false)
      .createDefaultThermostatClusterServer(initialLocal, initialHeatSp, initialCoolSp, 1, minHeat, maxHeat, minCool, maxCool)
      .createDefaultThermostatUserInterfaceConfigurationClusterServer();

    if (hasSwing) {
      endpoint.createCompleteFanControlClusterServer(
        FanControl.FanMode.Off,
        FanControl.FanModeSequence.OffLowMedHighAuto,
        0,
        0,
        10,
        0,
        0,
        { rockLeftRight: hasHorizontalSwing, rockUpDown: hasVerticalSwing, rockRound: false },
        { rockLeftRight: false, rockUpDown: false, rockRound: false },
      );
    } else {
      endpoint.createDefaultFanControlClusterServer(FanControl.FanMode.Off, FanControl.FanModeSequence.OffLowMedHighAuto, 0, 0);
    }

    endpoint.addRequiredClusterServers();

    const md: ManagedDevice = {
      device,
      endpoint,
      managementPointId: mpId,
      name,
      extraEndpoints: new Map(),
      hasSwing,
    };

    device.on('updated', () => {
      void this.pushDeviceStateToMatter(md);
    });

    await this.registerDevice(endpoint);
    this.managed.set(serial, md);

    // Optional separate OnOff switch devices for vendor-specific mode toggles.
    // Each enabled extra mode becomes its own bridged device named "<AC name> <label>".
    for (const mode of EXTRA_MODES) {
      if (!this.config[mode.flag]) continue;
      const virtualOp = OPERATION_MODE_BY_SUFFIX[mode.idSuffix];
      let initialOn = false;
      if (virtualOp) {
        // Virtual operationMode toggle: ON iff unit is on AND in this op mode.
        const opModeDp = device.getData(mpId, 'operationMode', undefined);
        const onOffDp = device.getData(mpId, 'onOffMode', undefined);
        if (!opModeDp) {
          this.log.debug(`[${name}] ${mode.label}: operationMode not exposed by device`);
          continue;
        }
        initialOn = onOffDp?.value === DAIKIN_ON && opModeDp?.value === virtualOp;
      } else {
        const probe = device.getData(mpId, mode.dp, mode.subPath);
        if (!probe) {
          this.log.debug(`[${name}] ${mode.label}: data point '${mode.dp}' not exposed by device`);
          continue;
        }
        initialOn = probe.value === DAIKIN_ON;
      }
      const childSerial = `${serial}-${mode.idSuffix}`.slice(0, 30);
      const childName = `${name} ${mode.label}`;
      const childId = `${serial.replace(/[^A-Za-z0-9]/g, '')}${mode.idSuffix}`;
      const childEndpoint = new MatterbridgeEndpoint([onOffSwitch, powerSource], { id: childId })
        .createDefaultIdentifyClusterServer()
        .createDefaultGroupsClusterServer()
        .createDefaultBridgedDeviceBasicInformationClusterServer(childName, childSerial, 0xfff1, 'Daikin', `${model} ${mode.label}`)
        .createDefaultPowerSourceWiredClusterServer()
        .createDefaultOnOffClusterServer(initialOn)
        .addRequiredClusterServers();
      // Key by idSuffix so dry/fanOnly entries (both dp='operationMode') don't collide.
      md.extraEndpoints.set(mode.idSuffix, { endpoint: childEndpoint, def: mode });
      await this.registerDevice(childEndpoint);
      this.log.info(`Registered Daikin extra-mode device "${childName}" (${childSerial})`);
    }
    this.log.info(`Registered Daikin device "${name}" (${serial})${hasSwing ? ' [swing]' : ''}${md.extraEndpoints.size ? ` +${md.extraEndpoints.size} mode switches` : ''}`);
  }

  private async subscribeDeviceAttributes(md: ManagedDevice) {
    const { endpoint } = md;

    // OnOff (DeadFront) command handlers.
    endpoint.addCommandHandler('on', async () => {
      if (this.updatingFromCloud) return;
      await this.handleOnOff(md, true);
    });
    endpoint.addCommandHandler('off', async () => {
      if (this.updatingFromCloud) return;
      await this.handleOnOff(md, false);
    });
    endpoint.addCommandHandler('toggle', async () => {
      if (this.updatingFromCloud) return;
      const current = endpoint.getAttribute(OnOff.Cluster.id, 'onOff', this.log);
      await this.handleOnOff(md, !current);
    });

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

    await endpoint.subscribeAttribute(
      FanControl.Cluster.id,
      'fanMode',
      (newValue: number) => {
        if (this.updatingFromCloud) return;
        void this.handleFanModeChange(md, newValue);
      },
      this.log,
    );

    if (md.hasSwing) {
      await endpoint.subscribeAttribute(
        FanControl.Cluster.id,
        'rockSetting',
        (newValue: { rockLeftRight: boolean; rockUpDown: boolean; rockRound: boolean }) => {
          if (this.updatingFromCloud) return;
          void this.handleSwingChange(md, newValue);
        },
        this.log,
      );
    }

    // Subscribe child OnOff for extra mode switches.
    for (const [, child] of md.extraEndpoints) {
      child.endpoint.addCommandHandler('on', async () => {
        if (this.updatingFromCloud) return;
        await this.handleExtraModeChange(md, child.def, true);
      });
      child.endpoint.addCommandHandler('off', async () => {
        if (this.updatingFromCloud) return;
        await this.handleExtraModeChange(md, child.def, false);
      });
      child.endpoint.addCommandHandler('toggle', async () => {
        if (this.updatingFromCloud) return;
        const current = child.endpoint.getAttribute(OnOff.Cluster.id, 'onOff', this.log);
        await this.handleExtraModeChange(md, child.def, !current);
      });
    }
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
      const isOn = onOff?.value === DAIKIN_ON;

      // OnOff cluster (DeadFront): true = on, false = off.
      await endpoint.updateAttribute(OnOff.Cluster.id, 'onOff', isOn, this.log);

      // Thermostat system mode.
      let systemMode = Thermostat.SystemMode.Off;
      if (isOn) {
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
          case MODE_DRY:
            systemMode = Thermostat.SystemMode.Dry;
            break;
          case MODE_FAN_ONLY:
            systemMode = Thermostat.SystemMode.FanOnly;
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

      // Fan speed: Daikin stores per-mode fan speed under fanControl. Try to
      // read the current mode's fan speed; fall back to heating then cooling.
      const fanModeDaikin = this.readDaikinFanLevel(device, mpId, (opMode?.value as string | undefined) ?? MODE_AUTO);
      const fanMode = this.mapDaikinFanToMatter(fanModeDaikin, isOn);
      await endpoint.updateAttribute(FanControl.Cluster.id, 'fanMode', fanMode, this.log);

      // Swing/rock setting.
      if (md.hasSwing) {
        const swingV = this.readDaikinSwing(device, mpId, (opMode?.value as string | undefined) ?? MODE_COOLING, 'vertical');
        const swingH = this.readDaikinSwing(device, mpId, (opMode?.value as string | undefined) ?? MODE_COOLING, 'horizontal');
        await endpoint.updateAttribute(
          FanControl.Cluster.id,
          'rockSetting',
          { rockUpDown: swingV, rockLeftRight: swingH, rockRound: false },
          this.log,
        );
      }

      // Extra mode switches.
      for (const [, child] of md.extraEndpoints) {
        const virtualOp = OPERATION_MODE_BY_SUFFIX[child.def.idSuffix];
        if (virtualOp) {
          const childOn = isOn && opMode?.value === virtualOp;
          await child.endpoint.updateAttribute(OnOff.Cluster.id, 'onOff', childOn, this.log);
        } else {
          const dp = device.getData(mpId, child.def.dp, child.def.subPath);
          if (dp) {
            await child.endpoint.updateAttribute(OnOff.Cluster.id, 'onOff', dp.value === DAIKIN_ON, this.log);
          }
        }
      }
    } catch (err) {
      this.log.error(`Failed to update Matter state for ${md.name}: ${(err as Error).message}`);
    } finally {
      this.updatingFromCloud = false;
    }
  }

  private readDaikinFanLevel(device: DaikinDevice, mpId: string, mode: string): string | undefined {
    // First try the active operation mode, then the common modes.
    const candidates = [mode, MODE_COOLING, MODE_HEATING, MODE_AUTO];
    for (const m of candidates) {
      const dp = device.getData(mpId, 'fanControl', `/operationModes/${m}/fanSpeed/currentMode`);
      if (dp && typeof dp.value === 'string') return dp.value;
    }
    return undefined;
  }

  private readDaikinSwing(device: DaikinDevice, mpId: string, mode: string, axis: 'vertical' | 'horizontal'): boolean {
    const dp = device.getData(mpId, 'fanControl', `/operationModes/${mode}/fanDirection/${axis}/currentMode`);
    if (!dp || typeof dp.value !== 'string') return false;
    return dp.value === 'swing' || dp.value === 'windNice';
  }

  private mapDaikinFanToMatter(level: string | undefined, isOn: boolean): FanControl.FanMode {
    if (!isOn) return FanControl.FanMode.Off;
    if (!level) return FanControl.FanMode.Auto;
    if (level === 'auto') return FanControl.FanMode.Auto;
    if (level === 'quiet') return FanControl.FanMode.Low;
    // Daikin fixed speeds are 'fixed' with a numeric setting in /fixed/currentMode.
    // Without that secondary read, treat 'fixed' as Medium and let user adjust.
    if (level === 'fixed') return FanControl.FanMode.Medium;
    if (level === 'low') return FanControl.FanMode.Low;
    if (level === 'medium') return FanControl.FanMode.Medium;
    if (level === 'high') return FanControl.FanMode.High;
    return FanControl.FanMode.Auto;
  }

  private mapMatterFanToDaikin(fanMode: number): string {
    switch (fanMode) {
      case FanControl.FanMode.Low:
        return 'quiet';
      case FanControl.FanMode.Medium:
        return 'fixed';
      case FanControl.FanMode.High:
        return 'fixed';
      case FanControl.FanMode.Auto:
      default:
        return 'auto';
    }
  }

  private async handleOnOff(md: ManagedDevice, on: boolean) {
    const { device, managementPointId: mpId } = md;
    this.log.info(`[${md.name}] SET onOff=${on}`);
    try {
      await device.setData(mpId, 'onOffMode', undefined, on ? DAIKIN_ON : DAIKIN_OFF);
    } catch (err) {
      this.log.error(`[${md.name}] onOff set failed: ${(err as Error).message}`);
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
      let daikinMode: string = MODE_AUTO;
      if (newValue === Thermostat.SystemMode.Heat) daikinMode = MODE_HEATING;
      else if (newValue === Thermostat.SystemMode.Cool) daikinMode = MODE_COOLING;
      else if (newValue === Thermostat.SystemMode.Auto) daikinMode = MODE_AUTO;
      else if (newValue === Thermostat.SystemMode.Dry) daikinMode = MODE_DRY;
      else if (newValue === Thermostat.SystemMode.FanOnly) daikinMode = MODE_FAN_ONLY;

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

  private async handleFanModeChange(md: ManagedDevice, fanMode: number) {
    const { device, managementPointId: mpId } = md;
    const daikinLevel = this.mapMatterFanToDaikin(fanMode);
    this.log.info(`[${md.name}] SET fanMode=${fanMode} -> daikin=${daikinLevel}`);
    try {
      // Apply to the currently-active operation mode; fall back to cooling.
      const opModeDp = device.getData(mpId, 'operationMode', undefined);
      const mode = (opModeDp?.value as string | undefined) ?? MODE_COOLING;
      await device.setData(mpId, 'fanControl', `/operationModes/${mode}/fanSpeed/currentMode`, daikinLevel);
    } catch (err) {
      this.log.error(`[${md.name}] fanMode set failed: ${(err as Error).message}`);
    }
  }

  private async handleSwingChange(md: ManagedDevice, rock: { rockLeftRight: boolean; rockUpDown: boolean; rockRound: boolean }) {
    const { device, managementPointId: mpId } = md;
    this.log.info(`[${md.name}] SET swing v=${rock.rockUpDown} h=${rock.rockLeftRight}`);
    try {
      const opModeDp = device.getData(mpId, 'operationMode', undefined);
      const mode = (opModeDp?.value as string | undefined) ?? MODE_COOLING;
      await device.setData(mpId, 'fanControl', `/operationModes/${mode}/fanDirection/vertical/currentMode`, rock.rockUpDown ? 'swing' : 'stop');
      await device.setData(
        mpId,
        'fanControl',
        `/operationModes/${mode}/fanDirection/horizontal/currentMode`,
        rock.rockLeftRight ? 'swing' : 'stop',
      );
    } catch (err) {
      this.log.error(`[${md.name}] swing set failed: ${(err as Error).message}`);
    }
  }

  private async handleExtraModeChange(md: ManagedDevice, def: ExtraModeDef, on: boolean) {
    const { device, managementPointId: mpId } = md;
    this.log.info(`[${md.name}] SET ${def.label}=${on}`);
    try {
      const virtualOp = OPERATION_MODE_BY_SUFFIX[def.idSuffix];
      if (virtualOp) {
        if (on) {
          await device.setData(mpId, 'operationMode', undefined, virtualOp);
          await device.setData(mpId, 'onOffMode', undefined, DAIKIN_ON);
        } else {
          await device.setData(mpId, 'onOffMode', undefined, DAIKIN_OFF);
        }
        return;
      }
      await device.setData(mpId, def.dp, def.subPath, on ? DAIKIN_ON : DAIKIN_OFF);
    } catch (err) {
      this.log.error(`[${md.name}] ${def.label} set failed: ${(err as Error).message}`);
    }
  }
}
