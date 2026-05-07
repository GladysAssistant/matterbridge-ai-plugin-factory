Fix bug in matterbridge-ai-factory-yeelight. Be concise, write code not explanations.

Bug report:
Status unchanged. Both the log errors and the switch 'flicker' issue remain unresolved

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-yeelight 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.