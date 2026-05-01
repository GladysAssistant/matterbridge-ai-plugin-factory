Fix bug in matterbridge-ai-factory-po-le-palazzetti. Be concise, write code not explanations.

Bug report:
Dans Matterbridge j'ai maintenant les "Devices" suivants

- Main = Online
- Main = AC
- Thermostat = 20
- OnOff = Off
- Statut = Opened

Dans Gladys j'ai les objets suivants

- Commutateur = Off
- Commutateur = Pas de valeur
- Temperature  Pas de valeur

Ni le commutateur, ni le reglage de température depuis Gladys n'a d'effet sur le poêle


Dans le log MatterBridge j'ai ce warning

- 21:21:16.192][Matterbridge plugin for Palazzetti pellet stoves (WPalaControl / Connection Box)]Command "GET ALLS" error: fetch failed


l'IP de la ConnectBox de mon poele est : http://192.168.0.43

Peut être faut il que je puisse paramétrer cet IP dans le PlugIn ?

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-po-le-palazzetti 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.