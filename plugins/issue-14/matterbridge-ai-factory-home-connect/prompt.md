Fix bug in matterbridge-ai-factory-home-connect. Be concise, write code not explanations.

Bug report:
No device comes up.
A server choice and token exchange step is missing in matterbridge :

For exemple in Homebridge : 

1- On the Homebridge UI Plugins page search for and install the HomeConnect plugin.
2- Open the HomeConnect plugin settings and set the Client ID to the value obtained from the Home Connect Developer Program for the created Device Flow application.
3- If you are located within China then set the Server Location to China, otherwise leave it as Worldwide.
4- Click on the AUTHORIZE button to open a new Home Connect browser window. Login to your Home Connect account and approve access.
5- Save the plugin settings and restart Homebridge.

We should be able to do the same thing on Matterbridge

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-home-connect 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.