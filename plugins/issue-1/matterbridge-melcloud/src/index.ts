/**
 * matterbridge-melcloud – plugin entry point
 *
 * Matterbridge requires plugins to export a default `initializePlugin` factory
 * that receives the Matterbridge host, logger, and user config, and returns a
 * MatterbridgePlatform instance.
 */

import { MatterbridgeDynamicPlatform, MatterbridgePlatform } from 'matterbridge';
import type { PlatformConfig, PlatformMatterbridge } from 'matterbridge';

import { MelCloudPlatform } from './platform.js';

/**
 * Using ConstructorParameters<> to derive the correct AnsiLogger type from
 * Matterbridge itself, avoiding a dual-package hazard that arises when the
 * plugin's top-level node-ansi-logger differs from Matterbridge's internal copy.
 */
type MatterbridgeLog = ConstructorParameters<typeof MatterbridgeDynamicPlatform>[1];

export default function initializePlugin(
  matterbridge: PlatformMatterbridge,
  log: MatterbridgeLog,
  config: PlatformConfig,
): MatterbridgePlatform {
  return new MelCloudPlatform(matterbridge, log, config);
}
