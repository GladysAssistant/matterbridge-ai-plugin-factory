Fix bug in matterbridge-ai-factory-tasmota-firmware-esp8266-esp32-switches-lights-sensors-covers. Be concise, write code not explanations.

Bug report:
Feedback
Plugin installs correctly
Manual device creation by IP address works
Power switch control works
Status updates.

What's needed : 
Automatic discovery (mqtt or IP range scan)
Support more devices types (energy features or temperature sensors are not working)

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-tasmota-firmware-esp8266-esp32-switches-lights-sensors-covers 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.