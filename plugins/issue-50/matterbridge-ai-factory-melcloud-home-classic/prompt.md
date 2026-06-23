Fix bug in matterbridge-ai-factory-melcloud-home-classic. Be concise, write code not explanations.

Bug report:
Something is wrong : I see 8 devices even if 4 are usable.
<img width="1264" height="574" alt="Image" src="https://github.com/user-attachments/assets/0409ca1c-325d-4636-9765-2abe1509e7cc" />
And the devices are still in adding mode instead of update !
Why do you add caracters in serial number whereas we need less ???
Do it the simplest as you can or find another way !

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-melcloud-home-classic 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.