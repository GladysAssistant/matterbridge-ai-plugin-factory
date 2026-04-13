/**
 * MelCloud Matterbridge Platform
 *
 * Bridges Mitsubishi Electric MELCloud air-to-air (ATA) devices to the Matter
 * protocol via Matterbridge, exposing each AC unit as a Matter Thermostat.
 *
 * Supported capabilities
 * ─────────────────────
 *  • On / Off          – Thermostat SystemMode=Off / last active mode
 *  • Heating mode      – Thermostat SystemMode=Heat
 *  • Cooling mode      – Thermostat SystemMode=Cool
 *  • Auto mode         – Thermostat SystemMode=Auto
 *  • Target temperature – OccupiedHeatingSetpoint / OccupiedCoolingSetpoint
 *  • Room temperature  – LocalTemperature (read-only)
 */
import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, MatterbridgeThermostatServer, thermostatDevice, } from 'matterbridge';
import { Thermostat } from 'matterbridge/matter/clusters';
import { MelCloudClient } from './melcloudApi.js';
// ─── Platform ─────────────────────────────────────────────────────────────────
export class MelCloudPlatform extends MatterbridgeDynamicPlatform {
    melConfig;
    client;
    /** deviceId → DeviceContext */
    contexts = new Map();
    pollingTimer;
    // ── Constructor ─────────────────────────────────────────────────────────────
    constructor(matterbridge, log, config) {
        super(matterbridge, log, config);
        this.melConfig = config;
        this.client = new MelCloudClient();
        this.log.debug('MelCloudPlatform constructed');
    }
    // ── Lifecycle ───────────────────────────────────────────────────────────────
    async onStart(reason) {
        this.log.info(`MelCloud platform starting${reason ? `: ${reason}` : ''}`);
        const { username, password } = this.melConfig;
        if (!username || !password) {
            this.log.error('MelCloud: "username" and "password" must be set in the plugin configuration.');
            return;
        }
        try {
            await this.client.login({ username, password });
            this.log.info('MelCloud: authenticated successfully');
            await this.discoverDevices();
            const intervalMs = Math.max(30, this.melConfig.pollingInterval ?? 60) * 1000;
            this.pollingTimer = setInterval(() => {
                void this.pollDevices();
            }, intervalMs);
            this.log.info(`MelCloud: polling every ${intervalMs / 1000} s`);
        }
        catch (err) {
            this.log.error('MelCloud: failed to start –', this.errorMsg(err));
        }
    }
    async onConfigure() {
        this.log.info('MelCloud: attaching command and attribute handlers');
        for (const [deviceId, ctx] of this.contexts) {
            await this.attachHandlers(deviceId, ctx);
        }
    }
    async onShutdown(reason) {
        this.log.info(`MelCloud platform shutting down${reason ? `: ${reason}` : ''}`);
        if (this.pollingTimer !== undefined) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = undefined;
        }
    }
    // ── Device discovery ────────────────────────────────────────────────────────
    async discoverDevices() {
        const devices = await this.client.listAtaDevices();
        this.log.info(`MelCloud: discovered ${devices.length} ATA device(s)`);
        for (const device of devices) {
            await this.registerAtaDevice(device);
        }
    }
    async registerAtaDevice(state) {
        const { DeviceID: deviceId, DeviceName: rawName } = state;
        const name = rawName?.trim() || `MELCloud AC ${deviceId}`;
        this.log.info(`MelCloud: registering "${name}" (DeviceID=${deviceId}, BuildingID=${state.BuildingID})`);
        const systemMode = this.melToMatterMode(state.Power, state.OperationMode);
        // ── Create Matter thermostat endpoint ─────────────────────────────────────
        const endpoint = new MatterbridgeEndpoint(thermostatDevice, { id: `melcloud-ata-${deviceId}` }, this.melConfig.debug);
        // Bridged device basic information (no productId field in this API)
        endpoint.createDefaultBridgedDeviceBasicInformationClusterServer(name, `melcloud-ata-${deviceId}`, // serialNumber
        0x1414, // vendorId  (Mitsubishi Electric placeholder)
        'Mitsubishi Electric', // vendorName
        'MELCloud ATA', // productName
        1, // softwareVersion
        '1.0.0');
        // createDefaultThermostatClusterServer takes temperatures in **°C**
        // (it internally multiplies by 100 to produce Matter centidegrees).
        endpoint.createDefaultThermostatClusterServer(state.RoomTemperature, // localTemperature (°C)
        state.SetTemperature, // occupiedHeatingSetpoint (°C)
        state.SetTemperature, // occupiedCoolingSetpoint (°C)
        0, // minSetpointDeadBand
        10, // minHeatSetpointLimit (°C)
        31, // maxHeatSetpointLimit (°C)
        16, // minCoolSetpointLimit (°C)
        31);
        // NOTE: Do NOT call setAttribute here during onStart – the Matter node's
        // NodeActivity service is not yet running, which causes the error:
        //   "Error in reactor<...thermostat.#nodeOnline>: Required dependency
        //    NodeActivity is not available"
        // The initial systemMode is applied later in attachHandlers (onConfigure).
        await this.registerDevice(endpoint);
        const lastActiveMode = systemMode !== Thermostat.SystemMode.Off ? systemMode : Thermostat.SystemMode.Auto;
        this.contexts.set(deviceId, {
            state,
            endpoint,
            lastActiveMode,
            isPollingUpdate: false,
        });
    }
    // ── Handler wiring (called from onConfigure) ────────────────────────────────
    async attachHandlers(deviceId, ctx) {
        const { endpoint } = ctx;
        // ── Apply initial systemMode ───────────────────────────────────────────────
        // setAttribute requires the Matter node to be running (NodeActivity must be
        // available).  onConfigure is the first safe point to call it – do so here
        // with the isPollingUpdate guard so the subscription we attach below does
        // not echo the initial write back to MELCloud.
        const initialMode = this.melToMatterMode(ctx.state.Power, ctx.state.OperationMode);
        ctx.isPollingUpdate = true;
        try {
            await endpoint.setAttribute(MatterbridgeThermostatServer, 'systemMode', initialMode);
        }
        finally {
            ctx.isPollingUpdate = false;
        }
        // ── setpointRaiseLower command ─────────────────────────────────────────────
        // Some Matter controllers send this command instead of writing setpoint
        // attributes directly.
        endpoint.addCommandHandler('setpointRaiseLower', async ({ request }) => {
            const context = this.contexts.get(deviceId);
            if (!context)
                return;
            // amount is in 0.1 °C increments (signed 8-bit)
            const deltaCelsius = request.amount / 10;
            const newTemp = Math.min(31, Math.max(10, context.state.SetTemperature + deltaCelsius));
            this.log.debug(`MelCloud: setpointRaiseLower – delta=${deltaCelsius}°C → ${newTemp}°C (device ${deviceId})`);
            await this.sendSetTemperature(deviceId, newTemp);
        });
        // ── SystemMode attribute subscription ─────────────────────────────────────
        // Fires when a Matter controller changes the operating mode or power state.
        await endpoint.subscribeAttribute(MatterbridgeThermostatServer, 'systemMode', (newMode) => {
            const context = this.contexts.get(deviceId);
            if (!context || context.isPollingUpdate)
                return;
            this.log.debug(`MelCloud: device ${deviceId} – SystemMode → ` +
                `${Thermostat.SystemMode[newMode] ?? String(newMode)}`);
            void this.sendSystemMode(deviceId, newMode);
        });
        // ── OccupiedHeatingSetpoint subscription ──────────────────────────────────
        // Value arrives in centidegrees (Matter units = 0.01 °C).
        await endpoint.subscribeAttribute(MatterbridgeThermostatServer, 'occupiedHeatingSetpoint', (newValue) => {
            const context = this.contexts.get(deviceId);
            if (!context || context.isPollingUpdate)
                return;
            const tempC = newValue / 100;
            this.log.debug(`MelCloud: device ${deviceId} – HeatingSetpoint → ${tempC}°C`);
            void this.sendSetTemperature(deviceId, tempC);
        });
        // ── OccupiedCoolingSetpoint subscription ──────────────────────────────────
        await endpoint.subscribeAttribute(MatterbridgeThermostatServer, 'occupiedCoolingSetpoint', (newValue) => {
            const context = this.contexts.get(deviceId);
            if (!context || context.isPollingUpdate)
                return;
            const tempC = newValue / 100;
            this.log.debug(`MelCloud: device ${deviceId} – CoolingSetpoint → ${tempC}°C`);
            void this.sendSetTemperature(deviceId, tempC);
        });
    }
    // ── MELCloud API calls ──────────────────────────────────────────────────────
    /** Translates a Matter SystemMode write into MELCloud API calls. */
    async sendSystemMode(deviceId, newMode) {
        const ctx = this.contexts.get(deviceId);
        if (!ctx)
            return;
        try {
            if (newMode === Thermostat.SystemMode.Off) {
                const updated = await this.client.setAtaValues(ctx.state, { Power: false });
                ctx.state = { ...ctx.state, ...updated, Power: false };
                this.log.info(`MelCloud: device ${deviceId} – powered OFF`);
            }
            else {
                const operationMode = this.matterToMelMode(newMode);
                const updated = await this.client.setAtaValues(ctx.state, {
                    Power: true,
                    OperationMode: operationMode,
                });
                ctx.state = { ...ctx.state, ...updated, Power: true, OperationMode: operationMode };
                ctx.lastActiveMode = newMode;
                this.log.info(`MelCloud: device ${deviceId} – mode → ` +
                    `${Thermostat.SystemMode[newMode]} (OperationMode=${operationMode})`);
            }
        }
        catch (err) {
            this.log.error(`MelCloud: failed to set mode on device ${deviceId} –`, this.errorMsg(err));
        }
    }
    /** Sends a new target temperature (°C) to MELCloud. */
    async sendSetTemperature(deviceId, tempCelsius) {
        const ctx = this.contexts.get(deviceId);
        if (!ctx)
            return;
        // MELCloud typically accepts 0.5 °C steps; clamp to documented range 10–31 °C
        const clamped = Math.min(31, Math.max(10, Math.round(tempCelsius * 2) / 2));
        try {
            const updated = await this.client.setAtaValues(ctx.state, { SetTemperature: clamped });
            ctx.state = { ...ctx.state, ...updated, SetTemperature: clamped };
            this.log.info(`MelCloud: device ${deviceId} – SetTemperature → ${clamped}°C`);
        }
        catch (err) {
            this.log.error(`MelCloud: failed to set temperature on device ${deviceId} –`, this.errorMsg(err));
        }
    }
    // ── Polling ─────────────────────────────────────────────────────────────────
    async pollDevices() {
        this.log.debug('MelCloud: polling device states');
        let devices;
        try {
            devices = await this.client.listAtaDevices();
        }
        catch (err) {
            this.log.warn('MelCloud: poll request failed –', this.errorMsg(err));
            return;
        }
        for (const freshState of devices) {
            const ctx = this.contexts.get(freshState.DeviceID);
            if (!ctx)
                continue;
            ctx.isPollingUpdate = true;
            try {
                await this.syncMatterAttributes(ctx, freshState);
                ctx.state = { ...ctx.state, ...freshState };
            }
            finally {
                ctx.isPollingUpdate = false;
            }
        }
    }
    /**
     * Pushes fresh MELCloud state into the Matter thermostat cluster attributes.
     *
     * Note: `setAttribute` for thermostat attributes expects raw cluster values:
     *  - temperatures in **centidegrees** (0.01 °C), e.g. 23 °C = 2300
     *  - systemMode as a Thermostat.SystemMode enum number
     */
    async syncMatterAttributes(ctx, newState) {
        const { endpoint } = ctx;
        const systemMode = this.melToMatterMode(newState.Power, newState.OperationMode);
        const localTempCenti = Math.round(newState.RoomTemperature * 100);
        const setpointCenti = Math.round(newState.SetTemperature * 100);
        await endpoint.setAttribute(MatterbridgeThermostatServer, 'localTemperature', localTempCenti);
        await endpoint.setAttribute(MatterbridgeThermostatServer, 'systemMode', systemMode);
        await endpoint.setAttribute(MatterbridgeThermostatServer, 'occupiedHeatingSetpoint', setpointCenti);
        await endpoint.setAttribute(MatterbridgeThermostatServer, 'occupiedCoolingSetpoint', setpointCenti);
        if (systemMode !== Thermostat.SystemMode.Off) {
            ctx.lastActiveMode = systemMode;
        }
        this.log.debug(`MelCloud: synced device ${newState.DeviceID} – ` +
            `room=${newState.RoomTemperature}°C set=${newState.SetTemperature}°C ` +
            `mode=${Thermostat.SystemMode[systemMode] ?? systemMode}`);
    }
    // ── Mode mapping ────────────────────────────────────────────────────────────
    /** MELCloud Power + OperationMode → Matter Thermostat.SystemMode */
    melToMatterMode(power, opMode) {
        if (!power)
            return Thermostat.SystemMode.Off;
        switch (opMode) {
            case 1 /* OperationMode.Heat */:
                return Thermostat.SystemMode.Heat;
            case 3 /* OperationMode.Cool */:
                return Thermostat.SystemMode.Cool;
            case 8 /* OperationMode.Auto */:
                return Thermostat.SystemMode.Auto;
            case 2 /* OperationMode.Dry */:
                return Thermostat.SystemMode.Dry;
            case 7 /* OperationMode.Fan */:
                return Thermostat.SystemMode.FanOnly;
            default:
                return Thermostat.SystemMode.Auto;
        }
    }
    /**
     * Matter Thermostat.SystemMode → MELCloud OperationMode.
     * The Off case is handled separately via the `Power` field.
     */
    matterToMelMode(mode) {
        switch (mode) {
            case Thermostat.SystemMode.Heat:
                return 1 /* OperationMode.Heat */;
            case Thermostat.SystemMode.Cool:
                return 3 /* OperationMode.Cool */;
            case Thermostat.SystemMode.Dry:
                return 2 /* OperationMode.Dry */;
            case Thermostat.SystemMode.FanOnly:
                return 7 /* OperationMode.Fan */;
            case Thermostat.SystemMode.Auto:
            default:
                return 8 /* OperationMode.Auto */;
        }
    }
    // ── Utility ─────────────────────────────────────────────────────────────────
    errorMsg(err) {
        return err instanceof Error ? err.message : String(err);
    }
}
//# sourceMappingURL=platform.js.map