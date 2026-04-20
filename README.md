# 🏭 Matterbridge AI Plugin Factory

An automated system that uses AI (Claude) to generate [Matterbridge](https://github.com/Luligu/matterbridge) plugins from GitHub issue requests.

## 🌟 Overview

This factory automates the creation of Matterbridge plugins that bring Matter compatibility to non-Matter smart home devices. Users submit plugin requests via GitHub Issues, and an AI agent (powered by Claude) analyzes existing integrations and generates working plugins.

### How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  User creates   │────▶│  VPS polls or    │────▶│  Claude Code    │
│  GitHub Issue   │     │  receives        │     │  generates      │
│  with template  │     │  webhook         │     │  plugin code    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  User tests &   │◀────│  Artifact ready  │◀────│  Build & pack   │
│  provides       │     │  comment posted  │     │  plugin         │
│  feedback       │     └──────────────────┘     └─────────────────┘
└─────────────────┘
         │
         ▼
┌─────────────────┐
│  AI revises if  │
│  needed         │
└─────────────────┘
```

## 🚀 Quick Start

### For Users (Requesting a Plugin)

1. **Go to Issues** → **New Issue** → **🔌 Plugin Request**
2. Fill out the template with:
   - Device/service name
   - **Links to existing integrations** (Home Assistant, Node-RED, etc.) - **REQUIRED**
   - Device capabilities you want
   - API documentation links
3. Submit and wait for the AI to process your request
4. Download the generated plugin artifact and test it
5. Provide feedback in the issue

### For Repository Owners (Setup)

1. Clone to your Ubuntu VPS
2. Run the setup script:
   ```bash
   ./scripts/setup-vps.sh
   ```
3. Configure `.env` with your GitHub token
4. Authenticate Claude Code CLI with your Pro plan:
   ```bash
   claude login
   ```
5. Start the service (webhook) or enable cron (polling)

## 📋 Requirements for Plugin Requests

### ✅ What Makes a Good Request

- **Existing integrations provided** - Links to Home Assistant, Node-RED, OpenHAB, or npm packages
- **Clear API documentation** - Official docs or well-documented community resources
- **Specific capabilities** - List exactly what features you need
- **Standard protocols** - HTTP/REST, WebSocket, MQTT, etc.

### ❌ What Won't Work

- Proprietary/undocumented protocols
- Devices requiring physical hardware modifications
- Services without existing open-source integrations
- Requests without reference implementations

## 🏷️ Label System

| Label               | Description                  |
| ------------------- | ---------------------------- |
| `plugin-request`    | Initial request tag          |
| `pending-review`    | Waiting for AI processing    |
| `in-progress`       | AI is generating the plugin  |
| `ready-for-testing` | Plugin artifact available    |
| `needs-revision`    | User reported issues         |
| `needs-info`        | Missing required information |
| `completed`         | Successfully tested          |
| `error`             | Processing failed            |

## 📁 Repository Structure

```
matterbridge-ai-plugin-factory/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── plugin-request.yml    # Issue template
│   │   └── config.yml            # Template config
│   └── labels.yml                # Label definitions
├── prompts/
│   ├── AGENT_SYSTEM_PROMPT.md    # AI system instructions
│   └── ISSUE_PROCESSING_PROMPT.md # Issue parsing prompt
├── scripts/
│   ├── setup-labels.sh           # Label setup script
│   └── setup-vps.sh              # VPS setup script
├── src/
│   ├── index.js                  # Main entry point
│   ├── process-issue.js          # Issue processing
│   └── webhook-server.js         # Webhook handler
├── plugins/                      # Generated plugins (gitignored)
├── package.json
├── .env.example
└── README.md
```

## ⚙️ Configuration

### Environment Variables

| Variable             | Description                                  | Required         |
| -------------------- | -------------------------------------------- | ---------------- |
| `GITHUB_TOKEN`       | GitHub PAT with repo access                  | Yes              |
| `GITHUB_REPO_OWNER`  | Repository owner                             | Yes              |
| `GITHUB_REPO_NAME`   | Repository name                              | Yes              |
| `PLUGINS_OUTPUT_DIR` | Directory for generated plugins              | No               |
| `ARTIFACTS_DIR`      | Directory for build artifacts                | No               |
| `CLAUDE_MODEL`       | Claude model to use (e.g. `claude-opus-4-7`) | No               |
| `WEBHOOK_SECRET`     | GitHub webhook secret                        | For webhook mode |
| `WEBHOOK_PORT`       | Webhook server port                          | For webhook mode |

### Claude Code CLI Authentication

Authenticate with your Claude Pro plan:

```bash
claude login
```

## 🔄 Workflow Details

### 1. Plugin Request Processing

When an issue with `plugin-request` + `pending-review` labels is created:

1. Validates required fields (existing integrations, capabilities)
2. Posts acknowledgment comment
3. Runs Claude Code CLI with system prompt
4. Builds and packages the plugin
5. Uploads artifact and posts download link

### 2. Feedback Handling

When users comment on `ready-for-testing` issues:

- **Positive feedback** → Labels as `completed`
- **Negative feedback** → Labels as `needs-revision`, triggers revision workflow

### 3. Publishing

Maintainers can comment `/publish` on `completed` issues to:

- Create a PR with the plugin code
- Add to the plugins collection

## 🛠️ Development

### Local Testing

```bash
# Install dependencies
npm install

# Run webhook server
FACTORY_MODE=webhook node src/index.js
```

### CLI Reference

The main entry point for manual operations is `src/process-issue.js`:

```bash
node src/process-issue.js [issue-number] [flags]
```

#### Commands / Flags

| Flag             | Description                                                                       |
| ---------------- | --------------------------------------------------------------------------------- |
| _(none)_         | Process all pending issues (no issue number) or fully generate the given issue    |
| `--fix`          | Read latest feedback comment on the issue, regenerate fix, rebuild and re-publish |
| `--resume`       | Resume an interrupted Claude Code session for the issue (continue where left off) |
| `--publish-only` | Skip AI generation; rebuild & publish the existing local plugin for the issue     |
| `--model <name>` | Override the Claude model (also supports `--model=<name>` and `CLAUDE_MODEL` env) |

#### Examples

```bash
# Process all new issues
node src/process-issue.js

# Fully generate plugin for issue #5
node src/process-issue.js 5

# Fix plugin for issue #5 based on latest feedback comment
node src/process-issue.js 5 --fix

# Resume interrupted Claude Code session for issue #5
node src/process-issue.js 5 --resume

# Rebuild & re-publish existing plugin for issue #5 (no AI)
node src/process-issue.js 5 --publish-only

# Use a specific Claude model
node src/process-issue.js 5 --model claude-opus-4-7
node src/process-issue.js 5 --fix --model=claude-opus-4-7
CLAUDE_MODEL=claude-opus-4-7 node src/process-issue.js 5
```

### Daily CRON (Process One Issue Per Day)

`src/process-next-issue.js` fetches the **oldest** open issue with labels `plugin-request` + `pending-review` and generates a single plugin, then exits. Perfect for a daily cron:

```bash
node src/process-next-issue.js
node src/process-next-issue.js --model claude-opus-4-7
```

Example crontab (runs every day at 6:00 AM):

```
0 6 * * * cd /opt/matterbridge-factory && /usr/bin/node src/process-next-issue.js >> /var/log/matterbridge-factory.log 2>&1
```

### Publishing Model

- **Source code** (`plugins/issue-N/<plugin-name>/` without `dist/`, `node_modules/`, `*.tgz`) is committed to a branch `plugin/issue-N-<plugin-name>`, making it reviewable and mergeable.
- **Build artifact** (`.tgz`) is uploaded to a **GitHub Release** tagged `plugin-issue-N`. Re-running `--fix` or `--publish-only` replaces the existing asset.

### Adding New Device Types

Update `prompts/AGENT_SYSTEM_PROMPT.md` with:

- New Matter device type mappings
- Cluster configurations
- Example implementations

## 📚 Resources

- [Matterbridge Documentation](https://github.com/Luligu/matterbridge)
- [Matterbridge Plugin Template](https://github.com/Luligu/matterbridge-plugin-template)
- [Matter.js](https://github.com/project-chip/matter.js)
- [Claude Code CLI](https://claude.ai/download)
- [Home Assistant Integrations](https://www.home-assistant.io/integrations/)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

## ⚠️ Disclaimer

This is an experimental AI-powered tool. Generated plugins:

- May require manual adjustments
- Should be thoroughly tested before production use
- Are provided as-is without warranty

The AI adapts existing open-source integrations - always respect original licenses.
