Fix bug in matterbridge-ai-factory-smappee-ev-wall-home. Be concise, write code not explanations.

Bug report:
I need you to fix a structural bug in the `matterbridge-ai-factory-smappee-ev-wall-home` plugin. 

**The Problem:**
Currently, the plugin exposes the Smappee metering data using the `PowerSource` cluster. A core developer of the Gladys Assistant controller reviewed the behavior and confirmed this is the wrong cluster. `PowerSource` is meant to describe how a device is powered, not to stream energy consumption data. As a result, the device cannot be integrated properly into standard Matter controllers for energy tracking.

**The Goal:**
The primary purpose of this plugin is to report energy data from the Smappee API (which I can see in my Smappee app). I need to track:
1. House global consumption
2. EV Wall / Car charging consumption
3. Solar production

**Required Changes:**
Please rewrite the endpoint generation and cluster implementation with the following instructions:
1. **Remove `PowerSource`**: Stop using the `PowerSource` cluster for energy reporting.
2. **Implement Measurement Clusters**: Expose the Smappee API data using the `ElectricalPowerMeasurement` cluster (for real-time power in Watts/kW) and the `ElectricalEnergyMeasurement` cluster (for accumulated energy in kWh/Wh).
3. **Map the API properly**: Ensure the Smappee API values for House, EV, and Solar are correctly bound to these new clusters on distinct endpoints so the Matter controller can differentiate them.

Please update the code accordingly and ensure it compiles correctly with the latest Matter.js / Matterbridge SDK.

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-smappee-ev-wall-home 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.