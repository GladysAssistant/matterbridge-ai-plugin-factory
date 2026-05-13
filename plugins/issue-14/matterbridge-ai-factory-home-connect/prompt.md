Fix bug in matterbridge-ai-factory-home-connect. Be concise, write code not explanations.

Bug report:
I don't want the demo device to appear, but rather my actual physical device using the API of physical home appliances.

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-home-connect 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.