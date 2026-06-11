/**
 * Matterbridge plugin for iRobot Roomba / Braava robot vacuums and mops.
 *
 * Exposes each robot as a Matter Robotic Vacuum Cleaner (RVC) device with
 * Start / Stop / Pause, Dock, Locate, status, battery level and bin-full
 * reporting. Communication is done locally over MQTT/TLS (port 8883) using
 * dorita980. Local credentials (BLID + password) can be provided directly
 * (local-only mode) or fetched from the iRobot cloud (cloud-assisted mode).
 *
 * @file module.ts
 * @author Matterbridge AI Factory
 * @license Apache-2.0
 */

import dorita980, { RobotLocal, RobotState } from 'dorita980';
import { BasePlatformConfig, MatterbridgeDynamicPlatform, PlatformMatterbridge } from 'matterbridge';
import { RoboticVacuumCleaner } from 'matterbridge/devices';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { PowerSource, RvcOperationalState, RvcRunMode } from 'matterbridge/matter/clusters';

import { getCloudCredentials } from './cloud.js';

/** Configuration for a single robot. */
export interface RoombaDeviceConfig {
  /** Friendly name shown in Matter. */
  name: string;
  /** LAN IP address of the robot. */
  ipAddress: string;
  /** Robot BLID (local MQTT username). Optional when using cloud mode. */
  blid?: string;
  /** Local MQTT password. Optional when using cloud mode. */
  password?: string;
  /** Expose the robot as an independent (server mode) Matter device for Siri/Apple Home. */
  serverMode?: boolean;
}

/** Plugin configuration. */
export type RoombaPlatformConfig = BasePlatformConfig & {
  cloud?: { email?: string; password?: string; countryCode?: string };
  devices?: RoombaDeviceConfig[];
  pollInterval?: number;
  whiteList?: string[];
  blackList?: string[];
};

/** Runtime binding between a Matter endpoint and a dorita980 local client. */
interface RoombaRuntime {
  config: RoombaDeviceConfig;
  endpoint: RoboticVacuumCleaner;
  robot?: RobotLocal;
  reconnectTimer?: NodeJS.Timeout;
}

