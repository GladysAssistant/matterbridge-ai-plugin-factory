Fix bug in matterbridge-ai-factory-ajax-systems-alarmes-et-domotique-s-curit-hub-d-tecteurs-sir-nes-relais-prises. Be concise, write code not explanations.

Bug report:
Aucun device ajoutés.

Configuration effectuée :
Mode api (même résultat en mode grpc)
Ajax account email
Ajax password

Logs en debug :
info[10:45:56.574][Matterbridge plugin for Ajax Systems alarm & automation (Hub, detectors, sirens, relays, sockets)]onShutdown called with reason: Matterbridge is closing: shutting down...
info[10:46:31.647][Matterbridge plugin for Ajax Systems alarm & automation (Hub, detectors, sirens, relays, sockets)]onConfigure called

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-ajax-systems-alarmes-et-domotique-s-curit-hub-d-tecteurs-sir-nes-relais-prises 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.