Fix bug in matterbridge-ai-factory-daikin-onecta. Be concise, write code not explanations.

Bug report:
The air conditioners are correctly registered in Matterbridge, however, there are several issues:

The On/Off control is not present.

The SET cooling setpoint and SET heating setpoint should not appear; instead, they should appear as follows (if Matterbridge is compatible):

On/Off control
Temperature Control: View current room temperature and set target temperature
Operation Modes: Cooling, heating, and auto modes
Fan Control: Adjust fan speed from the accessory settings
Swing Mode: Enable/disable swing (if supported by your device)

Optional integrated features (if Matterbridge is compatible):

Extra Features (individually configurable):
Powerful mode (showPowerfulMode)
Econo mode (showEconoMode)
Streamer mode (showStreamerMode)
Outdoor silent mode (showOutdoorSilentMode)
Indoor quiet mode (showIndoorSilentMode)
Dry mode (showDryMode)
Fan only mode (showFanOnlyMode)

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-daikin-onecta 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.