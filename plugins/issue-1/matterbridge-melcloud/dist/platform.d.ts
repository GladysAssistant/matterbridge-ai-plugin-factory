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
import { MatterbridgeDynamicPlatform } from 'matterbridge';
import type { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
/**
 * Derive the correct AnsiLogger type from Matterbridge's own constructor
 * to avoid a dual-package hazard with node-ansi-logger.
 */
type MatterbridgeLog = ConstructorParameters<typeof MatterbridgeDynamicPlatform>[1];
export declare class MelCloudPlatform extends MatterbridgeDynamicPlatform {
    private readonly melConfig;
    private readonly client;
    /** deviceId → DeviceContext */
    private readonly contexts;
    private pollingTimer;
    constructor(matterbridge: PlatformMatterbridge, log: MatterbridgeLog, config: PlatformConfig);
    onStart(reason?: string): Promise<void>;
    onConfigure(): Promise<void>;
    onShutdown(reason?: string): Promise<void>;
    private discoverDevices;
    private registerAtaDevice;
    private attachHandlers;
    /** Translates a Matter SystemMode write into MELCloud API calls. */
    private sendSystemMode;
    /** Sends a new target temperature (°C) to MELCloud. */
    private sendSetTemperature;
    private pollDevices;
    /**
     * Pushes fresh MELCloud state into the Matter thermostat cluster attributes.
     *
     * Note: `setAttribute` for thermostat attributes expects raw cluster values:
     *  - temperatures in **centidegrees** (0.01 °C), e.g. 23 °C = 2300
     *  - systemMode as a Thermostat.SystemMode enum number
     */
    private syncMatterAttributes;
    /** MELCloud Power + OperationMode → Matter Thermostat.SystemMode */
    private melToMatterMode;
    /**
     * Matter Thermostat.SystemMode → MELCloud OperationMode.
     * The Off case is handled separately via the `Power` field.
     */
    private matterToMelMode;
    private errorMsg;
}
export {};
//# sourceMappingURL=platform.d.ts.map