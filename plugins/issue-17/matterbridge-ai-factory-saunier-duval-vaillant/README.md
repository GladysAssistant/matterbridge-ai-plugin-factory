# matterbridge-ai-factory-saunier-duval-vaillant

Matterbridge dynamic platform plugin for **Saunier Duval / Vaillant** heating systems via the myVAILLANT / MiGo Link cloud (the same API used by the myVAILLANT app, `mypyllant` and `iobroker.vaillant`).

## Features

Per heating **zone** it exposes a Matter **thermostat**:

| Capability | Matter mapping |
|---|---|
| Inside temperature | `Thermostat.localTemperature` |
| Setpoint temperature (read/write) | `Thermostat.occupiedHeatingSetpoint` |
| Humidity | `RelativeHumidityMeasurement.measuredValue` |
| Outside temperature | dedicated `temperatureSensor` device per system |
| Status: off / program / manual / away | `Thermostat.systemMode` → Off / Auto / Heat (away shown as Off) |
| Turn off | systemMode → Off → `OFF` |
| Turn on program mode | systemMode → Auto → `TIME_CONTROLLED` |
| Turn on manual mode | systemMode → Heat → `MANUAL` |
| Change setpoint | write `occupiedHeatingSetpoint` → `manual-mode-setpoint` |

State is refreshed every `pollInterval` seconds.

## Configuration

Open the plugin config page in the Matterbridge frontend and fill in:

- **username / password** – your myVAILLANT / MiGo Link app credentials
- **country** – lowercase English name (e.g. `germany`, `france`, `spain`)
- **brand** – `vaillant`, `sdbg` (Saunier Duval), `bulex`, `glow-worm`, `demirdokum`
- **pollInterval** – refresh interval in seconds (min 60, default 300)

## Notes

The cloud API is rate limited; keep the poll interval reasonable. Authentication uses the Keycloak OAuth PKCE flow against `identity.vaillant-group.com`; credentials stay inside your Matterbridge instance.
