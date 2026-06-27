Fix bug in matterbridge-ai-factory-enphase-envoy-iq-gateway-onduleurs-solaires-batteries. Be concise, write code not explanations.

Bug report:
With your latest version the solar panel are missing.

In Matterbridge I have the devices:

- SolarPower (0x0017)
- ElectricalSensor (0x0510)
- TemperatureSensor (0x0302)
- ContactSensor (0x0015)

Another issue:
- Solar Production is 0 Kwh

My logs are  :
```
info[11:58:18.311][PluginManager]Configuring plugin matterbridge-ai-factory-enphase-envoy-iq-gateway-onduleurs-solaires-batteries type DynamicPlatform
info[11:58:18.330][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]onConfigure called
info[11:58:18.646][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Discovered Envoy serial number 122246006597 from /info.xml
info[11:58:21.291][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Obtained Enlighten JWT token for the Envoy gateway
info[11:58:28.539][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Update endpoint SolarProduction--prod:20 attribute ElectricalPowerMeasurement.activePower from null to 2201113
info[11:58:28.547][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Update endpoint SolarProduction--prod:20 attribute ElectricalEnergyMeasurement.cumulativeEnergyExported from { energy: 0, startTimestamp: undefined, endTimestamp: undefined, startSystime: undefined, endSystime: undefined, apparentEnergy: undefined, reactiveEnergy: undefined } to { energy: 9819813875 }
info[11:58:28.552][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Update endpoint EnvoyConsumption-:21 attribute ElectricalPowerMeasurement.activePower from null to -611913
info[11:58:28.557][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Update endpoint EnvoyConsumption-:21 attribute ElectricalEnergyMeasurement.cumulativeEnergyImported from null to { energy: 12150264840 }
notice[11:58:28.559][PluginManager]Configured plugin matterbridge-ai-factory-enphase-envoy-iq-gateway-onduleurs-solaires-batteries type DynamicPlatform
info[11:58:48.311][Matterbridge]Setting reachability to true for Matterbridge
info[11:59:04.492][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Update endpoint SolarProduction--prod:20 attribute ElectricalPowerMeasurement.activePower from 2201113 to 2207178
info[11:59:04.497][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Update endpoint SolarProduction--prod:20 attribute ElectricalEnergyMeasurement.cumulativeEnergyExported from { energy: 9819813875, startTimestamp: undefined, endTimestamp: undefined, startSystime: undefined, endSystime: undefined, apparentEnergy: undefined, reactiveEnergy: undefined } to { energy: 9819836752 }
info[11:59:04.502][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Update endpoint EnvoyConsumption-:21 attribute ElectricalPowerMeasurement.activePower from -611913 to -629480
info[11:59:04.507][Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries) - read-only sensors]Update endpoint EnvoyConsumption-:21 attribute ElectricalEnergyMeasurement.cumulativeEnergyImported from { energy: 12150264840, startTimestamp: undefined, endTimestamp: undefined, startSystime: undefined, endSystime: undefined, apparentEnergy: undefined, reactiveEnergy: undefined } to { energy: 12150258112 }
```

Your are usefull information on solar information here: https://www.home-assistant.io/integrations/enphase_envoy

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-enphase-envoy-iq-gateway-onduleurs-solaires-batteries 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.