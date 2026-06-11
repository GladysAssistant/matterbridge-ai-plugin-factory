/**
 * Minimal type declarations for the `august-connect` package (no bundled types).
 *
 * @file august-connect.d.ts
 * @license Apache-2.0
 */
declare module 'august-connect' {
  /** August cloud credentials passed as `config` to every call. */
  export interface AugustConfig {
    apiKey: string;
    installID: string;
    augustID: string;
    IDType: 'email' | 'phone';
    password: string;
  }

  /** Common parameters accepted by every august-connect method. */
  export interface AugustParams {
    config?: AugustConfig;
    lockID?: string;
    code?: string | number;
    token?: string;
    [key: string]: unknown;
  }

  /** Status payload returned by `status()`. */
  export interface AugustStatus {
    status?: string;
    doorState?: string;
    [key: string]: unknown;
  }

  /** Details payload returned by `details()`. */
  export interface AugustDetails {
    LockName?: string;
    SerialNumber?: string;
    battery?: number;
    LockStatus?: { status?: string; doorState?: string };
    [key: string]: unknown;
  }

  /** Map of lockID -> lock info returned by `locks()`. */
  export type AugustLocks = Record<string, unknown>;

  export function authorize(params?: AugustParams): Promise<string | void>;
  export function validate(params?: AugustParams): Promise<string | void>;
  export function locks(params?: AugustParams): Promise<AugustLocks>;
  export function status(params?: AugustParams): Promise<AugustStatus>;
  export function details(params?: AugustParams): Promise<AugustDetails>;
  export function lock(params?: AugustParams): Promise<unknown>;
  export function unlock(params?: AugustParams): Promise<unknown>;

  const august: {
    authorize: typeof authorize;
    validate: typeof validate;
    locks: typeof locks;
    status: typeof status;
    details: typeof details;
    lock: typeof lock;
    unlock: typeof unlock;
  };
  export default august;
}
