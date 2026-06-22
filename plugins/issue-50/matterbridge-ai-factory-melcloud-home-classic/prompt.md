Fix bug in matterbridge-ai-factory-melcloud-home-classic. Be concise, write code not explanations.

Bug report:
I can only test on Melcloud Home service.
The plugin is finding my 4 AC but shows 0 device : 
<img width="1268" height="285" alt="Image" src="https://github.com/user-attachments/assets/e9e76aa1-ca07-4d38-84c4-e2c08ac2f7d8" />

<img width="751" height="271" alt="Image" src="https://github.com/user-attachments/assets/8b781c90-500d-4dbc-b2f0-0ce33d44e52c" />

Here are the logs : 
```
info[16:24:30.596][Frontend]WebSocketServer client "::ffff:192.168.1.90" connected to Matterbridge
info[16:24:30.754][DockerVersion]Starting docker version check...
info[16:24:30.754][DockerVersion]Docker build config: version=3.9.1 dev=false
info[16:24:30.760][CheckUpdates]Starting check updates...
notice[16:24:30.839][Matterbridge]Starting Matterbridge server node
notice[16:24:30.839][Matterbridge]Matterbridge bridge started successfully
notice[16:24:30.840][Node]Matterbridge going online
info[16:24:30.845][ServerNetworkRuntime]TCP transport enabled (incoming=true, outgoing=true)
info[16:24:30.851][ServerNetworkRuntime]Default network profile for unknown peers set to fast
info[16:24:30.851][NetworkProfiles]Configure profile fast exchanges: 200 additionalMrpDelay: 0
notice[16:24:30.852][Node]Matterbridge is online
info[16:24:30.853][FabricAccessControl]ACL List updated privilege: 5 authMode: 2 subjects: 10390361732138358244 targets: null fabricIndex: 1
info[16:24:30.898][NetworkProfiles]Configure profile unknown:connect exchanges: 4 timeout: 10000
info[16:24:30.898][NetworkProfiles]Configure profile unknown:probe exchanges: 2 timeout: 15000
info[16:24:30.899][NetworkProfiles]Configure profile unknown exchanges: 200 delay: 100 additionalMrpDelay: 0
info[16:24:30.904][PeerConnection]@1:9031faf1e3eb55e4•unsecured#2d0249bf2c08b38e⇵4473 ip://[fe80::be24:11ff:fedd:f4fb%eth0]:46990 Connecting addr #: 1 attempt #: 1 connect time: 6ms addr time: 3ms unknown:connect
info[16:24:30.918][CaseClient]@1:9031faf1e3eb55e4•b632 Resumed session with @1:9031faf1e3eb55e4 address: udp://[fe80::be24:11ff:fedd:f4fb%eth0]:46990 fabric: ed0a12995fd0cd2b (#1) SII: 500ms SAI: 300ms SAT: 4s DMRev: 19 IMRev: 13 spec: 0x1040200 maxPaths: 10 CATs:
notice[16:24:30.920][Matterbridge]Session opened on server node for Matterbridge: { name: '@1:9031faf1e3eb55e4•b632', nodeId: 2730738898137664774, peerNodeId: 10390361732138358244, fabric: { fabricIndex: 1, fabricId: 1, nodeId: 2730738898137664774, rootNodeId: 10390361732138358244, rootVendorId: 65521, label: 'Gladys Assistant' }, isPeerActive: true, lastInteractionTimestamp: 1782145470917, lastActiveTimestamp: 1782145470917, numberOfActiveSubscriptions: 0 }
info[16:24:30.921][IpServiceStatus]@1:9031faf1e3eb55e4 Connected
info[16:24:30.939][Session]•unsecured#2d0249bf2c08b38e Session ended
info[16:24:30.940][InteractionServer]Reestablish subscription » @1:9031faf1e3eb55e4•b632⇵4474 sub#: 68544cf9 isFabricFiltered: true maxInterval: 1m 7s sendInterval: 54.3s
info[16:24:31.204][CheckUpdates]Check updates succeeded
notice[16:24:31.616][InteractionServer]Subscription successfully reestablished » @1:9031faf1e3eb55e4•b632⇵4474 7↔7 sub#: 68544cf9 timing: 1s - 1m => 1m 7s sendInterval: 54.3s
notice[16:24:31.617][Matterbridge]Session subscriptions changed on server node for Matterbridge: { name: '@1:9031faf1e3eb55e4•b632', nodeId: 2730738898137664774, peerNodeId: 10390361732138358244, fabric: { fabricIndex: 1, fabricId: 1, nodeId: 2730738898137664774, rootNodeId: 10390361732138358244, rootVendorId: 65521, label: 'Gladys Assistant' }, isPeerActive: true, lastInteractionTimestamp: 1782145470917, lastActiveTimestamp: 1782145470917, numberOfActiveSubscriptions: 1 }
info[16:24:31.619][SubscriptionsBehavior]Reestablished 1 (1750355193) of 1 former subscriptions successfully
info[16:24:31.622][MdnsAdvertisement]Publishing kind: operational service: mdns:ED0A12995FD0CD2B-25E5888F4DD64D06._matter._tcp.local
notice[16:24:31.623][Matterbridge]Server node for Matterbridge is online
notice[16:24:31.623][Matterbridge]Server node for Matterbridge is already commissioned.
info[16:24:32.165][DockerVersion]Docker version check succeeded: latest=3.9.1, dev=3.9.2, current=3.9.1
info[16:24:45.930][InteractionServer]Subscribe « @1:9031faf1e3eb55e4•b632⇵e959 fabricFiltered attributePaths: 1 eventPaths: 1
notice[16:24:45.932][Matterbridge]Session subscriptions changed on server node for Matterbridge: { name: '@1:9031faf1e3eb55e4•b632', nodeId: 2730738898137664774, peerNodeId: 10390361732138358244, fabric: { fabricIndex: 1, fabricId: 1, nodeId: 2730738898137664774, rootNodeId: 10390361732138358244, rootVendorId: 65521, label: 'Gladys Assistant' }, isPeerActive: true, lastInteractionTimestamp: 1782145470917, lastActiveTimestamp: 1782145470917, numberOfActiveSubscriptions: 0 }
notice[16:24:45.938][InteractionServer]Subscribe successful » @1:9031faf1e3eb55e4•b632⇵e959 2↔1 sub#: 7d8629cc timing: 1s - 1m => 1m 3s sendInterval: 50.8s
notice[16:24:45.940][Matterbridge]Session subscriptions changed on server node for Matterbridge: { name: '@1:9031faf1e3eb55e4•b632', nodeId: 2730738898137664774, peerNodeId: 10390361732138358244, fabric: { fabricIndex: 1, fabricId: 1, nodeId: 2730738898137664774, rootNodeId: 10390361732138358244, rootVendorId: 65521, label: 'Gladys Assistant' }, isPeerActive: true, lastInteractionTimestamp: 1782145470917, lastActiveTimestamp: 1782145470917, numberOfActiveSubscriptions: 1 }
info[16:24:45.941][Transaction]Tx ◦reactor<Matterbridge.subscriptions.#addSubscription>#99 waiting on ◦reactor<Matterbridge.subscriptions.#subscriptionCancelled>#97
info[16:25:00.841][PluginManager]Configuring plugin matterbridge-ai-factory-melcloud-home-classic type DynamicPlatform
info[16:25:00.849][Matterbridge plugin for Mitsubishi Electric MELCloud (Classic) and MELCloud Home air conditioners (ATA)]onConfigure called
error[16:25:01.026][Chambre L]setAttribute onOff.onOff error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:25:01.026][Chambre L]setAttribute thermostat.localTemperature error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:25:01.027][Chambre L]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:25:01.027][Chambre L]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:25:01.027][Chambre L]setAttribute thermostat.systemMode error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:25:01.027][Chambre L]setAttribute fanControl.fanMode error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:25:01.027][Chambre L]setAttribute fanControl.rockSetting error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:25:01.027][Chambre L]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:25:01.027][Chambre E]setAttribute onOff.onOff error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:25:01.027][Chambre E]setAttribute thermostat.localTemperature error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:25:01.027][Chambre E]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:25:01.027][Chambre E]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:25:01.027][Chambre E]setAttribute thermostat.systemMode error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:25:01.028][Chambre E]setAttribute fanControl.fanMode error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:25:01.028][Chambre E]setAttribute fanControl.rockSetting error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:25:01.028][Chambre E]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:25:01.028][Combles]setAttribute onOff.onOff error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:25:01.028][Combles]setAttribute thermostat.localTemperature error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:25:01.028][Combles]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:25:01.028][Combles]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:25:01.028][Combles]setAttribute thermostat.systemMode error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:25:01.028][Combles]setAttribute fanControl.fanMode error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:25:01.028][Combles]setAttribute fanControl.rockSetting error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:25:01.028][Combles]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:25:01.028][Salon]setAttribute onOff.onOff error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:25:01.028][Salon]setAttribute thermostat.localTemperature error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:25:01.029][Salon]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:25:01.029][Salon]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:25:01.029][Salon]setAttribute thermostat.systemMode error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:25:01.029][Salon]setAttribute fanControl.fanMode error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:25:01.029][Salon]setAttribute fanControl.rockSetting error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:25:01.029][Salon]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
notice[16:25:01.029][PluginManager]Configured plugin matterbridge-ai-factory-melcloud-home-classic type DynamicPlatform
info[16:25:15.939][InteractionServer]Subscribe « @1:9031faf1e3eb55e4•b632⇵e95a fabricFiltered attributePaths: 1 eventPaths: 1
notice[16:25:15.940][Matterbridge]Session subscriptions changed on server node for Matterbridge: { name: '@1:9031faf1e3eb55e4•b632', nodeId: 2730738898137664774, peerNodeId: 10390361732138358244, fabric: { fabricIndex: 1, fabricId: 1, nodeId: 2730738898137664774, rootNodeId: 10390361732138358244, rootVendorId: 65521, label: 'Gladys Assistant' }, isPeerActive: true, lastInteractionTimestamp: 1782145470917, lastActiveTimestamp: 1782145470917, numberOfActiveSubscriptions: 0 }
notice[16:25:15.944][InteractionServer]Subscribe successful » @1:9031faf1e3eb55e4•b632⇵e95a 2↔1 sub#: 7d8629cd timing: 1s - 1m => 1m 4s sendInterval: 52s
notice[16:25:15.947][Matterbridge]Session subscriptions changed on server node for Matterbridge: { name: '@1:9031faf1e3eb55e4•b632', nodeId: 2730738898137664774, peerNodeId: 10390361732138358244, fabric: { fabricIndex: 1, fabricId: 1, nodeId: 2730738898137664774, rootNodeId: 10390361732138358244, rootVendorId: 65521, label: 'Gladys Assistant' }, isPeerActive: true, lastInteractionTimestamp: 1782145470917, lastActiveTimestamp: 1782145470917, numberOfActiveSubscriptions: 1 }
info[16:25:15.948][Transaction]Tx ◦reactor<Matterbridge.subscriptions.#addSubscription>#9d waiting on ◦reactor<Matterbridge.subscriptions.#subscriptionCancelled>#9b
info[16:25:30.841][Matterbridge]Setting reachability to true for Matterbridge
error[16:26:01.223][Chambre L]setAttribute onOff.onOff error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:26:01.223][Chambre L]setAttribute thermostat.localTemperature error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:26:01.224][Chambre L]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:26:01.224][Chambre L]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:26:01.224][Chambre L]setAttribute thermostat.systemMode error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:26:01.224][Chambre L]setAttribute fanControl.fanMode error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:26:01.224][Chambre L]setAttribute fanControl.rockSetting error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:26:01.224][Chambre L]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:26:01.224][Chambre E]setAttribute onOff.onOff error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:26:01.224][Chambre E]setAttribute thermostat.localTemperature error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:26:01.225][Chambre E]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:26:01.225][Chambre E]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:26:01.225][Chambre E]setAttribute thermostat.systemMode error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:26:01.225][Chambre E]setAttribute fanControl.fanMode error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:26:01.225][Chambre E]setAttribute fanControl.rockSetting error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:26:01.225][Chambre E]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:26:01.225][Combles]setAttribute onOff.onOff error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:26:01.225][Combles]setAttribute thermostat.localTemperature error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:26:01.225][Combles]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:26:01.225][Combles]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:26:01.225][Combles]setAttribute thermostat.systemMode error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:26:01.225][Combles]setAttribute fanControl.fanMode error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:26:01.225][Combles]setAttribute fanControl.rockSetting error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:26:01.225][Combles]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:26:01.225][Salon]setAttribute onOff.onOff error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:26:01.225][Salon]setAttribute thermostat.localTemperature error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:26:01.225][Salon]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:26:01.226][Salon]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:26:01.226][Salon]setAttribute thermostat.systemMode error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:26:01.226][Salon]setAttribute fanControl.fanMode error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:26:01.226][Salon]setAttribute fanControl.rockSetting error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:26:01.226][Salon]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
info[16:26:28.705][SystemCheck]Starting system check...
info[16:26:28.726][SystemCheck]System check succeeded
error[16:27:01.195][Chambre L]setAttribute onOff.onOff error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:27:01.195][Chambre L]setAttribute thermostat.localTemperature error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:27:01.195][Chambre L]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:27:01.195][Chambre L]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:27:01.195][Chambre L]setAttribute thermostat.systemMode error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:27:01.196][Chambre L]setAttribute fanControl.fanMode error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:27:01.196][Chambre L]setAttribute fanControl.rockSetting error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:27:01.196][Chambre L]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:27:01.196][Chambre E]setAttribute onOff.onOff error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:27:01.196][Chambre E]setAttribute thermostat.localTemperature error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:27:01.196][Chambre E]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:27:01.196][Chambre E]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:27:01.196][Chambre E]setAttribute thermostat.systemMode error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:27:01.196][Chambre E]setAttribute fanControl.fanMode error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:27:01.196][Chambre E]setAttribute fanControl.rockSetting error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:27:01.197][Chambre E]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:27:01.197][Combles]setAttribute onOff.onOff error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:27:01.197][Combles]setAttribute thermostat.localTemperature error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:27:01.197][Combles]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:27:01.197][Combles]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:27:01.197][Combles]setAttribute thermostat.systemMode error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:27:01.197][Combles]setAttribute fanControl.fanMode error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:27:01.197][Combles]setAttribute fanControl.rockSetting error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:27:01.197][Combles]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:27:01.197][Salon]setAttribute onOff.onOff error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:27:01.198][Salon]setAttribute thermostat.localTemperature error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:27:01.198][Salon]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:27:01.198][Salon]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:27:01.198][Salon]setAttribute thermostat.systemMode error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:27:01.198][Salon]setAttribute fanControl.fanMode error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:27:01.198][Salon]setAttribute fanControl.rockSetting error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:27:01.198][Salon]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:28:01.172][Chambre L]setAttribute onOff.onOff error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:28:01.172][Chambre L]setAttribute thermostat.localTemperature error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:28:01.172][Chambre L]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:28:01.172][Chambre L]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:28:01.173][Chambre L]setAttribute thermostat.systemMode error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:28:01.173][Chambre L]setAttribute fanControl.fanMode error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:28:01.173][Chambre L]setAttribute fanControl.rockSetting error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:28:01.173][Chambre L]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:28:01.173][Chambre E]setAttribute onOff.onOff error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:28:01.173][Chambre E]setAttribute thermostat.localTemperature error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:28:01.173][Chambre E]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:28:01.173][Chambre E]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:28:01.173][Chambre E]setAttribute thermostat.systemMode error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:28:01.173][Chambre E]setAttribute fanControl.fanMode error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:28:01.173][Chambre E]setAttribute fanControl.rockSetting error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:28:01.174][Chambre E]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:28:01.174][Combles]setAttribute onOff.onOff error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:28:01.174][Combles]setAttribute thermostat.localTemperature error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:28:01.174][Combles]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:28:01.174][Combles]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:28:01.174][Combles]setAttribute thermostat.systemMode error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:28:01.174][Combles]setAttribute fanControl.fanMode error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:28:01.174][Combles]setAttribute fanControl.rockSetting error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:28:01.174][Combles]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:28:01.174][Salon]setAttribute onOff.onOff error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:28:01.174][Salon]setAttribute thermostat.localTemperature error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:28:01.174][Salon]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:28:01.174][Salon]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:28:01.174][Salon]setAttribute thermostat.systemMode error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:28:01.174][Salon]setAttribute fanControl.fanMode error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:28:01.174][Salon]setAttribute fanControl.rockSetting error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:28:01.175][Salon]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:29:01.190][Chambre L]setAttribute onOff.onOff error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:29:01.191][Chambre L]setAttribute thermostat.localTemperature error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:29:01.191][Chambre L]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:29:01.191][Chambre L]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:29:01.191][Chambre L]setAttribute thermostat.systemMode error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:29:01.191][Chambre L]setAttribute fanControl.fanMode error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:29:01.191][Chambre L]setAttribute fanControl.rockSetting error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:29:01.191][Chambre L]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-fb0d343e-7517-4799-8750-07ba5eed86a5:9 is in the inactive state
error[16:29:01.191][Chambre E]setAttribute onOff.onOff error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:29:01.191][Chambre E]setAttribute thermostat.localTemperature error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:29:01.191][Chambre E]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:29:01.191][Chambre E]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:29:01.192][Chambre E]setAttribute thermostat.systemMode error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:29:01.192][Chambre E]setAttribute fanControl.fanMode error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:29:01.192][Chambre E]setAttribute fanControl.rockSetting error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:29:01.192][Chambre E]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-e20321ba-ddc0-4fb3-b3ba-609f4ea2dfc3:10 is in the inactive state
error[16:29:01.192][Combles]setAttribute onOff.onOff error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:29:01.192][Combles]setAttribute thermostat.localTemperature error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:29:01.192][Combles]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:29:01.192][Combles]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:29:01.192][Combles]setAttribute thermostat.systemMode error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:29:01.192][Combles]setAttribute fanControl.fanMode error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:29:01.192][Combles]setAttribute fanControl.rockSetting error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:29:01.192][Combles]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-dbab9f2b-ba2e-411d-944b-68a4398425b9:11 is in the inactive state
error[16:29:01.192][Salon]setAttribute onOff.onOff error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:29:01.192][Salon]setAttribute thermostat.localTemperature error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:29:01.192][Salon]setAttribute thermostat.occupiedHeatingSetpoint error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:29:01.192][Salon]setAttribute thermostat.occupiedCoolingSetpoint error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:29:01.192][Salon]setAttribute thermostat.systemMode error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:29:01.192][Salon]setAttribute fanControl.fanMode error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:29:01.193][Salon]setAttribute fanControl.rockSetting error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
error[16:29:01.193][Salon]setAttribute temperatureMeasurement.measuredValue error: Endpoint home-9b585aff-fe3d-46b9-a853-bd30c3597910:12 is in the inactive state
```

Here are some data which are displayed in the webapp : 
<img width="723" height="794" alt="Image" src="https://github.com/user-attachments/assets/353c533e-cd4b-4e81-837d-c4e7f5cdb342" />

Could you check and correct what is wrong ?


Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-melcloud-home-classic 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.