/**
 * Plugin entry point. Matterbridge calls this to create the platform.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The plugin logger.
 * @param {RoombaPlatformConfig} config - The plugin configuration.
 * @returns {RoombaPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: RoombaPlatformConfig): RoombaPlatform {
  return new RoombaPlatform(matterbridge, log, config);
}

/** Robotic Vacuum Cleaner platform for iRobot Roomba / Braava robots. */
export class RoombaPlatform extends MatterbridgeDynamicPlatform {
  private readonly runtimes = new Map<string, RoombaRuntime>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: RoombaPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`);
    }

    this.log.info('Initializing iRobot Roomba / Braava platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const config = this.config as RoombaPlatformConfig;
    const devices = await this.resolveDevices(config);
    if (devices.length === 0) {
      this.log.warn('No robots configured. Add at least one device with ipAddress and (blid + password) or configure cloud credentials.');
      return;
    }

    for (const device of devices) {
      await this.addRobot(device);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    for (const runtime of this.runtimes.values()) {
      if (runtime.robot) {
        try {
          const state = await runtime.robot.getRobotState(['batPct', 'bin', 'cleanMissionStatus']);
          await this.applyState(runtime, state);
        } catch (error) {
          this.log.debug(`Could not read initial state for ${runtime.config.name}: ${(error as Error).message}`);
        }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    for (const runtime of this.runtimes.values()) {
      if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
      this.disconnectRobot(runtime);
    }
    this.runtimes.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /** Merge configured devices with credentials discovered from the iRobot cloud. */
  private async resolveDevices(config: RoombaPlatformConfig): Promise<RoombaDeviceConfig[]> {
    const devices = (config.devices ?? []).filter((d) => d && d.name && d.ipAddress);

    const email = config.cloud?.email;
    const password = config.cloud?.password;
    if (email && password) {
      try {
        const credentials = await getCloudCredentials(email, password, config.cloud?.countryCode ?? 'US', this.log);
        for (const device of devices) {
          if (device.blid && device.password) continue;
          const match = credentials.find((c) => c.name.toLowerCase() === device.name.toLowerCase()) ?? (credentials.length === 1 ? credentials[0] : undefined);
          if (match) {
            device.blid = device.blid ?? match.blid;
            device.password = device.password ?? match.password;
            this.log.info(`Resolved local credentials for "${device.name}" from the iRobot cloud`);
          }
        }
      } catch (error) {
        this.log.error(`Failed to fetch cloud credentials: ${(error as Error).message}`);
      }
    }

    return devices.filter((device) => {
      if (!device.blid || !device.password) {
        this.log.warn(`Skipping "${device.name}": missing blid/password. Provide them or configure cloud credentials.`);
        return false;
      }
      return this.validateDevice([device.name, device.blid]);
    });
  }

  /** Create the Matter endpoint for a robot and connect to it locally. */
  private async addRobot(device: RoombaDeviceConfig): Promise<void> {
    this.setSelectDevice(device.blid as string, device.name);

    const endpoint = new RoboticVacuumCleaner(device.name, device.blid as string, device.serverMode ? 'server' : undefined);
    endpoint
      .createDefaultBooleanStateClusterServer(false) // false = bin full / fault present
      .addCommandHandler('identify', () => {
        this.log.info(`Locate (beep) requested for ${device.name}`);
        void this.safeCommand(device, (robot) => robot.find());
      })
      .addCommandHandler('RvcOperationalState.pause', () => {
        this.log.info(`Pause requested for ${device.name}`);
        void this.safeCommand(device, (robot) => robot.pause());
      })
      .addCommandHandler('RvcOperationalState.resume', () => {
        this.log.info(`Resume requested for ${device.name}`);
        void this.safeCommand(device, (robot) => robot.resume());
      })
      .addCommandHandler('RvcOperationalState.goHome', () => {
        this.log.info(`Dock (go home) requested for ${device.name}`);
        void this.safeCommand(device, (robot) => robot.dock());
      })
      .addCommandHandler('RvcRunMode.changeToMode', (data) => {
        const newMode = (data.request as { newMode?: number }).newMode;
        const supported = (data.attributes as { supportedModes?: { value?: RvcRunMode.ModeOption[] } }).supportedModes?.value;
        const mode = supported?.find((m) => m.mode === newMode);
        const cleaning = mode?.modeTags.some((t) => t.value === RvcRunMode.ModeTag.Cleaning);
        if (cleaning) {
          this.log.info(`Start cleaning requested for ${device.name}`);
          void this.safeCommand(device, (robot) => robot.start());
        } else {
          this.log.info(`Stop / idle requested for ${device.name}`);
          void this.safeCommand(device, (robot) => robot.stop());
        }
      });

    const runtime: RoombaRuntime = { config: device, endpoint };
    this.runtimes.set(device.blid as string, runtime);
    await this.registerDevice(endpoint);

    this.connectRobot(runtime);
  }

  /** Open the local MQTT connection and subscribe to state updates. */
  private connectRobot(runtime: RoombaRuntime): void {
    const { config } = runtime;
    try {
      const robot = dorita980.Local(config.blid as string, config.password as string, config.ipAddress);
      runtime.robot = robot;

      robot.on('connect', () => this.log.info(`Connected to ${config.name} at ${config.ipAddress}`));
      robot.on('offline', () => this.log.warn(`${config.name} is offline`));
      robot.on('close', () => this.log.debug(`Connection to ${config.name} closed`));
      robot.on('error', (error) => {
        this.log.error(`Connection error for ${config.name}: ${error.message}`);
        this.scheduleReconnect(runtime);
      });
      const onState = (state: RobotState): void => {
        void this.applyState(runtime, state);
      };
      robot.on('state', onState);
      robot.on('mission', onState);
    } catch (error) {
      this.log.error(`Failed to connect to ${config.name}: ${(error as Error).message}`);
      this.scheduleReconnect(runtime);
    }
  }

  /** Tear down the local MQTT connection. */
  private disconnectRobot(runtime: RoombaRuntime): void {
    if (!runtime.robot) return;
    try {
      runtime.robot.removeAllListeners();
      runtime.robot.end();
    } catch (error) {
      this.log.debug(`Error while disconnecting ${runtime.config.name}: ${(error as Error).message}`);
    }
    runtime.robot = undefined;
  }

  /** Schedule a reconnect attempt after a transient failure. */
  private scheduleReconnect(runtime: RoombaRuntime): void {
    if (runtime.reconnectTimer) return;
    this.disconnectRobot(runtime);
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = undefined;
      this.log.info(`Reconnecting to ${runtime.config.name}...`);
      this.connectRobot(runtime);
    }, 30_000);
  }

  /** Run a robot command, logging and recovering from errors. */
  private async safeCommand(config: RoombaDeviceConfig, action: (robot: RobotLocal) => Promise<unknown>): Promise<void> {
    const runtime = this.runtimes.get(config.blid as string);
    if (!runtime?.robot) {
      this.log.warn(`Cannot send command to ${config.name}: not connected`);
      return;
    }
    try {
      await action(runtime.robot);
    } catch (error) {
      this.log.error(`Command failed for ${config.name}: ${(error as Error).message}`);
    }
  }

  /** Map a dorita980 robot state onto the Matter endpoint attributes. */
  private async applyState(runtime: RoombaRuntime, state: RobotState): Promise<void> {
    const { endpoint, config } = runtime;
    const mission = state.cleanMissionStatus ?? {};

    // Battery level (%) -> PowerSource.
    if (typeof state.batPct === 'number') {
      const charging = mission.phase === 'charge';
      const level = state.batPct <= 10 ? PowerSource.BatChargeLevel.Critical : state.batPct <= 20 ? PowerSource.BatChargeLevel.Warning : PowerSource.BatChargeLevel.Ok;
      await endpoint.updateAttribute('PowerSource', 'batPercentRemaining', Math.round(Math.min(Math.max(state.batPct * 2, 0), 200)), this.log);
      await endpoint.updateAttribute('PowerSource', 'batChargeLevel', level, this.log);
      await endpoint.updateAttribute('PowerSource', 'batChargeState', charging ? PowerSource.BatChargeState.IsCharging : PowerSource.BatChargeState.IsNotCharging, this.log);
    }

    // Bin full -> BooleanState (true = bin full / fault present).
    if (state.bin && typeof state.bin.full === 'boolean') {
      await endpoint.updateAttribute('BooleanState', 'stateValue', state.bin.full, this.log);
      if (state.bin.full) this.log.notice(`${config.name}: bin is full`);
    }

    // Operational state + run mode.
    const { operationalState, running, error } = this.mapOperationalState(mission);
    await endpoint.updateAttribute('RvcOperationalState', 'operationalState', operationalState, this.log);
    await endpoint.updateAttribute('RvcOperationalState', 'operationalError', error, this.log);
    await endpoint.updateAttribute('RvcRunMode', 'currentMode', running ? 2 : 1, this.log);

    // Mission progress (best effort): elapsed minutes and cleaned area.
    if (running && (typeof mission.mssnM === 'number' || typeof mission.sqft === 'number')) {
      this.log.info(`${config.name}: cleaning (phase ${mission.phase ?? 'run'}, ${mission.mssnM ?? 0} min, ${mission.sqft ?? 0} sqft)`);
    }
  }

  /** Translate the iRobot mission phase into a Matter RVC operational state. */
  private mapOperationalState(mission: NonNullable<RobotState['cleanMissionStatus']>): {
    operationalState: RvcOperationalState.OperationalState;
    running: boolean;
    error: RvcOperationalState.ErrorStateStruct;
  } {
    const phase = mission.phase ?? '';
    const cycle = mission.cycle ?? 'none';
    let operationalState = RvcOperationalState.OperationalState.Docked;
    let running = false;

    if (phase === 'run' || phase === 'evac') {
      operationalState = RvcOperationalState.OperationalState.Running;
      running = true;
    } else if (phase === 'charge') {
      operationalState = RvcOperationalState.OperationalState.Charging;
    } else if (phase.startsWith('hm')) {
      operationalState = RvcOperationalState.OperationalState.SeekingCharger;
    } else if (phase === 'stuck') {
      operationalState = RvcOperationalState.OperationalState.Error;
    } else if (phase === 'pause' || (phase === 'stop' && cycle !== 'none')) {
      operationalState = RvcOperationalState.OperationalState.Paused;
    } else if (phase === 'stop') {
      operationalState = RvcOperationalState.OperationalState.Stopped;
    }

    const hasError = typeof mission.error === 'number' && mission.error !== 0;
    const error: RvcOperationalState.ErrorStateStruct = hasError
      ? { errorStateId: RvcOperationalState.ErrorState.UnableToCompleteOperation, errorStateLabel: 'Roomba error', errorStateDetails: `Error code ${mission.error}` }
      : { errorStateId: RvcOperationalState.ErrorState.NoError, errorStateDetails: 'Fully operational' };

    return { operationalState, running, error };
  }
}
