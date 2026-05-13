Fix bug in matterbridge-ai-factory-yeelight. Be concise, write code not explanations.

Bug report:
We need to resolve the state-sync between Matter and Matterbridge. The fact that the Yeelight app updates correctly proves the hardware is fine—the issue lies in how Matterbridge handles the status return. Please look into this as it's the likely cause of both the log errors and the switch revert.

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-yeelight 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.