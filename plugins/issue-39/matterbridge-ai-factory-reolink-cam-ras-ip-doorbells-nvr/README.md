# <img src="https://matterbridge.io/assets/matterbridge.svg" alt="Matterbridge Logo" width="64px" height="64px">&nbsp;&nbsp;&nbsp;Matterbridge Reolink Plugin

[![powered by](https://img.shields.io/badge/powered%20by-matterbridge-blue)](https://www.npmjs.com/package/matterbridge)
[![powered by](https://img.shields.io/badge/powered%20by-node--ansi--logger-blue)](https://www.npmjs.com/package/node-ansi-logger)
[![powered by](https://img.shields.io/badge/powered%20by-node--persist--manager-blue)](https://www.npmjs.com/package/node-persist-manager)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![ESM](https://img.shields.io/badge/ESM-Node.js-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

`matterbridge-ai-factory-reolink-cam-ras-ip-doorbells-nvr` is a Matterbridge dynamic platform plugin that exposes **Reolink IP cameras, doorbells and NVR channels** as Matter sensors and switches. It does **not** stream video — instead it bridges the device's motion / AI detection state and its controllable accessories (spotlight, siren, IR LED) so they can be used in any Matter ecosystem (Apple Home, Google Home, Alexa, SmartThings, Home Assistant, etc.).

## How it works

The plugin talks to your Reolink device over its local **HTTP CGI API** (`/cgi-bin/api.cgi`), with no external dependencies and no cloud account required.

1. On startup it logs in with your username/password and receives a session token (auto-renewed before expiry).
2. It discovers the available channels via `GetChannelstatus` / `GetDevInfo`. A single camera reports one channel; an NVR reports one channel per connected camera. If discovery fails it falls back to the configured `channels` count.
3. For each channel it registers one composed Matter device (a bridged endpoint with child endpoints for each feature).
4. It then polls every channel on the configured `pollInterval` and pushes the latest state into the matching Matter attributes.
5. Commands from the Matter side (turn on the spotlight, sound the siren, switch the IR LED) are sent back to the device via the CGI API.

Self-signed HTTPS certificates used by Reolink devices are tolerated automatically.

## Features

Each Reolink channel is exposed as a single composed device with the following endpoints:

| Feature | Matter device type | Direction | Description |
| --- | --- | --- | --- |
| **Motion** | Occupancy Sensor (main endpoint) | Read | Reports the channel's basic motion-detection (`GetMdState`) as occupancy. |
| **Online status** | Boolean State (main endpoint) | Read | Reports whether the channel/camera is online and reachable. Set to offline if polling fails. |
| **Battery level** | Power Source (main endpoint) | Read | Battery percentage for battery-powered cameras/doorbells (`GetBatteryInfo`). |
| **Person detection** | Occupancy Sensor (child) | Read | AI person detection (`GetAiState`). |
| **Vehicle detection** | Occupancy Sensor (child) | Read | AI vehicle detection (`GetAiState`). |
| **Animal detection** | Occupancy Sensor (child) | Read | AI animal (dog/cat) detection (`GetAiState`). |
| **Spotlight** | On/Off Light (child) | Read / Write | Controls and reports the white-LED spotlight (`GetWhiteLed` / `SetWhiteLed`). |
| **Siren** | On/Off Switch (child) | Write | Triggers or stops the audible alarm (`AudioAlarmPlay`). |
| **IR LED** | On/Off Switch (child) | Read / Write | Controls and reports the infra-red night-vision LED (`GetIrLights` / `SetIrLights`). |

Detection and control features are gracefully ignored by devices that do not support them.

## Configuration

Configure the plugin from the Matterbridge frontend or by editing the config file.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | string | `192.168.1.100` | Reolink camera or NVR IP address / hostname. |
| `username` | string | `admin` | Reolink account username. |
| `password` | string | `` | Reolink account password. |
| `useHttps` | boolean | `true` | Connect over HTTPS (recommended). |
| `port` | number | `443` | HTTP/HTTPS port (`80` or `443` by default). |
| `channels` | number | `1` | Number of channels to expose if discovery fails (NVR / multi-channel). |
| `pollInterval` | number | `30` | How often to poll device state, in seconds (minimum 10). |
| `whiteList` | string[] | `[]` | If not empty, only the listed devices are exposed. |
| `blackList` | string[] | `[]` | The listed devices are never exposed. |
| `debug` | boolean | `false` | Enable verbose debug logging. |
| `unregisterOnShutdown` | boolean | `false` | Unregister all devices on shutdown (debugging only). |

## Installation

Install through the Matterbridge frontend, or from the command line:

```bash
npm install -g matterbridge-ai-factory-reolink-cam-ras-ip-doorbells-nvr
matterbridge -add matterbridge-ai-factory-reolink-cam-ras-ip-doorbells-nvr
```

Then set your `host`, `username` and `password` in the plugin configuration and restart Matterbridge.

## License

Apache-2.0
