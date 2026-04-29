/**
 * Matterbridge plugin for Palazzetti pellet stoves.
 * Talks to the WPalaControl / Connection Box HTTP API:
 *   http://{host}/cgi-bin/sendmsg.lua?cmd={COMMAND}
 *
 * Capabilities exposed: On/Off (CMD ON / CMD OFF), STATUS, LSTATUS,
 * target temperature (SETP) and ambient temperature (T1).
 */

import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge, thermostatDevice } from 'matterbridge';
import { Thermostat } from 'matterbridge/matter/clusters';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): PalazzettiPlatform {
  return new PalazzettiPlatform(matterbridge, log, config);
}

interface AllsResponse {
  SUCCESS?: boolean;
  DATA?: {
    STATUS?: number;
    LSTATUS?: number;
    SETP?: number;
    T1?: number;
    T2?: number;
    PWR?: number;
    MAC?: string;
    LABEL?: string;
    [k: string]: unknown;
  };
}

const STATUS_LABELS: Record<number, string> = {
  0: 'OFF',
  1: 'OFF TIMER',
  2: 'TESTFIRE',
  3: 'HEATUP',
  4: 'FUELIGN',
  5: 'IGNTEST',
  6: 'BURNING',
  9: 'COOLFLUID',
  10: 'FIRESTOP',
  11: 'CLEANFIRE',
  12: 'COOL',
  241: 'CHIMNEY ALARM',
  243: 'GRATE ERROR',
  244: 'NTC2 ALARM',
  245: 'NTC3 ALARM',
  247: 'DOOR ALARM',
  248: 'PRESS ALARM',
  249: 'NTC1 ALARM',
  250: 'TC1 ALARM',
  252: 'GAS ALARM',
  253: 'NOPELLET ALARM',
};

export class PalazzettiPlatform extends MatterbridgeDynamicPlatform {
  private device?: MatterbridgeEndpoint;
  private pollTimer?: NodeJS.Timeout;
  private host: string;
  private deviceLabel: string;
  private pollInterval: number;
  private mac = '';
  private lastStatus = -1;
  private lastLStatus = -1;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.4.0". Current: ${this.matterbridge.matterbridgeVersion}`);
    }

    this.host = (config.host as string) || '192.168.1.100';
    this.deviceLabel = (config.deviceLabel as string) || 'Poele Palazzetti';
    this.pollInterval = Math.max(10, (config.pollInterval as number) || 30);

    this.log.info(`Initializing Palazzetti plugin for host ${this.host}`);
  }

  override async onStart(reason?: string) {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    // Try to read MAC for stable serial.
    const initial = await this.sendCommand('GET ALLS');
    this.mac = (initial?.DATA?.MAC as string) || 'palazzetti';
    const serial = `palazzetti-${this.mac.replace(/:/g, '').toLowerCase()}`;

    this.device = new MatterbridgeEndpoint(thermostatDevice, { id: serial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        this.deviceLabel,
        serial,
        this.matterbridge.aggregatorVendorId,
        'Palazzetti',
        'Pellet Stove',
        1,
        '1.0.0',
      )
      .createDefaultHeatingThermostatClusterServer(
        20, // localTemperature °C
        20, // occupiedHeatingSetpoint °C
        7,  // minHeatSetpointLimit °C
        30, // maxHeatSetpointLimit °C
      )
      .addRequiredClusterServers();

    this.setSelectDevice(serial, this.deviceLabel);
    const selected = this.validateDevice([this.deviceLabel, serial]);
    if (!selected) {
      this.log.warn('Device not selected via white/black list, skipping registration');
      return;
    }

    // Command handlers
    this.device.addCommandHandler('setpointRaiseLower', async ({ request }) => {
      const current = (this.device!.getAttribute('Thermostat', 'occupiedHeatingSetpoint') as number) ?? 2000;
      const newValue = current + (request.amount * 10);
      const setp = Math.round(newValue / 100);
      this.log.info(`setpointRaiseLower: amount=${request.amount} -> SET SETP ${setp}`);
      await this.sendCommand(`SET SETP ${setp}`);
      await this.device!.setAttribute('Thermostat', 'occupiedHeatingSetpoint', setp * 100, this.log);
    });

    await this.registerDevice(this.device);
  }

  override async onConfigure() {
    await super.onConfigure();
    this.log.info('onConfigure called');
    if (!this.device) return;

    // Subscribe to occupiedHeatingSetpoint changes
    await this.device.subscribeAttribute(
      'Thermostat',
      'occupiedHeatingSetpoint',
      (newValue: number, oldValue: number) => {
        if (newValue === oldValue) return;
        const setp = Math.round(newValue / 100);
        this.log.info(`occupiedHeatingSetpoint -> SET SETP ${setp}`);
        void this.sendCommand(`SET SETP ${setp}`);
      },
      this.log,
    );

    // Subscribe to systemMode changes -> CMD ON / CMD OFF
    await this.device.subscribeAttribute(
      'Thermostat',
      'systemMode',
      (newValue: Thermostat.SystemMode, oldValue: Thermostat.SystemMode) => {
        if (newValue === oldValue) return;
        if (newValue === Thermostat.SystemMode.Off) {
          this.log.info('systemMode -> CMD OFF');
          void this.sendCommand('CMD OFF');
        } else {
          this.log.info('systemMode -> CMD ON');
          void this.sendCommand('CMD ON');
        }
      },
      this.log,
    );

    // Initial poll + start interval
    await this.poll();
    this.pollTimer = setInterval(() => void this.poll(), this.pollInterval * 1000);
  }

  override async onChangeLoggerLevel(_logLevel: LogLevel) {
    this.log.info(`onChangeLoggerLevel: ${_logLevel}`);
  }

  override async onShutdown(reason?: string) {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  private async sendCommand(command: string): Promise<AllsResponse | undefined> {
    const url = `http://${this.host}/cgi-bin/sendmsg.lua?cmd=${encodeURIComponent(command)}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) {
        this.log.warn(`Command "${command}" failed: HTTP ${res.status}`);
        return undefined;
      }
      const json = (await res.json()) as AllsResponse;
      if (this.config.debug) this.log.debug(`"${command}" -> ${JSON.stringify(json)}`);
      return json;
    } catch (err) {
      this.log.warn(`Command "${command}" error: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async poll() {
    if (!this.device) return;
    const data = (await this.sendCommand('GET ALLS'))?.DATA;
    if (!data) return;

    if (typeof data.STATUS === 'number' && data.STATUS !== this.lastStatus) {
      this.lastStatus = data.STATUS;
      this.log.info(`STATUS=${data.STATUS} (${STATUS_LABELS[data.STATUS] ?? 'UNKNOWN'})`);
      const mode = data.STATUS === 0 || data.STATUS === 1 || data.STATUS === 10 || data.STATUS === 12
        ? Thermostat.SystemMode.Off
        : Thermostat.SystemMode.Heat;
      await this.device.setAttribute('Thermostat', 'systemMode', mode, this.log);
    }
    if (typeof data.LSTATUS === 'number' && data.LSTATUS !== this.lastLStatus) {
      this.lastLStatus = data.LSTATUS;
      this.log.info(`LSTATUS=${data.LSTATUS}`);
    }
    if (typeof data.T1 === 'number') {
      const v = Math.round(data.T1 * 100);
      await this.device.setAttribute('Thermostat', 'localTemperature', v, this.log);
    }
    if (typeof data.SETP === 'number') {
      const v = Math.round(data.SETP * 100);
      await this.device.setAttribute('Thermostat', 'occupiedHeatingSetpoint', v, this.log);
    }
  }
}
