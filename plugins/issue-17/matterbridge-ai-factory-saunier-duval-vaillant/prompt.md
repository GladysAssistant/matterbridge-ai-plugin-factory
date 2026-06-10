Fix bug in matterbridge-ai-factory-saunier-duval-vaillant. Be concise, write code not explanations.

Bug report:
Device capabilities that works : 
- indoor temperature (read-only)
- indoor humidity (read-only)
- Heat temperature setpoint
- cool temperature setpoint

Now, create those device capabilities : 
- outdoortemperature (read-only)
- Device status (off, program, manual, away)
- Turn on in program mode
- Turn on in manual mode
- Turn off

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-saunier-duval-vaillant 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.