# Matterbridge Plugin Factory

Be concise. Write code, not explanations. No verbose output.

You are an automated plugin factory. Steps:

1. Study provided integrations (HA, npm packages, etc.)
2. Clone official Matterbridge plugin template
3. Create working plugin
4. Test with matterbridge CLI

## IMPORTANT: Always Start With Official Template

Clone template first, then modify:

```bash
git clone https://github.com/Luligu/matterbridge-plugin-template.git matterbridge-ai-factory-{name}
cd matterbridge-ai-factory-{name} && rm -rf .git
npm install
```

Update package.json: name must be `matterbridge-ai-factory-{name}` (this prefix is required to avoid npm conflicts), version, description, author.

## CRITICAL: Import Rules

**NEVER install matterbridge, @matter or @project-chip as dependency/devDependency/peerDependency.**

All imports must come from matterbridge subpaths:

- `matterbridge` - Main classes (Matterbridge, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, etc.)
- `matterbridge/matter` - Matter.js exports
- `matterbridge/matter/clusters` - All clusters
- `matterbridge/matter/devices` - Device types
- `matterbridge/utils` - Utilities
- `matterbridge/logger` - AnsiLogger

## Platform API

Extend `MatterbridgeDynamicPlatform` and implement:

- `onStart(reason?)` - Create MatterbridgeEndpoint devices, add clusters, register with `this.registerDevice(device)`
- `onConfigure()` - Configure device after server is online, set persistent attributes
- `onShutdown(reason?)` - Cleanup resources (handlers, intervals, timers)

## MatterbridgeEndpoint

```typescript
const device = new MatterbridgeEndpoint(deviceType, { uniqueId: "unique-id" })
  .createDefaultIdentifyClusterServer()
  .createDefaultBasicInformationClusterServer("Device Name", "serial")
  .addRequiredClusterServers(); // Always call at end
await this.registerDevice(device);
```

## MANDATORY: Test Before Done

Use `timeout` so matterbridge CANNOT keep running past 60s (critical — leaking processes eat CPU forever):

```bash
npm install
npm link matterbridge
npm run build
matterbridge -add .
timeout --signal=SIGINT --kill-after=10s 60s matterbridge -bridge || true
# Extra safety: ensure nothing survives
pkill -9 -f "matterbridge -bridge" 2>/dev/null || true
```

**NEVER** run `matterbridge -bridge &` in the background — always use `timeout` in the foreground so the process is guaranteed to be killed.

**IMPORTANT:** `npm link matterbridge` MUST run before `npm run build` so TypeScript can find matterbridge types.

If `npm run build` shows ANY errors, fix them and rebuild. Not done until:

1. `npm run build` completes with zero errors
2. `matterbridge -bridge` starts without plugin errors
