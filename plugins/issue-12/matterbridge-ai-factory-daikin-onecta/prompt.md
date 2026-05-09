Fix bug in matterbridge-ai-factory-daikin-onecta. Be concise, write code not explanations.

Bug report:
I have this in the logs:

error[16:49:17.360][Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners]Failed to fetch Daikin devices: Authorization time out

There is no option to validate the token.

There are actions that the user needs to perform manually.

The Homebridge plugin allows you to open a web page on the Daikin website via an Authorization URL (Example: https://idep.onecta.daikineurope.com/v1/oidc/authorize?response_type=client_id=........&redirect_uri=....&scope=openid+onecta....&state=.....)
This page waits for authentication and returns the token to the Redirect URI after acceptance on the page https://idp.onecta.daikineurope.com/va/oidc/consent

You should be able to find an example of this plugin that does what I just described: https://www.npmjs.com/package/@mp-consulting/homebridge-daikin-cloud

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-daikin-onecta 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.