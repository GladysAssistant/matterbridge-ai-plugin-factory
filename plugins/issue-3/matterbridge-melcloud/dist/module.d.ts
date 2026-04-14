/**
 * matterbridge-melcloud - Matterbridge plugin for Mitsubishi MELCloud AC control
 *
 * Supports: On/Off, Set Temperature, AC Mode (Heat, Cool, Auto)
 */
import { MatterbridgeDynamicPlatform, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: any, config: PlatformConfig): MelCloudPlatform;
export declare class MelCloudPlatform extends MatterbridgeDynamicPlatform {
    private api;
    private pollIntervals;
    private deviceMap;
    constructor(matterbridge: PlatformMatterbridge, log: any, config: PlatformConfig);
    onStart(reason?: string): Promise<void>;
    onConfigure(): Promise<void>;
    onShutdown(reason?: string): Promise<void>;
    private discoverDevices;
    private sendCommand;
    private updateDeviceState;
    private startPolling;
}
//# sourceMappingURL=module.d.ts.map