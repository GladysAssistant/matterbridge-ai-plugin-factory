/**
 * matterbridge-melcloud – plugin entry point
 *
 * Matterbridge requires plugins to export a default `initializePlugin` factory
 * that receives the Matterbridge host, logger, and user config, and returns a
 * MatterbridgePlatform instance.
 */
import { MelCloudPlatform } from './platform.js';
export default function initializePlugin(matterbridge, log, config) {
    return new MelCloudPlatform(matterbridge, log, config);
}
//# sourceMappingURL=index.js.map