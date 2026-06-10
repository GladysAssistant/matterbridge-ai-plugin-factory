# matterbridge-ai-factory-tp-link-kasa-tapo-plugs-switches-lights-dimmers-hubs

Matterbridge plugin for **TP-Link Kasa & Tapo** devices over local LAN.

## Supported

| TP-Link | Matter device | Capabilities |
|---|---|---|
| Plug / Switch (HS100, HS110, KP115, P100, P110…) | On/Off Plug-in Unit | on/off, energy (W, kWh) if supported |
| Dimmer (HS220) | Dimmable Light | on/off, brightness |
| Bulb (KL130, L510, L530…) | Dimmable / Color-Temp Light | on/off, brightness, color temp (Kasa CT bulbs) |
| Energy plugs (HS110, KP115, P110, P115) | + Electrical Power/Energy Measurement | power, energy, voltage |

- **Kasa** devices: local discovery + control via `tplink-smarthome-api` (no cloud).
- **Tapo** devices: local KLAP control via `tp-link-tapo-connect` — requires your TP-Link account email/password (used only locally for the KLAP handshake).

## Config

```json
{
  "username": "your-tplink-email",
  "password": "your-tplink-password",
  "enableKasaDiscovery": true,
  "discoveryTimeout": 5,
  "devices": [
    { "protocol": "tapo", "host": "192.168.1.50", "name": "Living Room Plug" },
    { "protocol": "kasa", "host": "192.168.1.51" }
  ],
  "pollInterval": 5,
  "whiteList": [],
  "blackList": []
}
```

- `username` / `password`: TP-Link account, required for Tapo (KLAP) devices.
- `enableKasaDiscovery`: broadcast-discover Kasa devices automatically.
- `devices`: add devices manually by IP (required for Tapo).
- `pollInterval`: state refresh interval in seconds (default 5).

## Notes / limitations

- Color temperature control for **Tapo** bulbs is not exposed by the upstream library (brightness + on/off only); **Kasa** CT bulbs support color temperature.
- Tapo cameras and robot vacuums use different protocols and are out of scope.
- Some device firmwares block third-party local access — see the TP-Link app local-control settings.
