/**
 * Shared types for the Ajax Systems Matterbridge plugin.
 *
 * @file types.ts
 * @license Apache-2.0
 */

import type { BasePlatformConfig } from 'matterbridge';

/** Connection mode used to talk to the Ajax installation. */
export type AjaxMode = 'grpc' | 'api' | 'sia';

/** Arm state of an Ajax hub or space. */
export type AjaxArmState = 'disarmed' | 'armed' | 'night';

/** Logical category an Ajax device is mapped to. */
export type AjaxDeviceKind =
  | 'hub'
  | 'panel'
  | 'door'
  | 'motion'
  | 'smoke'
  | 'leak'
  | 'glass'
  | 'tamper'
  | 'relay'
  | 'socket'
  | 'dimmer'
  | 'siren'
  | 'temperature'
  | 'unknown';

/** Normalized representation of an Ajax device, vendor-protocol agnostic. */
export interface AjaxDevice {
  /** Stable unique id (Ajax device id). */
  id: string;
  /** Human readable name. */
  name: string;
  /** Mapped logical kind. */
  kind: AjaxDeviceKind;
  /** Ajax hub/space this device belongs to. */
  hubId?: string;
  /** Raw model string (e.g. "DoorProtect", "Socket"). */
  model?: string;
  /** Boolean state for sensors (open/triggered/leak/on). */
  state?: boolean;
  /** Tamper triggered. */
  tamper?: boolean;
  /** Battery percentage 0..100. */
  battery?: number;
  /** Mains powered (hub / sockets). */
  mains?: boolean;
  /** Temperature in celsius if reported. */
  temperature?: number;
  /** Brightness 0..100 for dimmers. */
  brightness?: number;
  /** Number of on/off channels for multi-channel relays/sockets. */
  channels?: number;
}

/** Plugin configuration surfaced in the Matterbridge frontend. */
export type AjaxPlatformConfig = BasePlatformConfig & {
  whiteList: string[];
  blackList: string[];
  mode: AjaxMode;
  email?: string;
  password?: string;
  appLabel?: string;
  totp?: string;
  apiKey?: string;
  apiToken?: string;
  apiUserId?: string;
  apiBaseUrl?: string;
  grpcHost?: string;
  siaPort?: number;
  siaAccountId?: string;
  armPin?: string;
  allowForceArm?: boolean;
  pollInterval?: number;
  exposeDemoDevices?: boolean;
};
