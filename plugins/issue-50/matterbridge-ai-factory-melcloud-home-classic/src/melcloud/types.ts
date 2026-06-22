/**
 * Shared, API-agnostic types for the MELCloud Classic and MELCloud Home clients.
 *
 * @file types.ts
 * @license Apache-2.0
 */

/** The MELCloud application a user authenticated with. The two backends are mutually exclusive. */
export type MelcloudApp = 'classic' | 'home';

/** Air-to-Air (ATA) operation modes, normalized across both APIs. */
export type AtaMode = 'auto' | 'heat' | 'cool' | 'fan' | 'dry';

/**
 * A device exposed by MELCloud, normalized so the Matterbridge platform never
 * needs to know which backend produced it.
 *
 * Air-to-Water (ATW) and unknown devices are still surfaced (autodiscovery)
 * with `supported: false` so they appear in the frontend select list, but no
 * Matter endpoint is built for them in this MVP.
 */
export interface MelcloudDevice {
  /** Stable unique id, e.g. `classic-12345` or `home-<uuid>`. */
  readonly id: string;
  /** Human readable device name. */
  readonly name: string;
  /** Serial number used for Matter Basic Information. */
  readonly serial: string;
  /** Device family. Only `ata` is controllable in this MVP. */
  readonly type: 'ata' | 'atw' | 'unknown';
  /** Whether a Matter endpoint should be created for this device. */
  readonly supported: boolean;
  /** Current ATA state (present only for `type === 'ata'`). */
  readonly ata?: AtaState;
}

/** Live, normalized state of an ATA device. */
export interface AtaState {
  power: boolean;
  /** Measured room (internal) temperature in °C. */
  roomTemperature: number;
  /** Target setpoint temperature in °C. */
  setTemperature: number;
  mode: AtaMode;
  /** 0 = auto, 1..numberOfFanSpeeds. */
  fanSpeed: number;
  numberOfFanSpeeds: number;
  /** Vertical vane is sweeping (swing). */
  vaneVerticalSwing: boolean;
  /** Horizontal vane is sweeping (swing). */
  vaneHorizontalSwing: boolean;
  minSetpoint: number;
  maxSetpoint: number;
}

/** Partial ATA update sent to a backend. Only provided fields are changed. */
export interface AtaPatch {
  power?: boolean;
  setTemperature?: number;
  mode?: AtaMode;
  fanSpeed?: number;
  vaneVerticalSwing?: boolean;
  vaneHorizontalSwing?: boolean;
}

/** Common surface implemented by both the Classic and Home clients. */
export interface MelcloudClient {
  readonly app: MelcloudApp;
  /** Authenticate and obtain a session. Throws on invalid credentials. */
  login(): Promise<void>;
  /** List every device (supported and unsupported) for autodiscovery. */
  listDevices(): Promise<MelcloudDevice[]>;
  /** Apply a partial update to an ATA device. */
  setAta(device: MelcloudDevice, patch: AtaPatch): Promise<void>;
}
