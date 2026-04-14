/**
 * Matterbridge MELCloud Plugin
 * Integrates Mitsubishi MELCloud air conditioners and heat pumps with Matter.
 *
 * @file module.ts
 */
import { MatterbridgeDynamicPlatform, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
type MatterbridgeLog = ConstructorParameters<typeof MatterbridgeDynamicPlatform>[1];
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: MatterbridgeLog, config: PlatformConfig): MelCloudPlatform;
export declare class MelCloudPlatform extends MatterbridgeDynamicPlatform {
    private client;
    private pollInterval;
    private deviceMap;
    constructor(matterbridge: PlatformMatterbridge, log: MatterbridgeLog, config: PlatformConfig);
    onStart(reason?: string): Promise<void>;
    onConfigure(): Promise<void>;
    onShutdown(reason?: string): Promise<void>;
    private discoverDevices;
    private pollDevices;
}
export {};
//# sourceMappingURL=module.d.ts.map