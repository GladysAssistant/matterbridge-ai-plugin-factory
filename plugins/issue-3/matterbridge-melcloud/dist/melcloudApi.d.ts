/**
 * MELCloud API client for Mitsubishi Electric cloud service.
 */
export declare const FLAG_POWER = 1;
export declare const FLAG_OPERATION_MODE = 2;
export declare const FLAG_SET_TEMPERATURE = 4;
export declare enum MelCloudMode {
    Heat = 1,
    Dry = 2,
    Cool = 3,
    Fan = 7,
    Auto = 8
}
export interface MelCloudDevice {
    DeviceID: number;
    DeviceName: string;
    BuildingID: number;
    Device: MelCloudDeviceState;
}
export interface MelCloudDeviceState {
    Power: boolean;
    OperationMode: MelCloudMode;
    SetTemperature: number;
    RoomTemperature: number;
    MinTempCoolDry: number;
    MaxTempCoolDry: number;
    MinTempHeat: number;
    MaxTempHeat: number;
    MinTempAutomatic: number;
    MaxTempAutomatic: number;
    DeviceType: number;
    HasPendingCommand?: boolean;
}
export declare class MelCloudApi {
    private contextKey;
    login(email: string, password: string): Promise<void>;
    private authHeaders;
    listDevices(): Promise<MelCloudDevice[]>;
    getDeviceState(deviceId: number, buildingId: number): Promise<MelCloudDeviceState>;
    setDeviceState(state: MelCloudDeviceState & {
        DeviceID: number;
        BuildingID: number;
    }): Promise<void>;
}
//# sourceMappingURL=melcloudApi.d.ts.map