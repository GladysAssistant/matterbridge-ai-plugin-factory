Fix bug in matterbridge-ai-factory-freebox-player-delta-devialet-and-r-volution-freeboxos-player-api. Be concise, write code not explanations.

Bug report:
## Test Results v1.0.0

✅ Plugin installs correctly
✅ Authentication flow works (notification appeared on Freebox front panel)
✅ Device discovered and visible in Gladys via Matter
❌ On/off switch not functional (no response when toggled)
❌ Only 1 feature exposed (on/off switch) instead of expected 4
❌ Volume, media control, play/pause, channel change, remote keys 
   not exposed as Matter clusters

## Environment
- Freebox Player Delta (Devialet)
- Matterbridge 3.7.8 bridge mode
- Gladys Assistant with Matter integration

## Requested fixes for v2
1. Fix on/off control (power toggle via AirPlay TCP:7000 probe + WOL or API)
2. Expose volume as Matter LevelControl cluster
3. Expose media controls (play/pause/stop) as Matter MediaPlayback cluster  
4. Expose channel change as Matter Channel cluster
5. Expose remote keys if possible

The authentication and discovery work perfectly — 
the foundation is solid, just needs the Matter clusters properly implemented.

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-freebox-player-delta-devialet-and-r-volution-freeboxos-player-api 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.