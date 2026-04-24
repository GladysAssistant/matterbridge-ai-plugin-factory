Fix bug in matterbridge-ai-factory-daikin-onecta. Be concise, write code not explanations.

Bug report:
J'ai eu un message au moment ou j'ai configuré mon identifiant et mon mot de passe indiquant que mon compte devait être enregistré.
Je n'ai malheureusement pas pris de capture d'écran du message d'erreur et je ne me souviens plus du message d'erreur exact.

Par contre j'ai testé mes identifiants directement dans homebridge et au moment de la connexion, homebridge effectue un test de connexion et on reçoit un email de daikin demandant de vérifier le compte : 

<img width="769" height="547" alt="Image" src="https://github.com/user-attachments/assets/9e6bd3a3-f557-4ef7-8860-8a3e842d9683" />

Après avoir cliqué sur "Verify my account" j'ai été redirigé sur le site de daikin (https://id.daikin.eu/cdc/onecta/oidc/registration-login.html?emailVerification=true&lang=en&errorCode=0) indiquant que la vérification avait réussi

<img width="483" height="180" alt="Image" src="https://github.com/user-attachments/assets/93d48ef3-6039-4606-9c46-658070cdf6b4" />

Homebridge indiquait que la connexion avait réussi
J'ai cliqué sur revoke session sur homebridge et j'ai éteint homebridge.

J'ai relancé matterbridge et j'ai de nouveau rentré mes identifiants et la tout à fonctionné directement :

<img width="692" height="229" alt="Image" src="https://github.com/user-attachments/assets/c7a08310-8342-4720-9c48-687b34893cdd" />

Je ne sais pas si on doit effectuer de nouveau la vérification mais peux-tu corriger le problème pour que l'on recoive bien le mail de daikin pour effectuer la vérification comme le fait le plugin homebridge ?

Ce problème est toujours présent également : 

```
Il y a également un problème losque l'on fait un docker compose down et un docker compose up -d, le docker matterbridge ne se relance pas et il y a le message suivant (Le problème est non présent quand on restart matterbridge via l'interface web) :
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


The user attached 3 image(s). Read them BEFORE fixing (use the Read tool; Claude Code supports image files):
1. /tmp/matterbridge-feedback-images-8-1777018190608/feedback-image-1.png
2. /tmp/matterbridge-feedback-images-8-1777018190608/feedback-image-2.png
3. /tmp/matterbridge-feedback-images-8-1777018190608/feedback-image-3.png

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-daikin-onecta 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.