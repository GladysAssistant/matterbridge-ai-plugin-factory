# matterbridge-ai-factory-melcloud-home-classic

Matterbridge dynamic platform plugin that exposes **Mitsubishi Electric** air
conditioners to Matter through the **MELCloud (Classic)** and **MELCloud Home**
cloud APIs.

> MVP scope: **Air-to-Air (ATA)** units only. Air-to-Water (ATW) units are
> autodiscovered and listed but not yet controllable.

## Features

- Choice of application in the plugin settings: **MELCloud (Classic)** or
  **MELCloud Home**. An account configured with one application cannot use the
  other, so exactly one is selected.
- Secure authentication for both backends:
  - Classic: `ClientLogin3` context-key session.
  - Home: headless OIDC (PAR → IdentityServer → Cognito → PKCE token exchange)
    with access/refresh tokens.
- Per ATA device, a Matter **Air Conditioner** endpoint with:
  - **On/Off** control
  - **Setpoint** (target temperature)
  - **Internal temperature** (measured room temperature)
  - **Operation mode**: automatic, heating, cooling, fan only, dry
  - **Vertical blade** swing control (vane up/down sweep)
  - **Horizontal blade** swing control (vane left/right sweep)
  - Fan speed
  - Device name
- **Autodiscovery** of every device, including not-yet-supported ones (they are
  surfaced in the device select list).

## Configuration

| Setting        | Description                                              |
| -------------- | ------------------------------------------------------- |
| `application`  | `classic` (MELCloud) or `home` (MELCloud Home).         |
| `username`     | Account email.                                          |
| `password`     | Account password.                                       |
| `pollInterval` | State refresh interval in seconds (min 30, default 60). |
| `whiteList`    | Only listed devices are exposed (empty = all).          |
| `blackList`    | Listed devices are excluded.                            |

## Notes on vane mapping

Matter's `FanControl` cluster models vane movement as a *rocking* (swing)
setting. The vertical blade maps to rock up/down and the horizontal blade maps
to rock left/right, giving "sweep" on/off control for each axis. Discrete vane
positions (fully up / down) are a future enhancement.

## Credits

The MELCloud Classic and MELCloud Home API behaviour (endpoints, payload shapes
and the Home OIDC flow) follows the public reference implementation in
[OlivierZal/melcloud-api](https://github.com/OlivierZal/melcloud-api).

## License

Apache-2.0
