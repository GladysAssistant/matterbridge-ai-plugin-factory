/**
 * Matterbridge Ring plugin.
 *
 * Exposes Ring doorbells, cameras, alarm sensors and smart lighting to Matter.
 * No video streaming is provided (not supported over Matter).
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  contactSensor,
  dimmableLight,
  genericSwitch,
  occupancySensor,
  onOffLight,
  onOffSwitch,
  powerSource,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import {
  AlarmMode,
  Location,
  RingApi,
  RingCamera,
  RingDevice,
  RingDeviceType,
} from 'ring-client-api';
import type { Subscription } from 'rxjs';

/**
 * Plugin configuration.
 */
export type RingPlatformConfig = BasePlatformConfig & {
  whiteList: string[];
  blackList: string[];
  refreshToken?: string;
  locationModePollingSeconds?: number;
};

const VENDOR = 'Ring';

/**
 * Initialize the Ring plugin.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The logger instance.
 * @param {RingPlatformConfig} config - The plugin configuration.
 * @returns {RingPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: RingPlatformConfig): RingPlatform {
  return new RingPlatform(matterbridge, log, config);
}

/**
 * Ring dynamic platform.
 */
export class RingPlatform extends MatterbridgeDynamicPlatform {
  private ringApi?: RingApi;
  private readonly endpoints = new Map<string, MatterbridgeEndpoint>();
  private readonly subscriptions: Subscription[] = [];
  private readonly cameras = new Map<string, RingCamera>();
  private readonly alarmDevices = new Map<string, RingDevice>();
  private readonly locations = new Map<string, Location>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: RingPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info('Initializing Ring platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const refreshToken = (this.config as RingPlatformConfig).refreshToken;
    if (!refreshToken) {
      this.log.error('No Ring refreshToken configured. Generate one with "npx -p ring-client-api ring-auth-cli" and set it in the plugin config. No devices will be exposed.');
      return;
    }

    try {
      this.ringApi = new RingApi({
        refreshToken,
        debug: (this.config as RingPlatformConfig).debug === true,
        locationModePollingSeconds: (this.config as RingPlatformConfig).locationModePollingSeconds ?? 20,
      });

      // Persist refreshed tokens so we avoid frequent re-login (Ring rate limits).
      this.subscriptions.push(
        this.ringApi.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
          this.log.info('Ring refresh token updated. Update the plugin config "refreshToken" to persist it.');
          (this.config as RingPlatformConfig).refreshToken = newRefreshToken;
        }),
      );

      const locations = await this.ringApi.getLocations();
      this.log.info(`Found ${locations.length} Ring location(s).`);

