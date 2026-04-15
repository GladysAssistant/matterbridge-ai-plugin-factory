/**
 * Matterbridge MELCloud Plugin
 * Controls Mitsubishi Air Conditioning devices via MELCloud cloud API.
 *
 * Capabilities: On/Off, Temperature Setpoint, AC Mode (Heat/Cool/Auto)
 */
import { MatterbridgeDynamicPlatform, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): MelCloudPlatform;
export declare class MelCloudPlatform extends MatterbridgeDynamicPlatform {
    private client;
    private trackedDevices;
    private pollTimer;
    constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig);
    onStart(reason?: string): Promise<void>;
    onConfigure(): Promise<void>;
    onChangeLoggerLevel(logLevel: LogLevel): Promise<void>;
    onShutdown(reason?: string): Promise<void>;
    private discoverDevices;
    private registerMelCloudDevice;
    private pollDevices;
    private updateEndpoint;
}
//# sourceMappingURL=module.d.ts.map