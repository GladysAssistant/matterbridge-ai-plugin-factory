/**
 * MELCloud API client for Mitsubishi Electric air conditioning devices.
 */
const MELCLOUD_BASE = 'https://app.melcloud.com/Mitsubishi.Wifi.Client';
const APP_VERSION = '1.19.1.1';
export class MelCloudClient {
    contextKey = null;
    headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
    };
    async login(email, password) {
        const response = await fetch(`${MELCLOUD_BASE}/Login/ClientLogin`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
                Email: email,
                Password: password,
                Language: 0,
                AppVersion: APP_VERSION,
                Persist: true,
                CaptchaResponse: null,
            }),
        });
        if (!response.ok) {
            throw new Error(`MELCloud login failed: HTTP ${response.status}`);
        }
        const data = (await response.json());
        if (data.ErrorId !== null && data.ErrorId !== 0) {
            throw new Error(`MELCloud login error: ${data.ErrorMessage ?? 'Unknown error'}`);
        }
        const contextKey = data.LoginData?.ContextKey;
        if (!contextKey) {
            throw new Error('MELCloud login did not return a ContextKey');
        }
        this.contextKey = contextKey;
    }
    isLoggedIn() {
        return this.contextKey !== null;
    }
    getAuthHeaders() {
        return {
            ...this.headers,
            'X-MitsContextKey': this.contextKey ?? '',
        };
    }
    async listDevices() {
        const response = await fetch(`${MELCLOUD_BASE}/User/ListDevices`, {
            headers: this.getAuthHeaders(),
        });
        if (!response.ok) {
            throw new Error(`MELCloud ListDevices failed: HTTP ${response.status}`);
        }
        const buildings = (await response.json());
        const devices = [];
        const collectDevices = (list) => {
            for (const d of list ?? []) {
                if (d.DeviceID !== undefined)
                    devices.push(d);
            }
        };
        for (const building of buildings ?? []) {
            collectDevices(building.Devices);
            for (const area of building.Areas ?? [])
                collectDevices(area.Devices);
            for (const floor of building.Floors ?? []) {
                collectDevices(floor.Devices);
                for (const area of floor.Areas ?? [])
                    collectDevices(area.Devices);
            }
        }
        return devices;
    }
    async getDeviceState(deviceId, buildingId) {
        const url = `${MELCLOUD_BASE}/Device/Get?id=${deviceId}&buildingID=${buildingId}`;
        const response = await fetch(url, { headers: this.getAuthHeaders() });
        if (!response.ok) {
            throw new Error(`MELCloud Device/Get failed: HTTP ${response.status}`);
        }
        return (await response.json());
    }
    async setDeviceState(deviceId, buildingId, update) {
        const current = await this.getDeviceState(deviceId, buildingId);
        const payload = {
            ...current,
            ...update,
            HasPendingCommand: true,
        };
        const response = await fetch(`${MELCLOUD_BASE}/Device/SetAta`, {
            method: 'POST',
            headers: this.getAuthHeaders(),
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            throw new Error(`MELCloud Device/SetAta failed: HTTP ${response.status}`);
        }
    }
    async setPower(deviceId, buildingId, power) {
        await this.setDeviceState(deviceId, buildingId, {
            Power: power,
            EffectiveFlags: 1,
        });
    }
    async setOperationMode(deviceId, buildingId, mode) {
        await this.setDeviceState(deviceId, buildingId, {
            OperationMode: mode,
            EffectiveFlags: 6,
        });
    }
    async setTemperature(deviceId, buildingId, temperature) {
        await this.setDeviceState(deviceId, buildingId, {
            SetTemperature: temperature,
            EffectiveFlags: 4,
        });
    }
}
// MELCloud OperationMode <-> Matter Thermostat.SystemMode mapping
// MELCloud: 1=Heat, 2=Dry, 3=Cool, 7=Fan, 8=Auto
// Matter:   0=Off,  1=Auto, 3=Cool, 4=Heat
export const melcloudModeToMatter = {
    1: 4, // Heat
    3: 3, // Cool
    8: 1, // Auto
};
export const matterModeToMelcloud = {
    1: 8, // Auto
    3: 3, // Cool
    4: 1, // Heat
};
//# sourceMappingURL=melcloud.js.map