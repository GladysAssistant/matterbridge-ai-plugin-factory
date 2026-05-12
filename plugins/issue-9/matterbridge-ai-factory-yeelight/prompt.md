Fix bug in matterbridge-ai-factory-yeelight. Be concise, write code not explanations.

Bug report:
Still no luck. I'm still seeing both the log errors and the switch issue.

Below the logs:
info[21:40:23.949][InteractionServer]Invoke « @1:d5ad5818d5a67aa9•396c⇵7c9a invokes: MA_extendedcolorlight:0xc.OnOff:0x6.off:0x0
info[21:40:23.949][ProtocolService]Invoke « Matterbridge.Matterbridge.yeelight-192-168-0-200.onOff.off @1:d5ad5818d5a67aa9•396c⇵7c9a✉0a7f618d (no payload)
info[21:40:23.950][Led_couloir]Switching device off (endpoint yeelight-192-168-0-200.12)
info[21:40:24.021][Transaction]Tx ◦setStateOf<Matterbridge.Matterbridge.yeelight-192-168-0-200>#e9 waiting on ◦setStateOf<Matterbridge.Matterbridge.yeelight-192-168-0-200>#e8
info[21:40:24.021][Transaction]Tx ◦setStateOf<Matterbridge.Matterbridge.yeelight-192-168-0-200>#ea waiting on ◦setStateOf<Matterbridge.Matterbridge.yeelight-192-168-0-200>#e8
error[21:40:24.022][Transaction]Rolling back ◦setStateOf<Matterbridge.Matterbridge.yeelight-192-168-0-200>#e7 due to pre-commit error: State has not settled after 5 pre-commit cycles which likely indicates an infinite loop
error[21:40:24.023][Transaction]Rolling back ◦setStateOf<Matterbridge.Matterbridge.yeelight-192-168-0-200>#e8 due to pre-commit error: State has not settled after 5 pre-commit cycles which likely indicates an infinite loop
info[21:40:24.024][Transaction]Tx ◦setStateOf<Matterbridge.Matterbridge.yeelight-192-168-0-200>#ea waiting on ◦setStateOf<Matterbridge.Matterbridge.yeelight-192-168-0-200>#e9
error[21:40:24.025][Transaction]Rolling back ◦setStateOf<Matterbridge.Matterbridge.yeelight-192-168-0-200>#e9 due to pre-commit error: State has not settled after 5 pre-commit cycles which likely indicates an infinite loop
error[21:40:24.027][Transaction]Rolling back ◦setStateOf<Matterbridge.Matterbridge.yeelight-192-168-0-200>#ea due to pre-commit error: State has not settled after 5 pre-commit cycles which likely indicates an infinite loop
error[21:40:24.030][Matterbridge]Unhandled Rejection detected: [object Promise]reason: State has not settled after 5 pre-commit cycles which likely indicates an infinite loopstack: [unsettled-state] State has not settled after 5 pre-commit cycles which likely indicates an infinite loop at nextCycle (file:///usr/local/l ... action/Tx.js:466:11) at executePreCommit (file:///usr/local/l ... action/Tx.js:485:28) at #executeCommitCycle (file:///usr/local/l ... action/Tx.js:349:49) at Tx.commit (file:///usr/local/l ... action/Tx.js:266:44) at Tx.resolve (file:///usr/local/l ... action/Tx.js:280:22) at process.processTicksAndRejections (node:internal/process/task_queues:105:5) at async MatterbridgeEndpoint.setStateOf (file:///usr/local/l ... t/Endpoint.js:265:5) at async updateAttribute (file:///usr/local/l ... intHelpers.js:591:5) at async MatterbridgeEndpoint.updateAttribute (file:///usr/local/l ... eEndpoint.js:231:16)
error[21:40:24.031][Matterbridge]Unhandled Rejection detected: [object Promise]reason: State has not settled after 5 pre-commit cycles which likely indicates an infinite loopstack: [unsettled-state] State has not settled after 5 pre-commit cycles which likely indicates an infinite loop at nextCycle (file:///usr/local/l ... action/Tx.js:466:11) at executePreCommit (file:///usr/local/l ... action/Tx.js:485:28) at #executeCommitCycle (file:///usr/local/l ... action/Tx.js:349:49) at Tx.commit (file:///usr/local/l ... action/Tx.js:266:44) at Tx.resolve (file:///usr/local/l ... action/Tx.js:280:22) at process.processTicksAndRejections (node:internal/process/task_queues:105:5) at async MatterbridgeEndpoint.setStateOf (file:///usr/local/l ... t/Endpoint.js:265:5) at async updateAttribute (file:///usr/local/l ... intHelpers.js:591:5) at async MatterbridgeEndpoint.updateAttribute (file:///usr/local/l ... eEndpoint.js:231:16)
error[21:40:24.032][Matterbridge]Unhandled Rejection detected: [object Promise]reason: State has not settled after 5 pre-commit cycles which likely indicates an infinite loopstack: [unsettled-state] State has not settled after 5 pre-commit cycles which likely indicates an infinite loop at nextCycle (file:///usr/local/l ... action/Tx.js:466:11) at executePreCommit (file:///usr/local/l ... action/Tx.js:485:28) at #executeCommitCycle (file:///usr/local/l ... action/Tx.js:349:49) at Tx.commit (file:///usr/local/l ... action/Tx.js:266:44) at Tx.resolve (file:///usr/local/l ... action/Tx.js:280:22) at process.processTicksAndRejections (node:internal/process/task_queues:105:5) at async MatterbridgeEndpoint.setStateOf (file:///usr/local/l ... t/Endpoint.js:265:5) at async updateAttribute (file:///usr/local/l ... intHelpers.js:591:5) at async MatterbridgeEndpoint.updateAttribute (file:///usr/local/l ... eEndpoint.js:231:16)
error[21:40:24.033][Matterbridge]Unhandled Rejection detected: [object Promise]reason: State has not settled after 5 pre-commit cycles which likely indicates an infinite loopstack: [unsettled-state] State has not settled after 5 pre-commit cycles which likely indicates an infinite loop at nextCycle (file:///usr/local/l ... action/Tx.js:466:11) at executePreCommit (file:///usr/local/l ... action/Tx.js:485:28) at #executeCommitCycle (file:///usr/local/l ... action/Tx.js:349:49) at Tx.commit (file:///usr/local/l ... action/Tx.js:266:44) at Tx.resolve (file:///usr/local/l ... action/Tx.js:280:22) at process.processTicksAndRejections (node:internal/process/task_queues:105:5) at async MatterbridgeEndpoint.setStateOf (file:///usr/local/l ... t/Endpoint.js:265:5) at async updateAttribute (file:///usr/local/l ... intHelpers.js:591:5) at async MatterbridgeEndpoint.updateAttribute (file:///usr/local/l ... eEndpoint.js:231:16)
info[21:42:18.237][DockerVersion]Starting docker version check...
info[21:42:18.241][CheckUpdates]Starting check updates...
info[21:42:18.613][CheckUpdates]Check updates succeeded
info[21:42:24.311][DockerVersion]Docker version check succeeded: latest=undefined, dev=3.7.9, current=unknown

I’ve also observed that the device state in Matterbridge stays 'OFF' when triggered via Matter, whereas it updates correctly when using the Yeelight app. This could be a key clue to finding the root cause.

<img width="486" height="317" alt="Image" src="https://github.com/user-attachments/assets/cabb9165-3d56-46a5-a9f4-5a0ab427334c" />

Fix the code, then test:
```bash
npm run build && npm install -g . && timeout 30 matterbridge -add matterbridge-ai-factory-yeelight 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
```

Not done until matterbridge starts without errors.