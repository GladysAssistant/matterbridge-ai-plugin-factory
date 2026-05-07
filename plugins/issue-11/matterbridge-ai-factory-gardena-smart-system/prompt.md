Fix bug in matterbridge-ai-factory-gardena-smart-system. Be concise, write code not explanations.

Bug report:
L'installation du plugin est correcte

cependant je ne vois aucun devices, voici les logs matterbridge :

info[11:35:19.840][PluginManager]Configuring plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform
info[11:35:19.842][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]onConfigure: pushing initial attribute values
notice[11:35:19.842][PluginManager]Configured plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform
info[11:38:26.564][Frontend]Saving config for plugin matterbridge-ai-factory-gardena-smart-system...
info[11:39:39.750][PluginManager]Shutting down plugin matterbridge-ai-factory-gardena-smart-system: Matterbridge is closing: shutting down......
info[11:39:39.753][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]onShutdown (Matterbridge is closing: shutting down...)
notice[11:39:39.753][PluginManager]Shutdown of plugin matterbridge-ai-factory-gardena-smart-system completed
warn[11:39:39.779][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: websocket closed 1005
info[11:39:43.650][PluginManager]Loading plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform
info[11:39:43.661][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Initializing Gardena Smart System platform...
notice[11:39:43.662][PluginManager]Loaded plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform (entrypoint /usr/local/lib/node_modules/matterbridge-ai-factory-gardena-smart-system/dist/module.js)
info[11:39:43.662][PluginManager]Starting plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform
info[11:39:43.662][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]onStart (Matterbridge is starting)
info[11:39:44.254][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: location "GARDENA smart Garden" with 2 devices
info[11:39:44.349][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: connecting websocket
notice[11:39:44.357][PluginManager]Started plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform
info[11:39:44.478][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: websocket open
info[11:40:15.690][PluginManager]Configuring plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform
info[11:40:15.692][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]onConfigure: pushing initial attribute values
notice[11:40:15.692][PluginManager]Configured plugin matterbridge-ai-factory-gardena-smart-system type DynamicPlatform

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-gardena-smart-system 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.