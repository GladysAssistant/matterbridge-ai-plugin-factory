/**
 * matterbridge-melcloud - Matterbridge plugin for Mitsubishi MELCloud AC control
 *
 * Supports: On/Off, Set Temperature, AC Mode (Heat, Cool, Auto)
 */
import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, airConditioner } from 'matterbridge';
import { Thermostat } from 'matterbridge/matter/clusters';
import { FLAG_OPERATION_MODE, FLAG_POWER, FLAG_SET_TEMPERATURE, MelCloudApi, MelCloudMode } from './melcloudApi.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function initializePlugin(matterbridge, log, config) {
    return new MelCloudPlatform(matterbridge, log, config);
}
// Map MELCloud OperationMode → Matter Thermostat.SystemMode
function toMatterMode(mode) {
    switch (mode) {
        case MelCloudMode.Heat:
            return Thermostat.SystemMode.Heat;
        case MelCloudMode.Cool:
            return Thermostat.SystemMode.Cool;
        case MelCloudMode.Dry:
            return Thermostat.SystemMode.Dry;
        case MelCloudMode.Fan:
            return Thermostat.SystemMode.FanOnly;
        case MelCloudMode.Auto:
        default:
            return Thermostat.SystemMode.Auto;
    }
}
// Map Matter Thermostat.SystemMode → MELCloud OperationMode
function toMelCloudMode(mode) {
    switch (mode) {
        case Thermostat.SystemMode.Heat:
        case Thermostat.SystemMode.EmergencyHeat:
            return MelCloudMode.Heat;
        case Thermostat.SystemMode.Cool:
        case Thermostat.SystemMode.Precooling:
            return MelCloudMode.Cool;
        case Thermostat.SystemMode.Dry:
            return MelCloudMode.Dry;
        case Thermostat.SystemMode.FanOnly:
            return MelCloudMode.Fan;
        case Thermostat.SystemMode.Auto:
        default:
            return MelCloudMode.Auto;
    }
}
export class MelCloudPlatform extends MatterbridgeDynamicPlatform {
    api = new MelCloudApi();
    pollIntervals = new Map();
    deviceMap = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(matterbridge, log, config) {
        super(matterbridge, log, config);
        this.log.info('MelCloudPlatform initializing...');
    }
    async onStart(reason) {
        this.log.info(`onStart: ${reason ?? 'none'}`);
        await this.ready;
        await this.clearSelect();
        const email = this.config['email'];
        const password = this.config['password'];
        if (!email || !password) {
            this.log.error('MELCloud email and password must be configured');
            return;
        }
        try {
            this.log.info('Connecting to MELCloud...');
            await this.api.login(email, password);
            this.log.info('MELCloud connected');
            await this.discoverDevices();
        }
        catch (err) {
            this.log.error(`MELCloud connect failed: ${err}`);
        }
    }
    async onConfigure() {
        await super.onConfigure();
        this.log.info('onConfigure called');
        for (const [deviceId, { device, buildingId }] of this.deviceMap) {
            try {
                const state = await this.api.getDeviceState(deviceId, buildingId);
                await this.updateDeviceState(device, state);
            }
            catch (err) {
                this.log.warn(`Failed to sync state for device ${deviceId}: ${err}`);
            }
            this.startPolling(deviceId, buildingId, device);
        }
    }
    async onShutdown(reason) {
        await super.onShutdown(reason);
        this.log.info(`onShutdown: ${reason ?? 'none'}`);
        for (const timer of this.pollIntervals.values())
            clearInterval(timer);
        this.pollIntervals.clear();
        if (this.config.unregisterOnShutdown === true)
            await this.unregisterAllDevices();
    }
    async discoverDevices() {
        let devices;
        try {
            devices = await this.api.listDevices();
            this.log.info(`Discovered ${devices.length} MELCloud device(s)`);
        }
        catch (err) {
            this.log.error(`Failed to list MELCloud devices: ${err}`);
            return;
        }
        for (const dev of devices) {
            // Only handle Air-To-Air (DeviceType 0)
            if (dev.Device.DeviceType !== 0) {
                this.log.info(`Skipping device ${dev.DeviceName} (unsupported type ${dev.Device.DeviceType})`);
                continue;
            }
            const uniqueId = `melcloud-${dev.DeviceID}`;
            const serialNumber = String(dev.DeviceID);
            this.setSelectDevice(serialNumber, dev.DeviceName);
            if (!this.validateDevice([dev.DeviceName, serialNumber]))
                continue;
            const minTemp = Math.min(dev.Device.MinTempHeat ?? 10, dev.Device.MinTempCoolDry ?? 16, dev.Device.MinTempAutomatic ?? 10);
            const maxTemp = Math.max(dev.Device.MaxTempHeat ?? 31, dev.Device.MaxTempCoolDry ?? 31, dev.Device.MaxTempAutomatic ?? 31);
            const endpoint = new MatterbridgeEndpoint(airConditioner, { id: uniqueId })
                .createDefaultBridgedDeviceBasicInformationClusterServer(dev.DeviceName, serialNumber, this.matterbridge.aggregatorVendorId, 'Mitsubishi Electric', 'MELCloud AC', 0x1234, '1.0.0')
                .createDefaultIdentifyClusterServer()
                .createDefaultOnOffClusterServer(dev.Device.Power)
                .createDefaultThermostatClusterServer(Math.round(dev.Device.RoomTemperature * 100), Math.round((dev.Device.SetTemperature ?? 21) * 100), Math.round((dev.Device.SetTemperature ?? 22) * 100), 0, Math.round(minTemp * 100), Math.round(maxTemp * 100), Math.round(minTemp * 100), Math.round(maxTemp * 100))
                .addRequiredClusterServers();
            // OnOff handlers
            endpoint.addCommandHandler('on', async () => {
                this.log.info(`${dev.DeviceName}: Power ON`);
                await this.sendCommand(dev.DeviceID, dev.BuildingID, { Power: true, EffectiveFlags: FLAG_POWER });
            });
            endpoint.addCommandHandler('off', async () => {
                this.log.info(`${dev.DeviceName}: Power OFF`);
                await this.sendCommand(dev.DeviceID, dev.BuildingID, { Power: false, EffectiveFlags: FLAG_POWER });
            });
            // Thermostat setpoint handlers
            endpoint.addCommandHandler('setpointRaiseLower', async (data) => {
                const { mode, amount } = data.request;
                const current = (await endpoint.getAttribute('thermostat', 'occupiedHeatingSetpoint', this.log));
                const delta = amount * 0.1 * (mode === 0 ? 1 : -1);
                const newTemp = (current / 100) + delta;
                this.log.info(`${dev.DeviceName}: Setpoint raise/lower → ${newTemp}°C`);
                await this.sendCommand(dev.DeviceID, dev.BuildingID, {
                    SetTemperature: newTemp,
                    EffectiveFlags: FLAG_SET_TEMPERATURE,
                });
            });
            // System mode write handler via attribute subscription
            endpoint.subscribeAttribute('thermostat', 'systemMode', async (newMode, oldMode) => {
                if (newMode === oldMode)
                    return;
                const melMode = toMelCloudMode(newMode);
                this.log.info(`${dev.DeviceName}: Mode change → ${newMode} (${Thermostat.SystemMode[newMode]}) → MELCloud ${melMode}`);
                if (newMode === Thermostat.SystemMode.Off) {
                    await this.sendCommand(dev.DeviceID, dev.BuildingID, { Power: false, EffectiveFlags: FLAG_POWER });
                }
                else {
                    await this.sendCommand(dev.DeviceID, dev.BuildingID, {
                        Power: true,
                        OperationMode: melMode,
                        EffectiveFlags: FLAG_POWER | FLAG_OPERATION_MODE,
                    });
                }
            }, this.log);
            // Occupied heating setpoint subscription
            endpoint.subscribeAttribute('thermostat', 'occupiedHeatingSetpoint', async (newVal, oldVal) => {
                if (newVal === oldVal)
                    return;
                const tempC = newVal / 100;
                this.log.info(`${dev.DeviceName}: Temperature setpoint → ${tempC}°C`);
                await this.sendCommand(dev.DeviceID, dev.BuildingID, {
                    SetTemperature: tempC,
                    EffectiveFlags: FLAG_SET_TEMPERATURE,
                });
            }, this.log);
            // Occupied cooling setpoint subscription
            endpoint.subscribeAttribute('thermostat', 'occupiedCoolingSetpoint', async (newVal, oldVal) => {
                if (newVal === oldVal)
                    return;
                const tempC = newVal / 100;
                this.log.info(`${dev.DeviceName}: Cooling setpoint → ${tempC}°C`);
                await this.sendCommand(dev.DeviceID, dev.BuildingID, {
                    SetTemperature: tempC,
                    EffectiveFlags: FLAG_SET_TEMPERATURE,
                });
            }, this.log);
            await this.registerDevice(endpoint);
            this.deviceMap.set(dev.DeviceID, { device: endpoint, buildingId: dev.BuildingID });
            this.log.info(`Registered device: ${dev.DeviceName} (ID: ${dev.DeviceID})`);
        }
    }
    async sendCommand(deviceId, buildingId, patch) {
        try {
            const state = await this.api.getDeviceState(deviceId, buildingId);
            const updated = { ...state, ...patch, DeviceID: deviceId, BuildingID: buildingId };
            await this.api.setDeviceState(updated);
        }
        catch (err) {
            this.log.error(`sendCommand failed for device ${deviceId}: ${err}`);
        }
    }
    async updateDeviceState(endpoint, state) {
        await endpoint.setAttribute('onOff', 'onOff', state.Power, this.log);
        const systemMode = state.Power ? toMatterMode(state.OperationMode) : Thermostat.SystemMode.Off;
        await endpoint.setAttribute('thermostat', 'systemMode', systemMode, this.log);
        await endpoint.setAttribute('thermostat', 'localTemperature', Math.round(state.RoomTemperature * 100), this.log);
        const setpointCentidegrees = Math.round(state.SetTemperature * 100);
        await endpoint.setAttribute('thermostat', 'occupiedHeatingSetpoint', setpointCentidegrees, this.log);
        await endpoint.setAttribute('thermostat', 'occupiedCoolingSetpoint', setpointCentidegrees, this.log);
    }
    startPolling(deviceId, buildingId, endpoint) {
        const interval = this.config['pollingInterval'] ?? 60000;
        const timer = setInterval(async () => {
            try {
                const state = await this.api.getDeviceState(deviceId, buildingId);
                await this.updateDeviceState(endpoint, state);
            }
            catch (err) {
                this.log.warn(`Polling error for device ${deviceId}: ${err}`);
            }
        }, interval);
        this.pollIntervals.set(deviceId, timer);
    }
}
//# sourceMappingURL=module.js.map