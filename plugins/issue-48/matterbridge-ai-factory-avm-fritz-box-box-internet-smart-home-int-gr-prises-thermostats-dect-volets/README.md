# matterbridge-ai-factory-avm-fritz-box-box-internet-smart-home-int-gr-prises-thermostats-dect-volets

Matterbridge dynamic platform plugin for **AVM FRITZ!Box** integrated DECT smart home.
Connects via the **AHA-HTTP interface** (`homeautoswitch.lua`) with session login
(PBKDF2 / legacy MD5 challenge-response).

## Supported devices

| FRITZ!DECT | Matter device |
|------------|---------------|
| 200 / 210 (plug) | On/Off Outlet + Electrical Power/Energy Measurement |
| 500 (lamp) | Dimmable / Color-Temperature Light |
| 301 (thermostat) | Thermostat (heating) + Temperature, valve battery |
| 440 (sensor) | Temperature + Humidity + Contact |
| 400 / 440 (repeater + sensor) | Temperature / Humidity |
| Roller shutter (DECT) | Window Covering (lift 0–100 %) |

## Configuration

```json
{
  "name": "matterbridge-ai-factory-avm-fritz-box-box-internet-smart-home-int-gr-prises-thermostats-dect-volets",
  "type": "DynamicPlatform",
  "host": "192.168.1.1",
  "username": "",
  "password": "fritzbox_password",
  "pollInterval": 60
}
```

- `host` — IP / hostname of the FRITZ!Box (`fritz.box` or `192.168.1.1`).
- `username` — FRITZ!Box user (leave empty for password-only boxes).
- `password` — password of a user with **Smart Home** permission.
- `pollInterval` — state refresh interval in seconds (min 15).

## Notes

- Requires AVM DECT devices (no third-party Zigbee/Wi-Fi).
- Uses only Node built-ins (`crypto`, `fetch`) plus `fast-xml-parser`.
- Energy: power in W, cumulative energy in Wh; thermostat setpoint and roller-shutter
  position are writable from Matter controllers.
