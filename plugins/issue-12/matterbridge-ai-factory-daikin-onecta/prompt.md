Fix bug in matterbridge-ai-factory-daikin-onecta. Be concise, write code not explanations.

Bug report:
When activating extra features, only one device is created, whereas one device should be created per extra feature.
When activating extra features, only one device is created, whereas one device should be created per extra feature. They also need to be named correctly; otherwise, it's impossible to know which extra feature is being referred to.

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-daikin-onecta 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.