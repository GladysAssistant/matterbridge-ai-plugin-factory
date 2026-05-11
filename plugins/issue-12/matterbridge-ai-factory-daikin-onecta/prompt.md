Fix bug in matterbridge-ai-factory-daikin-onecta. Be concise, write code not explanations.

Bug report:
The token was successfully retrieved after going to https://192.168.xx.xx:8567, and I have the following logs:

```
notice[19:10:02.915][PluginManager]Configured plugin matterbridge-ai-factory-daikin-onecta type DynamicPlatform
notice[19:10:10.495][Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners]Daikin Onecta authorization succeeded; token stored.
info[19:10:10.871][Matterbridge plugin for Daikin Onecta cloud (BRP069C4x) air conditioners]Discovered 1 Daikin device(s)
```

However, I don't see anything in the Devices tab under Matterbridge, and I only see this in the Home tab:

<img width="1511" height="144" alt="Image" src="https://github.com/user-attachments/assets/e23fd8ae-c744-4aca-8fa5-dd925d3fa334" />

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-daikin-onecta 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.