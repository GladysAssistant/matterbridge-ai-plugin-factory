# matterbridge-ai-factory-ajax-systems

Matterbridge plugin exposing **Ajax Systems** alarm & automation devices (Hub, détecteurs, sirènes, relais, prises) over Matter, for control from Gladys Assistant and any Matter controller.

> ⚠️ The gRPC cloud path uses Ajax's **reverse-engineered mobile-app protocol** (ported from `aegis-hass`). It can change without notice. Security-critical: test arm/disarm and PIN handling carefully.

## Connection modes

| Mode | Description | Arm / disarm |
|------|-------------|--------------|
| `api` | Official Ajax REST API (`https://api.ajax.systems/api`), User or PRO token / email+password | ✅ |
| `grpc` | Mobile cloud gateway (`mobile-gw.prod.ajax.systems:443`), email + password + app label + 2FA | ✅ (vendor proto descriptors required for live streaming) |
| `sia` | Local **SIA DC-09** listener — hub pushes events over IP | ❌ (listen only) |

## Configuration

| Key | Description |
|-----|-------------|
| `mode` | `api` \| `grpc` \| `sia` |
| `email`, `password` | Ajax account credentials (api/grpc) |
| `appLabel` | App label for gRPC (`Ajax`, or co-branded like `ADT`) |
| `totp` | 2FA TOTP code if enabled |
| `apiToken` | User/PRO API token (alternative to email/password in api mode) |
| `armPin` | User PIN required to arm/disarm |
| `allowForceArm` | Allow arming with open detectors (advanced) |
| `siaPort`, `siaAccountId` | SIA listener port / account filter |
| `pollInterval` | API poll interval (s) |
| `exposeDemoDevices` | Expose a representative demo set without an account (testing) |
| `whiteList` / `blackList` | Filter exposed devices by name |

## Matter mapping

| Ajax | Matter |
|------|--------|
| Alarm panel (arm / away / night) | ModeSelect (Disarmed / Armed Away / Night) |
| Door / window (DoorProtect) | Contact Sensor |
| Motion (MotionProtect, MotionCam, CombiProtect) | Occupancy Sensor |
| Smoke / CO / heat (FireProtect) | Smoke/CO Alarm |
| Water leak (LeaksProtect) | Water Leak Detector |
| Glass break / tamper (GlassProtect) | Contact / Boolean State |
| Relay / WallSwitch / Socket | On/Off Outlet |
| Dimmer | Dimmable Light |
| Siren (HomeSiren / StreetSiren) | On/Off Outlet (trigger) |
| Hub power, device battery | Power Source (wired / battery) |
| Temperature | Temperature Measurement |

No video stream for MotionCam (Matter limitation).

## Limitations

- No public local API in gRPC mode — cloud required.
- gRPC live data requires the vendor protobuf descriptors (not redistributed); the secure channel and auth plumbing are in place.
- SIA is local but cannot control the alarm.

## Build & test

```bash
npm install
npm link matterbridge
npm run build
matterbridge -add .
matterbridge -bridge
```

Apache-2.0
