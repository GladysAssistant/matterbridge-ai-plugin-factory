# matterbridge-ai-factory-yoto-player-cloud-api

Matterbridge plugin that bridges **Yoto Player** devices to Matter using the
Yoto cloud API.

## What it exposes per player

Each Yoto Player becomes six bridged Matter accessories:

| Accessory          | Device type          | Maps to Yoto                                                |
| ------------------ | -------------------- | ----------------------------------------------------------- |
| _Name_ Player      | Dimmable Light       | On/Off = play/pause, Brightness = user volume (0-100)       |
|                    | + Power Source       | `batteryLevelPercentage`, `isCharging`, `isOnline`          |
| _Name_ Nightlight  | Extended Color Light | `nightlightMode` (hex color / off)                          |
| _Name_ Temperature | Temperature Sensor   | `temperatureCelcius`                                        |
| _Name_ Ambient     | Light Sensor         | `ambientLightSensorReading`                                 |
| _Name_ Card        | Contact Sensor       | `cardInsertionState > 0` (card inserted, physical or remote)|
| _Name_ Day Mode    | On/Off Switch        | `dayMode` (on = day, off = night)                           |

## Configuration

```jsonc
{
  "name": "matterbridge-ai-factory-yoto-player-cloud-api",
  "type": "DynamicPlatform",
  "clientId": "matterbridge-yoto",
  "useMqtt": true,
  "pollingIntervalSeconds": 30,
  "whiteList": [],
  "blackList": []
}
```

`accessToken`, `refreshToken` and `tokenExpiresAt` are managed automatically
after the first authorization.

## Authentication

On first start the plugin prints:

```
============================================================
Yoto authorization required
  1. Visit: https://api.yotoplay.com/device/auth?code=ABC-DEF-GHI
  2. Enter code: ABC-DEF-GHI
  Code expires in 300s
============================================================
```

Visit the URL in any browser, sign in with your Yoto account, and approve.
The plugin polls `POST /oauth/token` in the background; once you authorize,
tokens are persisted to the plugin config and the plugin continues startup.

Tokens are refreshed automatically before expiry, and any `401` from the
API also triggers a refresh + retry.

## Real-time updates

When `useMqtt` is enabled (default), the plugin connects to the Yoto AWS
IoT broker and subscribes to `device/<id>/data/status` and
`device/<id>/data/events`. A 5-minute polling heartbeat catches any missed
event. If MQTT is unavailable, the plugin falls back to polling
`GET /device-v2/{id}/status` every `pollingIntervalSeconds` seconds.

## Commands sent to Yoto

| Matter command                    | Yoto API call                                            |
| --------------------------------- | -------------------------------------------------------- |
| OnOff `on`                        | `POST /device-v2/{id}/command/status` `{cmd: play}`      |
| OnOff `off`                       | `POST /device-v2/{id}/command/status` `{cmd: pause}`     |
| LevelControl `moveToLevel`        | `POST /device-v2/{id}/config` `{volume: 0..100}`         |
| ColorControl `moveToHueAndSat`    | `POST /device-v2/{id}/config` `{nightlightMode: #RRGGBB}`|
| Nightlight OnOff `off`            | `POST /device-v2/{id}/config` `{nightlightMode: off}`    |
| Day Mode OnOff                    | `POST /device-v2/{id}/config` `{dayMode: 1 \| 0}`        |

## Building / testing

```bash
npm install
npm link matterbridge   # required so TS finds matterbridge types
npm run build
matterbridge -add .
matterbridge -bridge
```

## License

Apache-2.0.
