/**
 * MelCloud REST API client for Mitsubishi Electric air conditioning units.
 *
 * Implements the MELCloud Classic API used by the official app.
 * Base URL: https://app.melcloud.com/Mitsubishi.Wifi.Client
 */
import axios from 'axios';
// ─── Constants ───────────────────────────────────────────────────────────────
export const MELCLOUD_BASE_URL = 'https://app.melcloud.com/Mitsubishi.Wifi.Client';
export const APP_VERSION = '1.32.1.0';
// ─── Client ──────────────────────────────────────────────────────────────────
export class MelCloudClient {
    http;
    contextKey;
    constructor() {
        this.http = axios.create({
            baseURL: MELCLOUD_BASE_URL,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 matterbridge-melcloud',
            },
            timeout: 15_000,
        });
    }
    // ── Authentication ─────────────────────────────────────────────────────────
    /**
     * Authenticates with MELCloud and stores the ContextKey for subsequent calls.
     * Throws an error if credentials are wrong or the server returns an error code.
     */
    async login(credentials) {
        const response = await this.http.post('/Login/ClientLogin', {
            Username: credentials.username,
            Password: credentials.password,
            Language: 0,
            AppVersion: APP_VERSION,
            Persist: true,
            CaptchaResponse: null,
        });
        const { ErrorId, LoginData } = response.data;
        if (ErrorId !== null && ErrorId !== undefined) {
            const messages = {
                1: 'Invalid credentials',
                6: 'Account locked – too many failed attempts',
            };
            throw new Error(`MELCloud login error ${ErrorId}: ${messages[ErrorId] ?? 'Unknown error'}`);
        }
        this.contextKey = LoginData.ContextKey;
        this.http.defaults.headers['X-MitsContextKey'] = this.contextKey;
    }
    // ── Device discovery ───────────────────────────────────────────────────────
    /**
     * Returns all ATA (air-to-air) devices registered in the MELCloud account.
     * The function traverses the full building / floor / area hierarchy.
     */
    async listAtaDevices() {
        this.assertAuthenticated();
        const response = await this.http.get('/User/ListDevices');
        const buildings = response.data;
        const devices = [];
        for (const building of buildings) {
            const items = this.extractAllDevices(building);
            for (const item of items) {
                // Only handle ATA devices (DeviceType === 0).
                // We detect ATA by checking that RoomTemperature is present.
                if (item.Device?.RoomTemperature !== undefined) {
                    devices.push({
                        ...item.Device,
                        DeviceID: item.DeviceID,
                        DeviceName: item.DeviceName,
                        BuildingID: building.ID,
                    });
                }
            }
        }
        return devices;
    }
    // ── Device control ─────────────────────────────────────────────────────────
    /**
     * Sends an updated state to MELCloud for a single ATA device.
     *
     * @param currentState - The last known full state of the device (used for round-trip safety).
     * @param updates      - Partial state containing only the fields to change.
     * @returns            The acknowledged device state from the server.
     */
    async setAtaValues(currentState, updates) {
        this.assertAuthenticated();
        const payload = {
            ...currentState,
            ...updates,
            HasPendingCommand: true,
        };
        const response = await this.http.post('/Device/SetAta', payload);
        return response.data;
    }
    // ── Private helpers ────────────────────────────────────────────────────────
    assertAuthenticated() {
        if (!this.contextKey) {
            throw new Error('MelCloudClient: not authenticated – call login() first');
        }
    }
    extractAllDevices(building) {
        const items = [];
        const struct = building.Structure;
        const collect = (list = []) => items.push(...list);
        collect(struct.Devices);
        for (const area of struct.Areas ?? [])
            collect(area.Devices);
        for (const floor of struct.Floors ?? []) {
            collect(floor.Devices);
            for (const area of floor.Areas ?? [])
                collect(area.Devices);
        }
        return items;
    }
}
//# sourceMappingURL=melcloudApi.js.map