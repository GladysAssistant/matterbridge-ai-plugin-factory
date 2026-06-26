Fix bug in matterbridge-ai-factory-enphase-envoy-iq-gateway-onduleurs-solaires-batteries. Be concise, write code not explanations.

Bug report:
I have installed the plugin and it has installed correctly.

I have filled in the following fields:

- envoyIp
- enlightenEmail
- enlightenPassword

My Enphase base firmware version is 8.3.5528 and the details are correct, as it works on my mobile app and HA.

I am getting the following error in the logs after configuration.
```
warn[13:17:51.364][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Local API returned 401 for /production.json?details=1; token may be expired
warn[13:17:51.375][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Local API returned 401 for /api/v1/production/inverters; token may be expired
warn[13:17:51.389][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Local API returned 401 for /ivp/livedata/status; token may be expired
warn[13:17:51.400][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Local API returned 401 for /home.json; token may be expired
```

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-enphase-envoy-iq-gateway-onduleurs-solaires-batteries 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.