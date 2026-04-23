Fix bug in matterbridge-ai-factory-daikin-onecta. Be concise, write code not explanations.

Bug report:
1) J'ai ajouté l'application sur le site de daikin comme indiqué ici pour l'application home assistant (https://github.com/jwillemsen/daikin_onecta) :

  _First create an account at https://developer.cloud.daikineurope.com/, after that create an application at the Daikin Developer website, see the Getting started page at the Daikin Developer portal for more information. As redirect uri always first use https://my.home-assistant.io/redirect/oauth. Copy and save the provided client id and secret, you need to enter these in the next step._

Sur Matterbridge, en entrant Daikin Onecta Client ID, Daikin Onecta Client Secret et en cochant la case Enable debug et après redémarrage de matterbridge rien ne ce passe.

Voici les logs : 

```
info[18:01:46.934][Frontend]WebSocketServer client "::ffff:127.0.0.1" connected to Matterbridge
info[18:01:46.986][DockerVersion]Starting docker version check...
info[18:01:46.987][DockerVersion]Docker build config: version=3.7.3 dev=false
info[18:01:46.992][CheckUpdates]Starting check updates...
notice[18:01:47.392][Matterbridge]Starting Matterbridge server node
notice[18:01:47.393][Matterbridge]Matterbridge bridge started successfully
notice[18:01:47.394][Node]Matterbridge going online
notice[18:01:47.406][Node]Matterbridge is online
info[18:01:47.407][FabricAccessControl]ACL List updated privilege: 5 authMode: 2 subjects: 2997825082705188712 targets: null fabricIndex: 1
notice[18:01:47.442][Matterbridge]Session opened on server node for Matterbridge: { name: '@1:299a6a0791661768•bfbd', nodeId: 15102054000359717837, peerNodeId: 2997825082705188712, fabric: { fabricIndex: 1, fabricId: 1, nodeId: 15102054000359717837, rootNodeId: 2997825082705188712, rootVendorId: 65521, label: 'Gladys Assistant' }, isPeerActive: true, lastInteractionTimestamp: 1776794507441, lastActiveTimestamp: 1776794507441, numberOfActiveSubscriptions: 0 }
info[18:01:47.444][CaseClient]@1:299a6a0791661768•bfbd Resumed session with @1:299a6a0791661768 address: udp://[fdde:adbe:ef12:5678:be24:11ff:fe4a:2b5a]:40972 fabric: a08785e0062ee6de (#1) SII: 500ms SAI: 300ms SAT: 4s DMRev: 19 IMRev: 13 spec: 0x1040200 maxPaths: 10 CATs:
info[18:01:47.444][InteractionServer]Reestablish subscription » @1:299a6a0791661768•bfbd⇵fe12 sub#: c13dbbe6 isFabricFiltered: true maxInterval: 1m 1s sendInterval: 49.3s
info[18:01:47.456][Session]•unsecured#e9092bb9f0db214f Session ended
info[18:01:47.552][InteractionServer]Subscription successfully reestablished » @1:299a6a0791661768•bfbd⇵fe12 7↔7 sub#: c13dbbe6 timing: 1s - 1m => 1m 1s sendInterval: 49.3s
info[18:01:47.553][SubscriptionsBehavior]Reestablished 1 (3242048486) of 1 former subscriptions successfully
notice[18:01:47.553][Matterbridge]Session subscriptions changed on server node for Matterbridge: { name: '@1:299a6a0791661768•bfbd', nodeId: 15102054000359717837, peerNodeId: 2997825082705188712, fabric: { fabricIndex: 1, fabricId: 1, nodeId: 15102054000359717837, rootNodeId: 2997825082705188712, rootVendorId: 65521, label: 'Gladys Assistant' }, isPeerActive: true, lastInteractionTimestamp: 1776794507441, lastActiveTimestamp: 1776794507441, numberOfActiveSubscriptions: 1 }
info[18:01:47.554][MdnsAdvertisement]Publishing kind: operational service: mdns:A08785E0062EE6DE-D195461966353BCD._matter._tcp.local
notice[18:01:47.554][Matterbridge]Server node for Matterbridge is online
notice[18:01:47.555][Matterbridge]Server node for Matterbridge is already commissioned. Waiting for controllers to connect...
info[18:01:47.827][CheckUpdates]Check updates succeeded
info[18:01:48.797][DockerVersion]Docker version check succeeded: latest=3.7.4, dev=3.7.5, current=3.7.3
warn[18:01:48.798][DockerVersion]You are using the v.3.7.3 latest Docker image. Please pull the latest Docker image v.3.7.4.
info[18:02:02.456][InteractionServer]Subscribe « @1:299a6a0791661768•bfbd⇵0db5 fabricFiltered attributePaths: 1 eventPaths: 1
notice[18:02:02.457][Matterbridge]Session subscriptions changed on server node for Matterbridge: { name: '@1:299a6a0791661768•bfbd', nodeId: 15102054000359717837, peerNodeId: 2997825082705188712, fabric: { fabricIndex: 1, fabricId: 1, nodeId: 15102054000359717837, rootNodeId: 2997825082705188712, rootVendorId: 65521, label: 'Gladys Assistant' }, isPeerActive: true, lastInteractionTimestamp: 1776794507441, lastActiveTimestamp: 1776794507441, numberOfActiveSubscriptions: 0 }
info[18:02:02.462][InteractionServer]Subscribe successful » @1:299a6a0791661768•bfbd⇵0db5 2↔1 sub#: d06faf84 timing: 1s - 1m => 1m 2s sendInterval: 50s
notice[18:02:02.464][Matterbridge]Session subscriptions changed on server node for Matterbridge: { name: '@1:299a6a0791661768•bfbd', nodeId: 15102054000359717837, peerNodeId: 2997825082705188712, fabric: { fabricIndex: 1, fabricId: 1, nodeId: 15102054000359717837, rootNodeId: 2997825082705188712, rootVendorId: 65521, label: 'Gladys Assistant' }, isPeerActive: true, lastInteractionTimestamp: 1776794507441, lastActiveTimestamp: 1776794507441, numberOfActiveSubscriptions: 1 }
info[18:02:17.395][PluginManager]Configuring plugin matterbridge-ai-factory-daikin-onecta type DynamicPlatform
info[18:02:17.398][Matterbridge plugin for Daikin Onecta air conditioners (On/Off, thermostat, heating/cooling/auto mode).]onConfigure called
notice[18:02:17.398][PluginManager]Configured plugin matterbridge-ai-factory-daikin-onecta type DynamicPlatform
info[18:02:32.465][InteractionServer]Subscribe « @1:299a6a0791661768•bfbd⇵0db6 fabricFiltered attributePaths: 1 eventPaths: 1
notice[18:02:32.465][Matterbridge]Session subscriptions changed on server node for Matterbridge: { name: '@1:299a6a0791661768•bfbd', nodeId: 15102054000359717837, peerNodeId: 2997825082705188712, fabric: { fabricIndex: 1, fabricId: 1, nodeId: 15102054000359717837, rootNodeId: 2997825082705188712, rootVendorId: 65521, label: 'Gladys Assistant' }, isPeerActive: true, lastInteractionTimestamp: 1776794507441, lastActiveTimestamp: 1776794507441, numberOfActiveSubscriptions: 0 }
info[18:02:32.468][InteractionServer]Subscribe successful » @1:299a6a0791661768•bfbd⇵0db6 2↔1 sub#: d06faf85 timing: 1s - 1m => 1m 9s sendInterval: 55.3s
notice[18:02:32.470][Matterbridge]Session subscriptions changed on server node for Matterbridge: { name: '@1:299a6a0791661768•bfbd', nodeId: 15102054000359717837, peerNodeId: 2997825082705188712, fabric: { fabricIndex: 1, fabricId: 1, nodeId: 15102054000359717837, rootNodeId: 2997825082705188712, rootVendorId: 65521, label: 'Gladys Assistant' }, isPeerActive: true, lastInteractionTimestamp: 1776794507441, lastActiveTimestamp: 1776794507441, numberOfActiveSubscriptions: 1 }
info[18:02:47.394][Matterbridge]Setting reachability to true for Matterbridge
```

