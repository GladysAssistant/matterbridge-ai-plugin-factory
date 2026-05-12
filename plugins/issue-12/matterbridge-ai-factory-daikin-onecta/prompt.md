Fix bug in matterbridge-ai-factory-daikin-onecta. Be concise, write code not explanations.

Bug report:
You need to add operationMode
Air Conditioning Mode (Heating, Cooling, Drying, Fan or Auto)
The mode doesn't appear on another paired controller

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-daikin-onecta 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.