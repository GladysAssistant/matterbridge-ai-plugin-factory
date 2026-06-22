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
  - **Fan speed** (discrete speeds 1…N plus a coarse Off/Low/Med/High/Auto mode)
  - Device name, model and serial number
- **Autodiscovery** of every device, including not-yet-supported ones (they are
  surfaced in the device select list).
- **Inventory metadata** logged on start for each device (mirrors the web app):
  house name, indoor AC model/serial, outdoor unit model/serial, and the Wi-Fi
  module model/serial/MAC when the backend exposes them.

## Connecting / authentication

1. Install and enable the plugin in the Matterbridge frontend.
2. Open the plugin configuration and set:
   - **application** – pick the same app you use on your phone:
     - `classic` → the legacy **MELCloud** app/site (`app.melcloud.com`).
     - `home` → the newer **MELCloud Home** app (`melcloudhome.com`).
   - **username / password** – the email and password of that MELCloud account.
3. Save and restart the plugin. On success the log shows
   `MELCloud … authenticated` followed by the discovered devices and their
   inventory metadata.

> The two backends are mutually exclusive. An account created for one app cannot
> log in to the other. If login fails, double-check which app the account belongs
> to.

Credentials are stored only in your local Matterbridge config and are sent only
to the official Mitsubishi MELCloud servers.

## Configuration

| Setting        | Description                                              |
| -------------- | ------------------------------------------------------- |
| `application`  | `classic` (MELCloud) or `home` (MELCloud Home).         |
| `username`     | Account email.                                          |
| `password`     | Account password.                                       |
| `pollInterval` | State refresh interval in seconds (min 30, default 60). |
| `whiteList`    | Only listed devices are exposed (empty = all).          |
| `blackList`    | Listed devices are excluded.                            |

## Controls and their values

### On / Off

Turns the unit on/off. The current power state is read back from MELCloud so the
Matter tile reflects the real state after a poll.

### Fan speed

Two linked controls are exposed (Matter `FanControl`):

- **Speed** (MultiSpeed, `1…N`): discrete fan speeds. For a 5-speed unit this is
  `1, 2, 3, 4, 5`. Setting a speed also turns the unit on.
- **Mode** (coarse): `Off`, `Low`, `Medium`, `High`, `Auto`.
  - `Off` → sends an **Off** command to the whole unit (a MELCloud unit has no
    "fan off" state).
  - `Low` → speed 1, `Medium` → speed 3, `High` → max speed.
  - `Auto` → automatic fan speed (MELCloud fan speed `0`).

The percentage slider, when present, is mapped onto the nearest discrete speed.

### Operation mode (Thermostat `systemMode`)

`auto`, `heat`, `cool`, `fan only`, `dry` are all mapped to/from MELCloud. See the
limitations below regarding which of these a given Matter controller will let you
pick.

### Setpoint

The target temperature. MELCloud uses a single setpoint, while the Matter
Thermostat exposes a heating and a cooling setpoint; the plugin keeps both in
sync with the single MELCloud value, so writing either one works.

### Vanes / oscillation

The vertical blade maps to rock up/down and the horizontal blade to rock
left/right (swing on/off per axis).

## Known limitations / things that don't work

- **Operation-mode picker (fan only / dry):** Matter's standard Thermostat only
  advertises `Off`, `Auto`, `Cool` and `Heat` in most controllers'
  mode dropdown. `fan only` and `dry` are mapped internally and reported back
  correctly, but many controllers won't offer them as a choice. Use the device's
  remote or the MELCloud app for those modes if your controller hides them.
- **Separate cooling/heating setpoints:** this is inherent to the Matter
  Thermostat cluster (it has no single combined setpoint with auto mode). Both
  are mirrored to the one MELCloud setpoint, so either field controls the unit.
- **Vane positions / "balayage":** the MELCloud web app lets you pick one of five
  fixed positions, `Swing`/balayage, or `Auto` per axis. Matter's `FanControl`
  rock setting is a boolean swing on/off, so only swing on (`Swing`) and swing
  off (`Auto`) can be represented. Discrete vane positions and a true `Auto`
  position cannot be exposed through this cluster.
- **TemperatureMeasurement vs LocalTemperature:** both report the same value (the
  measured room temperature). The Air Conditioner device type carries the
  Thermostat `localTemperature` and an optional `TemperatureMeasurement`
  cluster; some controllers read one and some the other, so both are populated
  with the same reading. This is expected, not a duplicate bug.
- **Air-to-Water (ATW) units:** discovered and listed, but not controllable yet.

## Credits

The MELCloud Classic and MELCloud Home API behaviour (endpoints, payload shapes
and the Home OIDC flow) follows the public reference implementation in
[OlivierZal/melcloud-api](https://github.com/OlivierZal/melcloud-api).

## License

Apache-2.0
