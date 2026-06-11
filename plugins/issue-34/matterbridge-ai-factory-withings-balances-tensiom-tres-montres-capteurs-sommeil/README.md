# matterbridge-ai-factory-withings-balances-tensiom-tres-montres-capteurs-sommeil

Matterbridge plugin exposing **Withings** cloud devices as **read-only Matter sensors**.

Supported devices and metrics:

| Withings device | Metrics → Matter cluster |
| --- | --- |
| Scale / Balance (Body+, Body Cardio) | Weight → FlowMeasurement · Fat ratio → RelativeHumidity · Muscle mass → FlowMeasurement · Heart rate → FlowMeasurement · Body temp → TemperatureMeasurement |
| Blood pressure monitor (BPM) | Systolic/Diastolic → PressureMeasurement · Heart rate → FlowMeasurement |
| Thermo | Body temperature → TemperatureMeasurement |
| Sleep / Aura | Sleep duration → FlowMeasurement · Sleep quality → RelativeHumidity · Room temp → TemperatureMeasurement |
| Watches (Steel, ScanWatch) | Heart rate → FlowMeasurement · SpO2 → RelativeHumidity |

> Matter has no native body-metric clusters, so non-temperature/pressure metrics are mapped best-effort onto the closest measurement cluster. All devices are read-only sensors — no remote control. Health values are never logged.

## Setup (OAuth2 Authorization Code)

1. Create an app at https://developer.withings.com/.
2. Run the OAuth2 Authorization Code flow with scopes `user.metrics,user.activity,user.sleepevents`.
3. Fill the plugin config: `clientId`, `clientSecret`, `refreshToken`. The `accessToken` is obtained and refreshed automatically.

## Config

| Key | Description |
| --- | --- |
| `clientId` / `clientSecret` | Withings app credentials |
| `refreshToken` | OAuth2 refresh token |
| `accessToken` | Optional; auto-managed |
| `pollInterval` | Cloud poll interval in minutes (min 5, default 15) |

## Build & test

```bash
npm install
npm link matterbridge
npm run build
matterbridge -add .
matterbridge -bridge
```
