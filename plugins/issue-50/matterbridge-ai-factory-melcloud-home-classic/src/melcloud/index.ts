/**
 * Factory for the MELCloud client matching the configured application.
 *
 * @file index.ts
 * @license Apache-2.0
 */

import type { AnsiLogger } from 'matterbridge/logger';

import { ClassicClient } from './classic-client.js';
import { HomeClient } from './home-client.js';
import type { MelcloudApp, MelcloudClient } from './types.js';

export type { AtaMode, AtaPatch, AtaState, MelcloudApp, MelcloudClient, MelcloudDevice } from './types.js';
export { ClassicClient } from './classic-client.js';
export { HomeClient } from './home-client.js';

/**
 * Create the client for the configured MELCloud application. The two backends
 * are mutually exclusive: an account configured with one app cannot use the
 * other.
 *
 * @param app - The selected MELCloud application.
 * @param username - Account email.
 * @param password - Account password.
 * @param log - Logger.
 * @returns The matching client.
 */
export function createMelcloudClient(app: MelcloudApp, username: string, password: string, log: AnsiLogger): MelcloudClient {
  return app === 'home' ? new HomeClient(username, password, log) : new ClassicClient(username, password, log);
}
