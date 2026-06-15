Fix bug in matterbridge-ai-factory-withings-balances-tensiom-tres-montres-capteurs-sommeil. Be concise, write code not explanations.

Bug report:
J'ai configuré Withings Client ID et Withings Client Secret mais j'ai quand même ce message dans les logs : 

[13:04:43.151] [Matterbridge plugin exposing Withings devices (scales, blood pressure monitors, watches, sleep/Aura, thermo) as read-only Matter sensors] Withings credentials are not configured (clientId, clientSecret, refreshToken). No devices will be created. Complete the OAuth2 flow on https://developer.withings.com/ and fill the plugin config.

Le refreshToken est censé être recuperé en même temps que l'access token comme indiqué dans la documentation : 

`2. Obtain an access token: Exchange the authorization code for an access token and refresh token.`

Je ne peux donc pas finaliser la phase d'authentification initial

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-withings-balances-tensiom-tres-montres-capteurs-sommeil 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.