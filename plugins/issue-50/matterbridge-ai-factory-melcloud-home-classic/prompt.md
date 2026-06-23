Fix bug in matterbridge-ai-factory-melcloud-home-classic. Be concise, write code not explanations.

Bug report:
This fix doesn't work.
I deleted all devices.
Then added new ones.
I turn off the melcloud plugin, restart matterbridge, turn on plugin.
In GLadys I still have new device to add : 
<img width="905" height="746" alt="Image" src="https://github.com/user-attachments/assets/1e20d624-2087-4ab9-ad6e-dff0ecf69904" />

<img width="452" height="587" alt="Image" src="https://github.com/user-attachments/assets/2421aaaa-0dbf-4f72-a766-04130ef5fda3" />

<img width="427" height="726" alt="Image" src="https://github.com/user-attachments/assets/7e17bb7e-c396-402c-ad54-a0542246820d" />

<img width="1572" height="287" alt="Image" src="https://github.com/user-attachments/assets/965f53ce-cc0b-4563-8bf7-e94aae18a9ca" />

Please find another solution to be sure that those "new" devices are in fact the same as the previous ones saved in Gladys.


Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-melcloud-home-classic 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.