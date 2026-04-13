# Issue Processing Prompt

This prompt is used when the AI agent receives a new plugin request issue.

---

## Context

You are processing a GitHub issue requesting a new Matterbridge plugin. The issue has been validated and contains all required information.

## Your Task

1. **Parse the Issue** - Extract all relevant information:
   - Device/Service name
   - Device category
   - API documentation links
   - Existing integration links (CRITICAL)
   - Device capabilities
   - Authentication type
   - Connection type
   - Additional context

2. **Fetch and Analyze References** - For each existing integration link:
   - Download and study the source code
   - Understand the API patterns used
   - Note authentication flows
   - Identify device discovery methods
   - Map capabilities to Matter clusters

3. **Feasibility Assessment** - Determine if the plugin is feasible:
   - Are the existing integrations sufficient as references?
   - Is the API well-documented?
   - Can all requested capabilities be mapped to Matter?
   - Are there any blocking issues?

4. **Create the Plugin** - If feasible:
   - Follow the structure in AGENT_SYSTEM_PROMPT.md
   - Adapt code patterns from existing integrations
   - Implement all requested capabilities
   - Write comprehensive documentation

5. **Report Back** - Post updates to the GitHub issue:
   - Initial acknowledgment with feasibility assessment
   - Progress updates during development
   - Final delivery with testing instructions
   - Request for feedback

## Issue Parsing Template

```yaml
device_name: "{extracted device name}"
device_category: "{extracted category}"
api_docs:
  - "{url1}"
  - "{url2}"
existing_integrations:
  home_assistant: "{url or null}"
  node_red: "{url or null}"
  openhab: "{url or null}"
  npm_package: "{url or null}"
  other: []
capabilities:
  - "{capability1}"
  - "{capability2}"
auth_type: "{authentication type}"
connection_type: "{connection type}"
additional_context: "{any extra info}"
```

## Feasibility Criteria

### ✅ PROCEED if:

- At least one existing integration is provided and accessible
- API documentation is available
- Capabilities can be mapped to Matter device types
- Authentication method is implementable

### ⚠️ NEEDS CLARIFICATION if:

- Existing integration links are broken
- Capabilities are unclear
- Authentication details are missing
- API requires special access/approval

### ❌ REJECT if:

- No existing integrations provided
- Device uses proprietary/undocumented protocol
- Requires hardware not accessible via API
- Legal/licensing concerns

## GitHub Comment Templates

### Initial Acknowledgment

```markdown
## 🤖 AI Plugin Factory - Request Received

Thank you for your plugin request! I'm analyzing your submission.

**Device:** {device_name}
**Category:** {device_category}

### Feasibility Check

- [ ] Existing integrations accessible
- [ ] API documentation reviewed
- [ ] Capabilities mapped to Matter
- [ ] Authentication method understood

I'll update this issue with my findings shortly.

---

_This is an automated response from the Matterbridge AI Plugin Factory_
```

### Feasibility Report

```markdown
## 📋 Feasibility Assessment

### Status: {FEASIBLE / NEEDS_CLARIFICATION / NOT_FEASIBLE}

### Analysis

**Existing Integrations Reviewed:**

- Home Assistant: {status}
- Node-RED: {status}
- Other: {status}

**Capability Mapping:**
| Requested | Matter Cluster | Status |
|-----------|---------------|--------|
| {cap1} | {cluster} | ✅/⚠️/❌ |

**Authentication:** {assessment}

**Connection:** {assessment}

### {Next Steps / Questions / Rejection Reason}

{details}

---

_This is an automated response from the Matterbridge AI Plugin Factory_
```

### Development Started

```markdown
## 🔨 Development Started

I'm now creating your Matterbridge plugin based on the analyzed integrations.

**Approach:**
{brief description of implementation approach}

**Estimated completion:** {timeframe}

I'll post the plugin code and testing instructions when ready.

---

_This is an automated response from the Matterbridge AI Plugin Factory_
```

### Plugin Delivered

```markdown
## ✅ Plugin Ready for Testing

Your Matterbridge plugin has been created!

### Plugin Details

- **Name:** matterbridge-{plugin-name}
- **Version:** 1.0.0
- **Matter Device Type:** {device_type}

### Installation

\`\`\`bash

# From the artifacts

npm install ./matterbridge-{plugin-name}-1.0.0.tgz

# Or once published

npm install matterbridge-{plugin-name}
\`\`\`

### Configuration

Add to your Matterbridge config:
\`\`\`json
{example_config}
\`\`\`

### Testing Instructions

1. {step1}
2. {step2}
3. {step3}

### Artifacts

📦 **Download:** [matterbridge-{plugin-name}-1.0.0.tgz]({artifact_url})

### Feedback Requested

Please test the plugin and report back:

- [ ] Plugin installs correctly
- [ ] Device discovery works
- [ ] Basic controls function
- [ ] State updates properly

If you encounter issues, please describe them in detail.

---

_This is an automated response from the Matterbridge AI Plugin Factory_
```

## Working Directory Structure

When creating a plugin, work in:

```
./plugins/
└── issue-{issue_number}/
    └── matterbridge-{plugin-name}/
        ├── src/
        ├── package.json
        ├── tsconfig.json
        └── README.md
```

Artifacts are placed in:

```
./artifacts/
└── issue-{issue_number}/
    ├── matterbridge-{plugin-name}-1.0.0.tgz
    └── build.log
```
