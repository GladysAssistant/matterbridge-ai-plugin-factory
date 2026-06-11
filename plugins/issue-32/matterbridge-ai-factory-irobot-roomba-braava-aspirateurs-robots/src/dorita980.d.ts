/**
 * Minimal type declarations for the dorita980 iRobot local MQTT client.
 *
 * @file dorita980.d.ts
 * @license Apache-2.0
 */
declare module 'dorita980' {
  /** Subset of the robot state reported over local MQTT. */
  export interface RobotState {
    batPct?: number;
    bin?: { present?: boolean; full?: boolean };
    cleanMissionStatus?: {
      cycle?: string;
      phase?: string;
      error?: number;
      mssnM?: number;
      sqft?: number;
      expireM?: number;
      rechrgM?: number;
    };
    [key: string]: unknown;
  }

  /** Local MQTT client returned by Local(). */
  export interface RobotLocal {
    on(event: 'connect' | 'close' | 'offline', listener: () => void): RobotLocal;
    on(event: 'state' | 'update' | 'mission', listener: (data: RobotState) => void): RobotLocal;
    on(event: 'error', listener: (error: Error) => void): RobotLocal;
    removeAllListeners(): void;
    end(): void;
    getRobotState(fields: string[]): Promise<RobotState>;
    start(): Promise<unknown>;
    clean(): Promise<unknown>;
    cleanRoom(args: unknown): Promise<unknown>;
    pause(): Promise<unknown>;
    stop(): Promise<unknown>;
    resume(): Promise<unknown>;
    dock(): Promise<unknown>;
    find(): Promise<unknown>;
  }

  export function Local(blid: string, password: string, ip: string, version?: number, interval?: number): RobotLocal;
  export function getRobotIP(cb: (error: Error | null, ip?: string) => void): void;
}
