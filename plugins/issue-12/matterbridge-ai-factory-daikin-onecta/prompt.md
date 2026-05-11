Fix bug in matterbridge-ai-factory-daikin-onecta. Be concise, write code not explanations.

Bug report:
This isn't good.
All modes should be grouped under the same device/endpoint/unique ID, and a separate device/endpoint/unique ID shouldn't be created for the powerful mode.
Instead, each functionality should be under the same device/endpoint. Multiple On/Off functions should be allowed under the same device/endpoint.

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-daikin-onecta 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.