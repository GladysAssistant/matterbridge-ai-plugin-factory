Fix bug in matterbridge-ai-factory-po-le-palazzetti. Be concise, write code not explanations.

Bug report:
Please test the plugin and report back:

Plugin installs correctly - Ok

Device discovery works - Ok

Basic controls function -
J'ai la temperature de consigne, en revanche je n'ai pas l'état " Status" du poêle
Je n'ai pas le commutateur pour allumer / Eteindre le poêle

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-po-le-palazzetti 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.