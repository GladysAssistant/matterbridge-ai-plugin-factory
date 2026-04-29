Fix bug in matterbridge-ai-factory-daikin-onecta. Be concise, write code not explanations.

Bug report:
We're simply asking the AI ​​to create a plugin for Matterbridge based on all these options.

And if this isn't the right solution for authentication, why is it also offered here: https://www.npmjs.com/package/@mp-consulting/homebridge-daikin-cloud

Also, I tried the API authentication method, but it didn't work as expected.

If you wish, you can post a prompt so that the AI ​​can properly develop this plugin for Matterbridge, or you can directly propose a Matterbridge plugin without going through the AI.

For your information, I am not a developer and I am simply trying to find working solution with the help of AI.



Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-daikin-onecta 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.