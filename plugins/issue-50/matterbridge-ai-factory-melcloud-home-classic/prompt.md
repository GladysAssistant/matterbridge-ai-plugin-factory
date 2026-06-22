Fix bug in matterbridge-ai-factory-melcloud-home-classic. Be concise, write code not explanations.

Bug report:
ok, here are my remarks : 
- in general, no initial value are taken from matterbridge : for instance on/ff is set to off even if the device is on
<img width="589" height="926" alt="Image" src="https://github.com/user-attachments/assets/f2a084a1-7c04-4c3c-acdf-e17d09ab637c" />

**In details :** 
- on/off works : 
<img width="589" height="79" alt="Image" src="https://github.com/user-attachments/assets/9c5b7a7f-dde8-4d52-a787-27117500bbfa" />

- fan controls speed don't work but steps are good : 0 to 5 
<img width="584" height="290" alt="Image" src="https://github.com/user-attachments/assets/ea9ef110-9c58-4c1f-bbd1-9321b1fbbb96" />

- "Mode vent" doesn't work
<img width="589" height="105" alt="Image" src="https://github.com/user-attachments/assets/79cef858-ac03-4ca8-beba-30871648d6d4" />

- "mode ventilateur" works but all speeds are not present : 
<img width="600" height="162" alt="Image" src="https://github.com/user-attachments/assets/f7021b1f-5875-4965-9392-a9d82a67ae16" />

 -> arret = speed 1 -> should send an Off command
 -> faible = speed 1
 -> moyen = speed 3
 -> fort = speed 5
 -> auto = auto 
-> we need 1, 2, 3, 4, 5 : is it possible ?

- "oscillation" works if we choose one but there are differences with the webapp in which we must choose 1 position on 5 or "balayage" for horizontal and vertical (auto is not working) : 
<img width="588" height="113" alt="Image" src="https://github.com/user-attachments/assets/d1bb8bc3-701a-4df8-b1a6-39a88539414e" />

<img width="500" height="722" alt="Image" src="https://github.com/user-attachments/assets/74efd2e1-9345-4d22-b05e-e7b64c17b302" />

<img width="499" height="743" alt="Image" src="https://github.com/user-attachments/assets/cd769aa1-1cd6-4fac-85f3-581ce15ab2be" />

- Setpoint works but I don't understand why there is Cooling and Heating setpoint separately, and why there is no possibilities to choose : cooling, heating, fan only, dry
<img width="600" height="157" alt="Image" src="https://github.com/user-attachments/assets/f31499b1-88ff-4e77-b50c-0ee73363fa7c" />

- TemperatureMeasurement and LocalTemperature seem to be the same value : 
<img width="592" height="78" alt="Image" src="https://github.com/user-attachments/assets/1b2ebfbb-02a1-45ac-9fb3-6e8b6ab1a67a" />

<img width="593" height="82" alt="Image" src="https://github.com/user-attachments/assets/72e472d2-b623-4ed5-b781-af07ba8837b1" />


For the next modifications  : 
- correct intial values
- add a README.me file with information about configuration, connection
- add also explanation for the different functionnalities with the different possible value if required
- add information on functionnalities that don't work
- don't forget to modify the MELCLoud classic code to reflect those changes
- try to get information about all devices like we have in the webapp : 
  - external device : model, serial number
  - air conditioning device : model, serial number
  - wifi module : model, serial number, MAC address
  - name of house

<img width="542" height="807" alt="Image" src="https://github.com/user-attachments/assets/0e5cf23b-257a-4db1-8a34-75bf6c2a2eec" />




Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-melcloud-home-classic 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.