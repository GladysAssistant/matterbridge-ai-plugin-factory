Fix bug in matterbridge-ai-factory-enphase-envoy-iq-gateway-onduleurs-solaires-batteries. Be concise, write code not explanations.

Bug report:
The solar panel or "inverter" are missing again and Gateway Temperature value is always at 0.

Also, I'm not seeing any data from the Matterbridge devices in Gladys.

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-enphase-envoy-iq-gateway-onduleurs-solaires-batteries 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.