      for (const location of locations) {
        this.locations.set(location.locationId, location);
        await this.registerCameras(location);
        await this.registerAlarmDevices(location);
        await this.registerAlarmModeSwitch(location);
      }
    } catch (error) {
      this.log.error(`Failed to connect to Ring: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Register an endpoint and keep a reference for later attribute updates.
   *
   * @param {string} key - The endpoint storage key.
   * @param {MatterbridgeEndpoint} ep - The endpoint.
   */
  private async register(key: string, ep: MatterbridgeEndpoint): Promise<void> {
    this.endpoints.set(key, ep);
    await this.registerDevice(ep);
  }

  /**
   * Register cameras and doorbells of a location.
   *
   * @param {Location} location - The Ring location.
   */
  private async registerCameras(location: Location): Promise<void> {
    for (const camera of location.cameras) {
      const id = String(camera.id);
      this.cameras.set(id, camera);
      const name = camera.name || `Ring Camera ${id}`;

      this.setSelectDevice(id, name);
      if (!this.validateDevice([name, id])) continue;

      // Motion + battery endpoint (every camera).
      const motion = new MatterbridgeEndpoint([occupancySensor, powerSource], { id: `ring-cam-${id}` })
        .createDefaultIdentifyClusterServer()
        .createDefaultBridgedDeviceBasicInformationClusterServer(name, `ring-cam-${id}`, this.matterbridge.aggregatorVendorId, VENDOR, String(camera.deviceType))
        .createDefaultOccupancySensingClusterServer(false);
      if (camera.hasBattery) {
        motion.createDefaultPowerSourceReplaceableBatteryClusterServer(camera.batteryLevel ?? 100);
      } else {
        motion.createDefaultPowerSourceWiredClusterServer();
      }
      motion.addRequiredClusterServers();
      await this.register(`ring-cam-${id}`, motion);

      // Doorbell ding endpoint (only doorbells).
      if (camera.isDoorbot) {
        const bell = new MatterbridgeEndpoint(genericSwitch, { id: `ring-bell-${id}` })
          .createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(`${name} Doorbell`, `ring-bell-${id}`, this.matterbridge.aggregatorVendorId, VENDOR, String(camera.deviceType))
          .createDefaultMomentarySwitchClusterServer()
          .addRequiredClusterServers();
        await this.register(`ring-bell-${id}`, bell);
      }

      // Camera light (if supported).
      if (camera.hasLight) {
        const light = new MatterbridgeEndpoint(onOffLight, { id: `ring-camlight-${id}` })
          .createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(`${name} Light`, `ring-camlight-${id}`, this.matterbridge.aggregatorVendorId, VENDOR, String(camera.deviceType))
          .createDefaultOnOffClusterServer(false)
          .addRequiredClusterServers();
        light.addCommandHandler('on', async () => {
          await camera.setLight(true).catch((e) => this.log.error(`setLight on failed: ${String(e)}`));
        });
        light.addCommandHandler('off', async () => {
          await camera.setLight(false).catch((e) => this.log.error(`setLight off failed: ${String(e)}`));
        });
        await this.register(`ring-camlight-${id}`, light);
      }

      // Camera siren (if supported).
      if (camera.hasSiren) {
        const siren = new MatterbridgeEndpoint(onOffSwitch, { id: `ring-siren-${id}` })
          .createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(`${name} Siren`, `ring-siren-${id}`, this.matterbridge.aggregatorVendorId, VENDOR, String(camera.deviceType))
          .createDefaultOnOffClusterServer(false)
          .addRequiredClusterServers();
        siren.addCommandHandler('on', async () => {
          await camera.setSiren(true).catch((e) => this.log.error(`setSiren on failed: ${String(e)}`));
        });
        siren.addCommandHandler('off', async () => {
          await camera.setSiren(false).catch((e) => this.log.error(`setSiren off failed: ${String(e)}`));
        });
        await this.register(`ring-siren-${id}`, siren);
      }
    }
  }

  /**
   * Register alarm sensors and smart lights of a location.
   *
   * @param {Location} location - The Ring location.
   */
  private async registerAlarmDevices(location: Location): Promise<void> {
    let devices: RingDevice[] = [];
    try {
      devices = await location.getDevices();
    } catch (error) {
      this.log.info(`Location ${location.name} has no alarm/base station: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    for (const device of devices) {
      const id = device.zid;
      const name = device.name || `Ring ${id}`;
      const type = device.deviceType;

      const isContact = type === RingDeviceType.ContactSensor || type === RingDeviceType.RetrofitZone || type === RingDeviceType.TiltSensor;
      const isMotion = type === RingDeviceType.MotionSensor || type === RingDeviceType.BeamsMotionSensor;
      const isLight =
        type === RingDeviceType.MultiLevelBulb ||
        type === RingDeviceType.MultiLevelSwitch ||
        type === RingDeviceType.BeamsDevice ||
        type === RingDeviceType.BeamsSwitch ||
        type === RingDeviceType.BeamsMultiLevelSwitch ||
        type === RingDeviceType.BeamsLightGroupSwitch ||
        type === RingDeviceType.Switch;

      if (!isContact && !isMotion && !isLight) continue;

      this.alarmDevices.set(id, device);
      this.setSelectDevice(id, name);
      if (!this.validateDevice([name, id])) continue;

      if (isContact) {
        const ep = new MatterbridgeEndpoint([contactSensor, powerSource], { id: `ring-contact-${id}` })
          .createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(name, `ring-contact-${id}`, this.matterbridge.aggregatorVendorId, VENDOR, type)
          .createDefaultBooleanStateClusterServer(true)
          .createDefaultPowerSourceReplaceableBatteryClusterServer(device.data.batteryLevel ?? 100)
          .addRequiredClusterServers();
        await this.register(`ring-contact-${id}`, ep);
      } else if (isMotion) {
        const ep = new MatterbridgeEndpoint([occupancySensor, powerSource], { id: `ring-motion-${id}` })
          .createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(name, `ring-motion-${id}`, this.matterbridge.aggregatorVendorId, VENDOR, type)
          .createDefaultOccupancySensingClusterServer(false)
          .createDefaultPowerSourceReplaceableBatteryClusterServer(device.data.batteryLevel ?? 100)
          .addRequiredClusterServers();
        await this.register(`ring-motion-${id}`, ep);
      } else {
        const dimmable = type === RingDeviceType.MultiLevelBulb || type === RingDeviceType.MultiLevelSwitch || type === RingDeviceType.BeamsMultiLevelSwitch;
        const ep = new MatterbridgeEndpoint(dimmable ? dimmableLight : onOffLight, { id: `ring-light-${id}` })
          .createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(name, `ring-light-${id}`, this.matterbridge.aggregatorVendorId, VENDOR, type)
          .createDefaultOnOffClusterServer(device.data.on === true);
        if (dimmable) ep.createDefaultLevelControlClusterServer(Math.round(((device.data.level ?? 1) as number) * 254));
        ep.addRequiredClusterServers();
        ep.addCommandHandler('on', () => device.setInfo({ device: { v1: { on: true } } }).catch((e) => this.log.error(`light on failed: ${String(e)}`)));
        ep.addCommandHandler('off', () => device.setInfo({ device: { v1: { on: false } } }).catch((e) => this.log.error(`light off failed: ${String(e)}`)));
        if (dimmable) {
          ep.addCommandHandler('moveToLevel', ({ request }) => {
            const level = Math.max(0, Math.min(1, ((request.level as number) ?? 0) / 254));
            return device.setInfo({ device: { v1: { level } } }).catch((e) => this.log.error(`light level failed: ${String(e)}`));
          });
          ep.addCommandHandler('moveToLevelWithOnOff', ({ request }) => {
            const level = Math.max(0, Math.min(1, ((request.level as number) ?? 0) / 254));
            return device.setInfo({ device: { v1: { level } } }).catch((e) => this.log.error(`light level failed: ${String(e)}`));
          });
        }
        await this.register(`ring-light-${id}`, ep);
      }
    }
  }

  /**
   * Register a best-effort alarm mode switch for a location (on = away, off = disarmed).
   *
   * @param {Location} location - The Ring location.
   */
  private async registerAlarmModeSwitch(location: Location): Promise<void> {
    if (!location.hasAlarmBaseStation) return;
    const id = `alarm-${location.locationId}`;
    const name = `${location.name || 'Ring'} Alarm`;
    this.setSelectDevice(id, name);
    if (!this.validateDevice([name, id])) return;

    const ep = new MatterbridgeEndpoint(onOffSwitch, { id })
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, id, this.matterbridge.aggregatorVendorId, VENDOR, 'security-panel')
      .createDefaultOnOffClusterServer(false)
      .addRequiredClusterServers();
    ep.addCommandHandler('on', () => location.armAway().catch((e) => this.log.error(`armAway failed: ${String(e)}`)));
    ep.addCommandHandler('off', () => location.disarm().catch((e) => this.log.error(`disarm failed: ${String(e)}`)));
    await this.register(id, ep);
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    for (const [id, camera] of this.cameras) {
      const motion = this.endpoints.get(`ring-cam-${id}`);
      if (motion) {
        this.subscriptions.push(
          camera.onMotionDetected.subscribe((detected) => {
            this.log.info(`Camera ${camera.name} motion: ${detected}`);
            motion.updateAttribute('OccupancySensing', 'occupancy', { occupied: detected }, motion.log).catch(() => {});
          }),
        );
        if (camera.hasBattery) {
          this.subscriptions.push(
            camera.onBatteryLevel.subscribe((level) => {
              if (level === null) return;
              motion.updateAttribute('PowerSource', 'batPercentRemaining', Math.round(level * 2), motion.log).catch(() => {});
            }),
          );
        }
      }

      const bell = this.endpoints.get(`ring-bell-${id}`);
      if (bell) {
        this.subscriptions.push(
          camera.onDoorbellPressed.subscribe(() => {
            this.log.info(`Doorbell pressed: ${camera.name}`);
            bell.triggerSwitchEvent('Single', bell.log).catch(() => {});
          }),
        );
      }

      // Light / siren state sync from camera data.
      this.subscriptions.push(
        camera.onData.subscribe((data) => {
          const light = this.endpoints.get(`ring-camlight-${id}`);
          if (light && typeof (data as { led_status?: string }).led_status === 'string') {
            light.updateAttribute('OnOff', 'onOff', (data as { led_status?: string }).led_status === 'on', light.log).catch(() => {});
          }
          const siren = this.endpoints.get(`ring-siren-${id}`);
          const sirenStatus = (data as { siren_status?: { seconds_remaining?: number } }).siren_status?.seconds_remaining;
          if (siren && typeof sirenStatus === 'number') {
            siren.updateAttribute('OnOff', 'onOff', sirenStatus > 0, siren.log).catch(() => {});
          }
        }),
      );
    }

    for (const [id, device] of this.alarmDevices) {
      this.subscriptions.push(
        device.onData.subscribe((data) => {
          const contact = this.endpoints.get(`ring-contact-${id}`);
          if (contact) {
            // Matter BooleanState: true = closed (contact), false = open.
            contact.updateAttribute('BooleanState', 'stateValue', data.faulted !== true, contact.log).catch(() => {});
            if (typeof data.batteryLevel === 'number') {
              contact.updateAttribute('PowerSource', 'batPercentRemaining', Math.round(data.batteryLevel * 2), contact.log).catch(() => {});
            }
          }
          const motion = this.endpoints.get(`ring-motion-${id}`);
          if (motion) {
            const occupied = data.faulted === true || data.motionStatus === 'faulted';
            motion.updateAttribute('OccupancySensing', 'occupancy', { occupied }, motion.log).catch(() => {});
            if (typeof data.batteryLevel === 'number') {
              motion.updateAttribute('PowerSource', 'batPercentRemaining', Math.round(data.batteryLevel * 2), motion.log).catch(() => {});
            }
          }
          const light = this.endpoints.get(`ring-light-${id}`);
          if (light) {
            if (typeof data.on === 'boolean') light.updateAttribute('OnOff', 'onOff', data.on, light.log).catch(() => {});
            const level = (data as { level?: number }).level;
            if (typeof level === 'number' && light.hasClusterServer('LevelControl')) {
              light.updateAttribute('LevelControl', 'currentLevel', Math.max(1, Math.round(level * 254)), light.log).catch(() => {});
            }
          }
        }),
      );
    }

    for (const location of this.locations.values()) {
      if (!location.hasAlarmBaseStation) continue;
      const ep = this.endpoints.get(`alarm-${location.locationId}`);
      if (!ep) continue;
      this.subscriptions.push(
        location.onLocationMode.subscribe((mode) => {
          this.log.info(`Location ${location.name} mode: ${mode}`);
          ep.updateAttribute('OnOff', 'onOff', mode === 'away', ep.log).catch(() => {});
        }),
      );
      location.getAlarmMode().then((mode: AlarmMode) => {
        ep.updateAttribute('OnOff', 'onOff', mode === 'all', ep.log).catch(() => {});
      }).catch(() => {});
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);

    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions.length = 0;
    for (const location of this.locations.values()) location.disconnect();
    this.cameras.clear();
    this.alarmDevices.clear();
    this.locations.clear();
    this.ringApi = undefined;

    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }
}
