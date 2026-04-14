/**
 * MELCloud API client for Mitsubishi Electric cloud service.
 */
const MELCLOUD_ENDPOINT = 'https://app.melcloud.com/Mitsubishi.Wifi.Client';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/109.0',
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
};
// EffectiveFlags for SetAta
export const FLAG_POWER = 0x01;
export const FLAG_OPERATION_MODE = 0x02;
export const FLAG_SET_TEMPERATURE = 0x04;
// MELCloud OperationMode values
export var MelCloudMode;
(function (MelCloudMode) {
    MelCloudMode[MelCloudMode["Heat"] = 1] = "Heat";
    MelCloudMode[MelCloudMode["Dry"] = 2] = "Dry";
    MelCloudMode[MelCloudMode["Cool"] = 3] = "Cool";
    MelCloudMode[MelCloudMode["Fan"] = 7] = "Fan";
    MelCloudMode[MelCloudMode["Auto"] = 8] = "Auto";
})(MelCloudMode || (MelCloudMode = {}));
export class MelCloudApi {
    contextKey = null;
    async login(email, password) {
        const response = await fetch(`${MELCLOUD_ENDPOINT}/Login/ClientLogin`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({
                Email: email,
                Password: password,
                Language: 0,
                AppVersion: '1.30.5.0',
                Persist: true,
                CaptchaChallenge: '',
                CaptchaResponse: '',
            }),
        });
        if (!response.ok)
            throw new Error(`MELCloud login HTTP error: ${response.status}`);
        const data = (await response.json());
        if (data.ErrorId !== null && data.ErrorId !== 0)
            throw new Error(`MELCloud login error: ErrorId=${data.ErrorId}`);
        if (!data.LoginData?.ContextKey)
            throw new Error('MELCloud login failed: no ContextKey');
        this.contextKey = data.LoginData.ContextKey;
    }
    authHeaders() {
        return { ...HEADERS, 'X-MitsContextKey': this.contextKey ?? '' };
    }
    async listDevices() {
        const response = await fetch(`${MELCLOUD_ENDPOINT}/User/ListDevices`, {
            headers: this.authHeaders(),
        });
        if (!response.ok)
            throw new Error(`ListDevices HTTP error: ${response.status}`);
        const buildings = (await response.json());
        const devices = [];
        for (const building of buildings) {
            const s = building.Structure;
            for (const d of s.Devices ?? [])
                devices.push({ ...d, BuildingID: building.ID });
            for (const area of s.Areas ?? [])
                for (const d of area.Devices ?? [])
                    devices.push({ ...d, BuildingID: building.ID });
            for (const floor of s.Floors ?? []) {
                for (const d of floor.Devices ?? [])
                    devices.push({ ...d, BuildingID: building.ID });
                for (const area of floor.Areas ?? [])
                    for (const d of area.Devices ?? [])
                        devices.push({ ...d, BuildingID: building.ID });
            }
        }
        return devices;
    }
    async getDeviceState(deviceId, buildingId) {
        const response = await fetch(`${MELCLOUD_ENDPOINT}/Device/Get?id=${deviceId}&buildingID=${buildingId}`, {
            headers: this.authHeaders(),
        });
        if (!response.ok)
            throw new Error(`GetDevice HTTP error: ${response.status}`);
        return (await response.json());
    }
    async setDeviceState(state) {
        const response = await fetch(`${MELCLOUD_ENDPOINT}/Device/SetAta`, {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify({ ...state, HasPendingCommand: true }),
        });
        if (!response.ok)
            throw new Error(`SetAta HTTP error: ${response.status}`);
    }
}
//# sourceMappingURL=melcloudApi.js.map