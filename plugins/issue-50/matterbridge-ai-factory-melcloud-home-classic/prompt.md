Fix bug in matterbridge-ai-factory-melcloud-home-classic. Be concise, write code not explanations.

Bug report:
It seems that there is an issue with the update of the devices in Gladys.
Everytime I disable the plugin in matterbridge, then enable it again, I have new endpoints for the devices, which is normal, with same serial number and unique ID than previous devices.
But in Gladys I have new device to add, nothing to update : 
<img width="896" height="612" alt="Image" src="https://github.com/user-attachments/assets/bd1b119a-a5da-443d-9ee5-a4329a85ce0a" />

<img width="881" height="734" alt="Image" src="https://github.com/user-attachments/assets/9bceb212-7979-4b82-8ca0-2131d58d1a46" />

<img width="1570" height="142" alt="Image" src="https://github.com/user-attachments/assets/cad4a80b-72cd-46fc-9d18-9c774ec2e6d1" />

It seems that the 4 last figures are missing in the serial number in Gladys : `9b585aff-fe3d-46b9-a853-bd30c359` instead of `9b585aff-fe3d-46b9-a853-bd30c3597910`.

Could you check that and find out why it is considered as new device instead of device to update ?
Don't change the rest of the code as I haven't done new tests yet.

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-melcloud-home-classic 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.