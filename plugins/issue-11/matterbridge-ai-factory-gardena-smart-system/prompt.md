Fix bug in matterbridge-ai-factory-gardena-smart-system. Be concise, write code not explanations.

Bug report:
OK pour l'installation

OK pour le device Pompe (VALVE) : il apparait dans matterbridge et le cluster OnOff fonctionne correctement

En revanche toujours KO pour le device SENSOR :
`info[13:15:22.959][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: device "Sensor" (623803c1-1474-41ce-939c-f73cee308604) services=[SENSOR,COMMON]
warn[13:15:22.960][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: device "Sensor" exposes no supported service types (got: SENSOR,COMMON)`

dans le fichier module.ts, pourquoi garder le service "SOIL_SENSOR" alors que celui-ci n'existe pas dans la documentation de l'api Gardena ? Seul le service "SENSOR" existe

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-gardena-smart-system 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.