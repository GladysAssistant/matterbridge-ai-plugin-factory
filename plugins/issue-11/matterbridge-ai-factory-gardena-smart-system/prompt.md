Fix bug in matterbridge-ai-factory-gardena-smart-system. Be concise, write code not explanations.

Bug report:
Installation OK

Je ne vois toujours pas les devices qui remontent dans matterbridge
Logs :

`info[10:17:21.450][PluginManager]Loading plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform
info[10:17:21.462][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Initializing Gardena Smart System platform...
notice[10:17:21.463][PluginManager]Loaded plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform (entrypoint /usr/local/lib/node_modules/matterbridge-ai-factory-gardena-smart-system/dist/module.js)
info[10:17:21.463][PluginManager]Starting plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform
info[10:17:21.463][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]onStart (Matterbridge is starting)
info[10:17:21.962][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: location "GARDENA smart Garden" with 2 devices
info[10:17:21.963][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: device "Sensor" (623803c1-1474-41ce-939c-f73cee308604) services=[SENSOR,COMMON]
warn[10:17:21.963][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: device "Sensor" exposes no supported service types (got: SENSOR,COMMON)
info[10:17:21.963][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: device "Pompe" (8be911b9-ec40-47da-ba12-8c457e3bd21c) services=[VALVE_SET,VALVE,COMMON]
warn[10:17:21.964][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: device "Pompe" exposes no supported service types (got: VALVE_SET,VALVE,COMMON)
info[10:17:22.065][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: connecting websocket
notice[10:17:22.073][PluginManager]Started plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform
info[10:17:22.180][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: websocket open
info[10:17:53.493][PluginManager]Configuring plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform
info[10:17:53.495][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]onConfigure: pushing initial attribute values
notice[10:17:53.495][PluginManager]Configured plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform`

Quelques pistes :
en faisant le GET https://api.smart.gardena.dev/v2/locations/{locationId} on obtient mes 2 devices
- mon premier device qui correspond à mon capteur d'humidité expose les services suivants : SENSOR et COMMON
- mon second device qui correspond à ma pompe expose les services suivants : VALVE et COMMON

Le PUT que tu as fais est également incorrect, pour démarrer la pompe il faut utiliser le : PUT /command/{serviceId} avec VALVE_CONTROL et START_SECONDS_TO_OVERRIDE
voici la documentation : https://developer.husqvarnagroup.cloud/apis/gardena-smart-system-api?tab=api%20v2


Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-gardena-smart-system 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.