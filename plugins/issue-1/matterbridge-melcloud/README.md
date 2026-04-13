# matterbridge-melcloud

A [Matterbridge](https://github.com/Luligu/matterbridge) dynamic-platform plugin that exposes **Mitsubishi Electric MELCloud air-to-air (ATA) devices** to the Matter ecosystem.

Each AC unit is represented as a **Matter Thermostat** endpoint, making it controllable from any Matter-compatible home hub (Apple Home, Google Home, Amazon Alexa, Home Assistant Matter, etc.).

---

## Features

| Capability | Matter cluster / attribute |
|---|---|
| Power on / off | `Thermostat` → `SystemMode = Off / previous-mode` |
| Heating mode | `Thermostat` → `SystemMode = Heat` |
| Cooling mode | `Thermostat` → `SystemMode = Cool` |
| Auto mode | `Thermostat` → `SystemMode = Auto` |
| Dry / Fan modes | `Thermostat` → `SystemMode = Dry / FanOnly` |
| Target temperature | `Thermostat` → `OccupiedHeatingSetpoint` / `OccupiedCoolingSetpoint` |
| Room temperature (read-only) | `Thermostat` → `LocalTemperature` |

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | ≥ 20.19.0 |
| Matterbridge | ≥ 1.6.0 |
| MELCloud account | Any active account with paired devices |

---

## Installation

### Via Matterbridge UI (recommended)

1. Open the Matterbridge web UI.
2. Go to **Plugins → Install plugin**.
3. Search for `matterbridge-melcloud` and install.

### Manual / npm

```bash
# Global installation alongside Matterbridge
npm install -g matterbridge-melcloud

# Register the plugin
matterbridge -add matterbridge-melcloud
```

---

## Configuration

After installation, open the plugin settings in the Matterbridge UI or edit your `matterbridge-melcloud.config.json` file:

```json
{
  "name": "MELCloud",
  "type": "DynamicPlatform",
  "username": "you@example.com",
  "password": "your-melcloud-password",
  "pollingInterval": 60,
  "debug": false
}
```

### Configuration options

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `username` | string | ✅ | — | MELCloud account e-mail |
| `password` | string | ✅ | — | MELCloud account password |
| `pollingInterval` | integer | | `60` | State polling interval in seconds (min 30) |
| `debug` | boolean | | `false` | Enable verbose debug logging |

> **Note:** Credentials are stored in the Matterbridge plugin configuration file. Use a dedicated MELCloud account or keep the config file secure.

---

## How it works

```
Matter Controller
      │
      │  Matter protocol (TCP/IP)
      ▼
  Matterbridge
      │
      │  matterbridge-melcloud plugin
      ▼
 MELCloud REST API
  (app.melcloud.com)
      │
      │  Cloud connection
      ▼
Mitsubishi AC units
```

1. On startup the plugin authenticates with the MELCloud cloud service.
2. All ATA (air-to-air) devices found in the account are registered as Matter Thermostat endpoints.
3. The plugin polls MELCloud every `pollingInterval` seconds and pushes updates to the Matter attributes.
4. When a Matter controller changes a thermostat attribute (mode, setpoint) the plugin immediately forwards the command to MELCloud.

---

## Mode mapping

| MELCloud mode | Matter SystemMode |
|---|---|
| Power off | `Off` (0) |
| Heat (1) | `Heat` (4) |
| Cool (3) | `Cool` (3) |
| Auto (8) | `Auto` (1) |
| Dry (2) | `Dry` (8) |
| Fan (7) | `FanOnly` (7) |

---

## Troubleshooting

### Plugin fails to start with "username and password are required"

Ensure both `username` and `password` are filled in the plugin configuration.

### Login error `ErrorId=1`

Incorrect credentials. Verify your username/password in the MELCloud mobile app or at [https://app.melcloud.com](https://app.melcloud.com).

### Login error `ErrorId=6`

Your account has been temporarily locked after too many failed login attempts. Wait 15–30 minutes and try again.

### Devices not appearing in Matter

- Check that your AC units are online in the MELCloud app.
- Enable `debug: true` and check Matterbridge logs for discovery errors.
- Only ATA (air-to-air) units are supported – ATW (air-to-water) and ERV units are not.

### Temperature changes have no effect

MELCloud commands may be silently ignored if the unit is in a protection state (e.g., defrost). Check the MELCloud app to see if the unit is responsive.

### High polling frequency / rate limiting

MELCloud does not publicly document rate limits, but rapid polling can result in temporary 429 errors. Keep `pollingInterval` at 60 seconds or higher.

---

## Development

```bash
git clone https://github.com/your-org/matterbridge-melcloud.git
cd matterbridge-melcloud
npm install
npm run build

# Link into a local Matterbridge install for testing
npm link
matterbridge -add matterbridge-melcloud
```

### Project structure

```
src/
  index.ts       – Plugin entry point (initializePlugin factory)
  platform.ts    – MatterbridgeDynamicPlatform implementation
  melcloudApi.ts – MELCloud REST API client
```

---

## Known limitations

- Only **ATA (air-to-air)** devices are supported. ATW heat-pump boilers and ERV ventilation units are detected and skipped.
- The plugin requires an active **internet connection** to the MELCloud cloud service. Local-only control is not possible with the current MELCloud API.
- Vane direction (horizontal / vertical) and fan-speed controls are not exposed in Matter (no standard cluster maps to them).
- The plugin does not support **multiple MELCloud accounts** in a single instance. Add a second plugin instance for a second account.

---

## License

MIT © Matterbridge Plugin Factory
