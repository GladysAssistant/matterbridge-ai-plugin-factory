Fix bug in matterbridge-ai-factory-enphase-envoy-iq-gateway-onduleurs-solaires-batteries. Be concise, write code not explanations.

Bug report:
Your latest fix has resolved the connection issue.

I now have the following devices:

<img width="2382" height="366" alt="Image" src="https://github.com/user-attachments/assets/a66a3789-7e58-448b-a67c-8ffed971c761" />

But I doesn't found the same names as in my HA integration.

I’ve found a couple of issues :
- Solar Production value is 0 kwh
- Twice Online Solar Production
- Several Gateway Network

Explain me why please.

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-enphase-envoy-iq-gateway-onduleurs-solaires-batteries 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.