Le mieux est d’utiliser l’option 1 d’authentification mobile app comme l’indique la documentation du plugin homebridge et ne pas se baser sur le plugin home assistant :

Option 1: Mobile App Authentication (Recommended)

https://www.npmjs.com/package/@mp-consulting/homebridge-daikin-cloud

2) Il y a également un problème losque l'on fait un docker compose down et un docker compose up -d, le docker matterbridge ne se relance pas et il y a le message suivant (Le problème est non présent quand on restart matterbridge via l'interface web) : 
```
18:59:42.529] [Matterbridge] Error parsing plugin matterbridge-ai-factory-daikin-onecta. Trying to reinstall it from npm...
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/matterbridge-ai-factory-daikin-onecta - Not found
npm error 404
npm error 404  The requested resource 'matterbridge-ai-factory-daikin-onecta@*' could not be found or you do not have permission to access it.
npm error 404
npm error 404 Note that you can also install from a
npm error 404 tarball, folder, http url, or git url.
npm error A complete log of this run can be found in: /root/.npm/_logs/2026-04-21T18_59_42_589Z-debug-0.log
[18:59:42.826] [Cli] Matterbridge.loadInstance() failed with error: Command failed: npm install -g matterbridge-ai-factory-daikin-onecta --omit=dev
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/matterbridge-ai-factory-daikin-onecta - Not found
npm error 404
npm error 404  The requested resource 'matterbridge-ai-factory-daikin-onecta@*' could not be found or you do not have permission to access it.
npm error 404
npm error 404 Note that you can also install from a
npm error 404 tarball, folder, http url, or git url.
npm error A complete log of this run can be found in: /root/.npm/_logs/2026-04-21T18_59_42_589Z-debug-0.log
 
Error: Command failed: npm install -g matterbridge-ai-factory-daikin-onecta --omit=dev
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/matterbridge-ai-factory-daikin-onecta - Not found
npm error 404
npm error 404  The requested resource 'matterbridge-ai-factory-daikin-onecta@*' could not be found or you do not have permission to access it.
npm error 404
npm error 404 Note that you can also install from a
npm error 404 tarball, folder, http url, or git url.
npm error A complete log of this run can be found in: /root/.npm/_logs/2026-04-21T18_59_42_589Z-debug-0.log

    at genericNodeError (node:internal/errors:985:15)
    at wrappedFn (node:internal/errors:539:14)
    at checkExecSyncError (node:child_process:925:11)
    at execSync (node:child_process:997:15)
    at Matterbridge.initialize (file:///usr/local/lib/node_modules/matterbridge/node_modules/@matterbridge/core/dist/matterbridge.js:613:21)
    at async Matterbridge.loadInstance (file:///usr/local/lib/node_modules/matterbridge/node_modules/@matterbridge/core/dist/matterbridge.js:309:17)
    at async main (file:///usr/local/lib/node_modules/matterbridge/node_modules/@matterbridge/core/dist/cli.js:100:16) {
  status: 1,
  signal: null,
  output: [
    null,
    <Buffer >,
    <Buffer 6e 70 6d 20 65 72 72 6f 72 20 63 6f 64 65 20 45 34 30 34 0a 6e 70 6d 20 65 72 72 6f 72 20 34 30 34 20 4e 6f 74 20 46 6f 75 6e 64 20 2d 20 47 45 54 20 ... 461 more bytes>
  ],
  pid: 37,
  stdout: <Buffer >,
  stderr: <Buffer 6e 70 6d 20 65 72 72 6f 72 20 63 6f 64 65 20 45 34 30 34 0a 6e 70 6d 20 65 72 72 6f 72 20 34 30 34 20 4e 6f 74 20 46 6f 75 6e 64 20 2d 20 47 45 54 20 ... 461 more bytes>
}
```

3) Il y a également sur le plugin ceci "Token File Absolute path where the OAuth2 refresh token is persisted." ou je ne sais pas quel Absolute path mettre et il faudrait en définir un automatiquement et qui fonctionne sur matterbridge docker.
Voici une capture d'écran du paramètre : 

<img width="417" height="90" alt="Image" src="https://github.com/user-attachments/assets/98b1e14c-ac00-4bfa-8233-3e783426461f" />

À voir si en utilisant la méthode d’authentification mobile app si cette ligne est toujours utile. Si oui proposer un chemin comptatible https://www.npmjs.com/package/@mp-consulting/homebridge-daikin-cloud

Pour tous les différents points remontés il faut te baser uniquement sur le plugin homebridge suivant : https://www.npmjs.com/package/@mp-consulting/homebridge-daikin-cloud

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-daikin-onecta 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.