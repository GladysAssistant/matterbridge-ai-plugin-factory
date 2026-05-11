Fix bug in matterbridge-ai-factory-daikin-onecta. Be concise, write code not explanations.

Bug report:
I have two air conditioners with the same serial number that have appeared, but only one should be listed.
For a single air conditioner, the following options should be available to enable or disable: capabilities: powerful, econo, streamer, outdoor-silent, dry-mode, fan-only

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-daikin-onecta 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.