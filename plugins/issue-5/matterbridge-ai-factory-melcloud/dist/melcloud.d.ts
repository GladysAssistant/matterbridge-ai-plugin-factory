/**
 * MELCloud API client for Mitsubishi Electric air conditioning devices.
 */
export interface MelCloudDeviceInfo {
    DeviceID: number;
    BuildingID: number;
    DeviceName: string;
    Power: boolean;
    OperationMode: number;
    SetTemperature: number;
    RoomTemperature: number;
    MinTemperature: number;
    MaxTemperature: number;
    SerialNumber?: string;
}
export interface MelCloudListEntry {
    ID: number;
    Name: string;
    Devices: MelCloudDeviceInfo[];
    Areas: {
        Devices: MelCloudDeviceInfo[];
    }[];
    Floors: {
        Devices: MelCloudDeviceInfo[];
        Areas: {
            Devices: MelCloudDeviceInfo[];
        }[];
    }[];
}
export declare class MelCloudClient {
    private contextKey;
    private headers;
    login(email: string, password: string): Promise<void>;
    isLoggedIn(): boolean;
    private getAuthHeaders;
    listDevices(): Promise<MelCloudDeviceInfo[]>;
    getDeviceState(deviceId: number, buildingId: number): Promise<MelCloudDeviceInfo>;
    setDeviceState(deviceId: number, buildingId: number, update: Partial<MelCloudDeviceInfo> & {
        EffectiveFlags: number;
    }): Promise<void>;
    setPower(deviceId: number, buildingId: number, power: boolean): Promise<void>;
    setOperationMode(deviceId: number, buildingId: number, mode: number): Promise<void>;
    setTemperature(deviceId: number, buildingId: number, temperature: number): Promise<void>;
}
export declare const melcloudModeToMatter: Record<number, number>;
export declare const matterModeToMelcloud: Record<number, number>;
//# sourceMappingURL=melcloud.d.ts.map