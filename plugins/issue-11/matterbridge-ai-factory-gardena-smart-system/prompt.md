Fix bug in matterbridge-ai-factory-gardena-smart-system. Be concise, write code not explanations.

Bug report:
Encore KO pour le device SENSOR

J'ai fais des tests de mon côté et j'ai modifié ce bout de code : 
`/** Build and register Matter endpoints for one Gardena device. */
    async registerGardenaDevice(device) {
        const baseSerial = device.serial ?? device.id;
        const types = [...device.serviceTypes].join(',');
        this.log.info(`Gardena: device "${device.name}" (${device.id}) services=[${types}]`);
        let exposed = 0;
        for (const svc of device.services.values()) {
        this.log.info(`Gardena: Test device "${device.name}" service=[${svc.type}]`);
            if (svc.type === 'POWER_SOCKET') {
                await this.registerPowerSocket(device, svc, baseSerial);
                exposed++;
            }
            else if (svc.type === 'VALVE') {
                await this.registerValve(device, svc, baseSerial);
                exposed++;
            }
            else if (svc.type === 'SENSOR') {
                await this.registerSensor(device, svc, baseSerial);
                exposed++;
            }
            else if (svc.type === 'COMMON') {
                this.log.info(`this is common`);
                exposed++;
            }
        }
        if (exposed === 0) {
            this.log.warn(`Gardena: device "${device.name}" exposes no supported service types (got: ${types || 'none'})`);
        }
    }`

J'ai rajouté le elseif COMMON et des log, j'obtiens ça :
`info[15:45:34.120][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]onStart (Matterbridge is starting)
info[15:45:34.619][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: location "GARDENA smart Garden" with 2 devices
info[15:45:34.620][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: device "Sensor" (623803c1-1474-41ce-939c-f73cee308604) services=[SENSOR,COMMON]
info[15:45:34.621][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: Test device "Sensor" service=[COMMON]
info[15:45:34.621][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]this is common
info[15:45:34.621][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: device "Pompe" (8be911b9-ec40-47da-ba12-8c457e3bd21c) services=[VALVE_SET,VALVE,COMMON]
info[15:45:34.621][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: Test device "Pompe" service=[VALVE_SET]
info[15:45:34.622][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: Test device "Pompe" service=[VALVE]
info[15:45:34.661][ScenesManagementServer]Registered 1 scene attributes for Cluster onOff on Endpoint gardena-valve-8be911b9-ec40-47da-ba12-8c457e3bd21c:0
info[15:45:34.664][Pompe]Initializing MatterbridgePowerSourceServer (endpoint gardena-valve-8be911b9-ec40-47da-ba12-8c457e3bd21c:0.120)
info[15:45:34.677][Endpoint]Matterbridge.Matterbridge.gardena-valve-8be911b9-ec40-47da-ba12-8c457e3bd21c:0 ready endpoint#: 120 type: MA_onoffpluginunit (0x010a, rev 4) behaviors: ✓descriptor ✓matterbridge ✓bridgedDeviceBasicInformation ✓powerSource ✓identify ✓groups ✓scenesManagement ✓onOff
info[15:45:34.678][Matterbridge]Subscribing attributes for endpoint Pompe (gardena-valve-8be911b9-ec40-47da-ba12-8c457e3bd21c:0) plugin matterbridge-ai-factory-gardena-smart-system
info[15:45:34.679][Matterbridge]Added and registered bridged endpoint (1) Pompe (gardena-valve-8be911b9-ec40-47da-ba12-8c457e3bd21c:0) for plugin matterbridge-ai-factory-gardena-smart-system
info[15:45:34.679][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: Test device "Pompe" service=[COMMON]
info[15:45:34.679][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]this is common
info[15:45:34.815][Matterbridge plugin for Gardena Smart System (pumps, soil sensors) using Husqvarna Cloud API and websocket.]Gardena: connecting websocket`

Je ne comprends pas pourquoi le programme ne boucle pas sur SENSOR


Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-gardena-smart-system 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.