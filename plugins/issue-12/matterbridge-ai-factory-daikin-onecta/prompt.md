Fix bug in matterbridge-ai-factory-daikin-onecta. Be concise, write code not explanations.

Bug report:
I'm still having the same problem.
The plugin apparently adds the token correctly and discoverd 1 device, but then no device is showing up on the Matterbridge interface.
Here are the logs : 

```
[18:41:39.090] [PluginManager] Loading plugin matterbridge-ai-factory-daikin-onecta type DynamicPlatform
[18:41:39.131] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] Creating storage for plugin matterbridge-ai-factory-daikin-onecta in /root/.matterbridge/matterbridge-ai-factory-daikin-onecta
[18:41:39.131] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] Creating context for plugin matterbridge-ai-factory-daikin-onecta
[18:41:39.131] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] Loading selectDevice for plugin matterbridge-ai-factory-daikin-onecta
[18:41:39.131] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] Loading selectEntity for plugin matterbridge-ai-factory-daikin-onecta
[18:41:39.131] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] MatterbridgeDynamicPlatform loaded
[18:41:39.131] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] Initializing Daikin Onecta platform...
[18:41:39.132] [PluginManager] Loaded plugin matterbridge-ai-factory-daikin-onecta type DynamicPlatform (entrypoint /usr/local/lib/node_modules/matterbridge-ai-factory-daikin-onecta/dist/module.js)
[18:41:39.132] [PluginManager] Starting plugin matterbridge-ai-factory-daikin-onecta type DynamicPlatform
[18:41:39.132] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] onStart (Matterbridge is starting)
[18:41:39.132] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] Created context for plugin matterbridge-ai-factory-daikin-onecta
[18:41:39.132] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] Loaded 0 selectEntity for plugin matterbridge-ai-factory-daikin-onecta
[18:41:39.132] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] Loaded 0 selectDevice for plugin matterbridge-ai-factory-daikin-onecta
[18:41:39.132] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] MatterbridgePlatform for plugin matterbridge-ai-factory-daikin-onecta is fully initialized
[18:41:39.132] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] Saving 0 selectDevice...
[18:41:39.133] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] Saving 0 selectEntity...
[18:41:39.369] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] Daikin rate-limit: minute=19/20 day=197/200
[18:41:39.369] [Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners] Discovered 1 Daikin device(s)
[18:41:39.638] [Frontend] WebSocketServer client "::ffff:127.0.0.1" connected to Matterbridge
[18:41:39.692] [CheckUpdates] Starting check updates...
[18:41:39.702] [DockerVersion] Starting docker version check...
[18:41:39.703] [DockerVersion] Docker build config: version=3.7.7 dev=false
[18:41:40.061] [MatterbridgeUpdates] Error getting plugin matterbridge-ai-factory-daikin-onecta latest version: Failed to fetch data. Status code: 404
[18:41:40.120] [MatterbridgeUpdates] Matterbridge is out of date. Current version: 3.7.7. Latest version: 3.7.8.
[18:41:40.124] [CheckUpdates] Check updates succeeded
[18:41:41.817] [DockerVersion] Docker version check succeeded: latest=3.7.8, dev=3.7.9, current=3.7.7
[18:41:41.817] [DockerVersion] You are using the v.3.7.7 latest Docker image. Please pull the latest Docker image v.3.7.8 and recreate the container to apply it.
[18:43:39.025] [SystemCheck] Starting system check...
[18:43:39.039] [SystemCheck] System check succeeded
[18:46:03.781] [Frontend] WebSocket client disconnected
[18:46:03.929] [Frontend] WebSocketServer client "::ffff:127.0.0.1" connected to Matterbridge
[18:46:04.011] [DockerVersion] Starting docker version check...
[18:46:04.012] [DockerVersion] Docker build config: version=3.7.7 dev=false
[18:46:04.016] [CheckUpdates] Starting check updates...
[18:46:04.518] [MatterbridgeUpdates] Matterbridge is out of date. Current version: 3.7.7. Latest version: 3.7.8.
[18:46:04.619] [MatterbridgeUpdates] Error getting plugin matterbridge-ai-factory-daikin-onecta latest version: Failed to fetch data. Status code: 404
[18:46:04.621] [CheckUpdates] Check updates succeeded
[18:46:06.431] [DockerVersion] Docker version check succeeded: latest=3.7.8, dev=3.7.9, current=3.7.7
[18:46:06.431] [DockerVersion] You are using the v.3.7.7 latest Docker image. Please pull the latest Docker image v.3.7.8 and recreate the container to apply it.
[18:46:39.025] [DockerVersion] Starting docker version check...
[18:46:39.025] [DockerVersion] Docker build config: version=3.7.7 dev=false
[18:46:39.034] [CheckUpdates] Starting check updates...
[18:46:39.397] [MatterbridgeUpdates] Error getting plugin matterbridge-ai-factory-daikin-onecta latest version: Failed to fetch data. Status code: 404
[18:46:39.482] [MatterbridgeUpdates] Matterbridge is out of date. Current version: 3.7.7. Latest version: 3.7.8.
[18:46:39.493] [CheckUpdates] Check updates succeeded
[18:46:40.383] [Matterbridge] Error waiting for plugin matterbridge-ai-factory-daikin-onecta to load and start. Plugin is in error state.
[18:46:41.212] [DockerVersion] Docker version check succeeded: latest=3.7.8, dev=3.7.9, current=3.7.7
[18:46:41.212] [DockerVersion] You are using the v.3.7.7 latest Docker image. Please pull the latest Docker image v.3.7.8 and recreate the container to apply it.
[18:46:41.383] [Matterbridge] The plugin matterbridge-ai-factory-daikin-onecta is in error state.
[18:46:41.384] [Matterbridge] The bridge will not start until the problem is solved to prevent the controllers from deleting all registered devices.
[18:46:41.384] [Matterbridge] If you want to start the bridge disable the plugin in error state and restart.
```

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-daikin-onecta 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.