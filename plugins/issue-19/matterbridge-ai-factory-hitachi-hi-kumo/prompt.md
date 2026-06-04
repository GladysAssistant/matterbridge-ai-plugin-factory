Fix bug in matterbridge-ai-factory-hitachi-hi-kumo. Be concise, write code not explanations.

Bug report:
Le plugin s'est bien installé, j'ai pu entrer mes identifiants et choisir ma région.
Par contre, je ne vois pas mes climatisations remonter dans la liste des appareils.

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-hitachi-hi-kumo 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.