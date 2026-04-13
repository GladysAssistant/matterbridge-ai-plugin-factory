/**
 * MelCloud REST API client for Mitsubishi Electric air conditioning units.
 *
 * Implements the MELCloud Classic API used by the official app.
 * Base URL: https://app.melcloud.com/Mitsubishi.Wifi.Client
 */
export declare const MELCLOUD_BASE_URL = "https://app.melcloud.com/Mitsubishi.Wifi.Client";
export declare const APP_VERSION = "1.32.1.0";
/** ATA (air-to-air) device operation modes, matching MELCloud numeric values. */
export declare const enum OperationMode {
    Heat = 1,
    Dry = 2,
    Cool = 3,
    Fan = 7,
    Auto = 8
}
/** MELCloud device types. This plugin only handles ATA (0). */
export declare const enum DeviceType {
    Ata = 0,
    Atw = 1,
    Erv = 3
}
export interface MelCloudCredentials {
    username: string;
    password: string;
}
/**
 * Represents the full state of an ATA device as returned by the MELCloud API.
 * Only the fields relevant to this plugin are typed; extra fields are preserved
 * verbatim so that SetAta round-trips work correctly.
 */
export interface AtaDeviceState {
    DeviceID: number;
    DeviceName: string;
    BuildingID: number;
    /** Whether the unit is powered on. */
    Power: boolean;
    /** Current operation mode (heat / cool / dry / fan / auto). */
    OperationMode: OperationMode;
    /** Target temperature set by the user (°C). */
    SetTemperature: number;
    /** Actual room temperature measured by the unit (°C, read-only). */
    RoomTemperature: number;
    /** Actual outdoor temperature (°C, read-only). */
    OutdoorTemperature?: number;
    ActualFanSpeed?: number;
    FanSpeed?: number;
    VaneHorizontal?: number;
    VaneVertical?: number;
    /** Must be `true` when sending a SetAta request. */
    HasPendingCommand?: boolean;
    [key: string]: unknown;
}
export declare class MelCloudClient {
    private readonly http;
    private contextKey;
    constructor();
    /**
     * Authenticates with MELCloud and stores the ContextKey for subsequent calls.
     * Throws an error if credentials are wrong or the server returns an error code.
     */
    login(credentials: MelCloudCredentials): Promise<void>;
    /**
     * Returns all ATA (air-to-air) devices registered in the MELCloud account.
     * The function traverses the full building / floor / area hierarchy.
     */
    listAtaDevices(): Promise<AtaDeviceState[]>;
    /**
     * Sends an updated state to MELCloud for a single ATA device.
     *
     * @param currentState - The last known full state of the device (used for round-trip safety).
     * @param updates      - Partial state containing only the fields to change.
     * @returns            The acknowledged device state from the server.
     */
    setAtaValues(currentState: AtaDeviceState, updates: Partial<AtaDeviceState>): Promise<AtaDeviceState>;
    private assertAuthenticated;
    private extractAllDevices;
}
//# sourceMappingURL=melcloudApi.d.ts.map