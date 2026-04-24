Fix bug in matterbridge-ai-factory-daikin-onecta. Be concise, write code not explanations.

Bug report:
Quand je fais On pour allumer la climatisation cela fonctionne bien mais le commutateur repasse sur off et la clim reste allumée.
Par contre quand je fais off, la climatisation ne s'éteind pas.
Quand j'eteinds la climatisation depuis l'application Daikin, le statut se mets bien a jour sur l'application, mais quand je tente de rallumer l'appareil sur matterbridge la commande n'est pas envoyé.

Voici les logs :

```
info[17:34:53.538][InteractionServer]Invoke « @1:299a6a0791661768•f8c0⇵c7c4 invokes: MA_airConditioner:0x5.OnOff:0x6.off:0x0
info[17:34:53.540][ProtocolService]Invoke « Matterbridge.Matterbridge.daikin-a585a261-bd36-4715-9544-ac49edf0a57e.onOff.off @1:299a6a0791661768•f8c0⇵c7c4✉036575e0 (no payload)
info[17:34:53.540][Climatiseur Oullins]Switching device off (endpoint daikin-a585a261-bd36-4715-9544-ac49edf0a57e.5)
info[17:34:53.540][Matterbridge plugin for Daikin Onecta air conditioners (On/Off, thermostat, heating/cooling/auto mode).][Climatiseur Oullins] OFF
info[17:34:55.235][InteractionServer]Invoke « @1:299a6a0791661768•f8c0⇵c7c5 invokes: MA_airConditioner:0x5.OnOff:0x6.on:0x1
info[17:34:55.235][ProtocolService]Invoke « Matterbridge.Matterbridge.daikin-a585a261-bd36-4715-9544-ac49edf0a57e.onOff.on @1:299a6a0791661768•f8c0⇵c7c5✉036575e2 (no payload)
info[17:34:55.236][Climatiseur Oullins]Switching device on (endpoint daikin-a585a261-bd36-4715-9544-ac49edf0a57e.5)
info[17:34:55.236][Matterbridge plugin for Daikin Onecta air conditioners (On/Off, thermostat, heating/cooling/auto mode).][Climatiseur Oullins] ON
info[17:34:55.406][Transaction]Tx ◦setStateOf<Matterbridge.Matterbridge.daikin-a585a261-bd36-4715-9544-ac49edf0a57e>#72 waiting on @1:299a6a0791661768•f8c0⇵c7c5✉036575e2
info[17:35:12.890][Transaction]Tx ◦setStateOf<Matterbridge.Matterbridge.daikin-a585a261-bd36-4715-9544-ac49edf0a57e>#73 waiting on @1:299a6a0791661768•f8c0⇵c7c5✉036575e2
info[17:35:14.031][InteractionServer]Invoke « @1:299a6a0791661768•f8c0⇵c7c6 invokes: MA_airConditioner:0x5.OnOff:0x6.off:0x0
info[17:35:14.031][ProtocolService]Invoke « Matterbridge.Matterbridge.daikin-a585a261-bd36-4715-9544-ac49edf0a57e.onOff.off @1:299a6a0791661768•f8c0⇵c7c6✉036575e4 (no payload)
info[17:35:14.032][Transaction]Tx @1:299a6a0791661768•f8c0⇵c7c6✉036575e4 waiting on @1:299a6a0791661768•f8c0⇵c7c5✉036575e2
info[17:36:12.891][Transaction]Tx ◦setStateOf<Matterbridge.Matterbridge.daikin-a585a261-bd36-4715-9544-ac49edf0a57e>#74 waiting on @1:299a6a0791661768•f8c0⇵c7c5✉036575e2
info[17:36:22.772][InteractionServer]Invoke « @1:299a6a0791661768•f8c0⇵c7c7 invokes: MA_airConditioner:0x5.OnOff:0x6.on:0x1
info[17:36:22.773][ProtocolService]Invoke « Matterbridge.Matterbridge.daikin-a585a261-bd36-4715-9544-ac49edf0a57e.onOff.on @1:299a6a0791661768•f8c0⇵c7c7✉036575e6 (no payload)
info[17:36:22.773][Transaction]Tx @1:299a6a0791661768•f8c0⇵c7c7✉036575e6 waiting on @1:299a6a0791661768•f8c0⇵c7c5✉036575e2
info[17:36:34.480][InteractionServer]Invoke « @1:299a6a0791661768•f8c0⇵c7c8 invokes: MA_airConditioner:0x5.OnOff:0x6.off:0x0
info[17:36:34.481][ProtocolService]Invoke « Matterbridge.Matterbridge.daikin-a585a261-bd36-4715-9544-ac49edf0a57e.onOff.off @1:299a6a0791661768•f8c0⇵c7c8✉036575e7 (no payload)
info[17:36:34.481][Transaction]Tx @1:299a6a0791661768•f8c0⇵c7c8✉036575e7 waiting on @1:299a6a0791661768•f8c0⇵c7c5✉036575e2
```



Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-daikin-onecta 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.