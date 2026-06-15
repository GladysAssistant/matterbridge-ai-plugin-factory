Fix bug in matterbridge-ai-factory-withings-balances-tensiom-tres-montres-capteurs-sommeil. Be concise, write code not explanations.

Bug report:
Il faut que tu puisses fournir dans les logs l'url d'authorisation de ce type afin de récuperer l'Authorization Code et passer à l'étape suivante qui est "Request Access and Refresh Tokens"

https://account.withings.com/oauth2_user/authorize2?response_type=code&client_id=YOUR_CLIENT_ID&scope=user.info,user.metrics,user.activity&redirect_uri=YOUR_REDIRECT_URI&state=YOUR_STATE

Tout est indiqué ici : https://developer.withings.com/api-reference/

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-withings-balances-tensiom-tres-montres-capteurs-sommeil 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.