Fix bug in matterbridge-ai-factory-reolink-cam-ras-ip-doorbells-nvr. Be concise, write code not explanations.

Bug report:
Add to the README.md file details about how the plugin works and a description of each existing feature.

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-reolink-cam-ras-ip-doorbells-nvr 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.