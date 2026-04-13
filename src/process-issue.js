#!/usr/bin/env node

/**
 * Process GitHub issues and trigger AI plugin generation
 */

require("dotenv").config();

const { Octokit } = require("@octokit/rest");
const { spawn, execSync } = require("child_process");
const fs = require("fs").promises;
const path = require("path");

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_REPO_NAME;
const PLUGINS_DIR = process.env.PLUGINS_OUTPUT_DIR || "./plugins";
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || "./artifacts";

/**
 * Parse issue body to extract structured data
 */
function parseIssueBody(body) {
  const data = {
    deviceName: "",
    deviceCategory: "",
    apiDocumentation: [],
    existingIntegrations: [],
    deviceCapabilities: [],
    authenticationType: "",
    connectionType: "",
    additionalContext: "",
  };

  // Parse sections from the issue body
  const sections = body.split(/###\s+/);

  for (const section of sections) {
    const lines = section.trim().split("\n");
    const header = lines[0]?.toLowerCase() || "";
    const content = lines.slice(1).join("\n").trim();

    if (
      header.includes("device/service name") ||
      header.includes("device name")
    ) {
      data.deviceName = content.replace(/^[-*]\s*/, "").trim();
    } else if (header.includes("device category")) {
      data.deviceCategory = content.replace(/^[-*]\s*/, "").trim();
    } else if (header.includes("api documentation")) {
      data.apiDocumentation = extractUrls(content);
    } else if (header.includes("existing integrations")) {
      data.existingIntegrations = extractUrls(content);
    } else if (
      header.includes("device capabilities") ||
      header.includes("capabilities")
    ) {
      data.deviceCapabilities = content
        .split("\n")
        .map((line) => line.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean);
    } else if (header.includes("authentication")) {
      data.authenticationType = content.replace(/^[-*]\s*/, "").trim();
    } else if (header.includes("connection")) {
      data.connectionType = content.replace(/^[-*]\s*/, "").trim();
    } else if (header.includes("additional context")) {
      data.additionalContext = content;
    }
  }

  return data;
}

/**
 * Extract URLs from text
 */
function extractUrls(text) {
  const urlRegex = /https?:\/\/[^\s\)]+/g;
  return text.match(urlRegex) || [];
}

/**
 * Post a comment to the GitHub issue
 */
async function postComment(issueNumber, body) {
  await octokit.issues.createComment({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
    body,
  });
}

/**
 * Update issue labels
 */
async function updateLabels(issueNumber, labelsToAdd, labelsToRemove = []) {
  const { data: issue } = await octokit.issues.get({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
  });

  const currentLabels = issue.labels.map((l) => l.name);
  const newLabels = currentLabels
    .filter((l) => !labelsToRemove.includes(l))
    .concat(labelsToAdd.filter((l) => !currentLabels.includes(l)));

  await octokit.issues.update({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
    labels: newLabels,
  });
}

/**
 * Validate the plugin request
 */
function validateRequest(parsedData) {
  const issues = [];

  if (!parsedData.deviceName) {
    issues.push("Device/Service name is missing");
  }

  if (
    !parsedData.existingIntegrations ||
    parsedData.existingIntegrations.length === 0
  ) {
    issues.push("No existing integrations provided - this is REQUIRED");
  }

  if (
    !parsedData.deviceCapabilities ||
    parsedData.deviceCapabilities.length === 0
  ) {
    issues.push("No device capabilities specified");
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Generate the plugin name from device name
 */
function generatePluginName(deviceName) {
  return deviceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Create the AI prompt for Claude Code CLI
 */
function createAIPrompt(issueNumber, parsedData) {
  return `
# Plugin Request #${issueNumber}

## Device Information
- **Name:** ${parsedData.deviceName}
- **Category:** ${parsedData.deviceCategory}
- **Authentication:** ${parsedData.authenticationType}
- **Connection:** ${parsedData.connectionType}

## API Documentation
${parsedData.apiDocumentation.map((url) => `- ${url}`).join("\n")}

## Existing Integrations to Study
${parsedData.existingIntegrations.map((url) => `- ${url}`).join("\n")}

## Required Capabilities
${parsedData.deviceCapabilities.map((cap) => `- ${cap}`).join("\n")}

## Additional Context
${parsedData.additionalContext || "None provided"}

## Instructions

1. Study the existing integrations listed above
2. Create a complete Matterbridge plugin following the patterns in AGENT_SYSTEM_PROMPT.md
3. The plugin should be named: matterbridge-${generatePluginName(parsedData.deviceName)}
4. Output all files to: ${PLUGINS_DIR}/issue-${issueNumber}/
5. Create a build artifact in: ${ARTIFACTS_DIR}/issue-${issueNumber}/

Focus on adapting the existing integration code patterns to the Matterbridge plugin architecture.
`;
}

/**
 * Run Claude Code CLI to generate the plugin
 */
async function runClaudeCodeCLI(issueNumber, prompt, workDir) {
  return new Promise((resolve, reject) => {
    const promptFile = path.join(workDir, "prompt.md");

    // Write prompt to file
    fs.writeFile(promptFile, prompt)
      .then(() => {
        const systemPromptPath = path.join(
          __dirname,
          "..",
          "prompts",
          "AGENT_SYSTEM_PROMPT.md",
        );

        console.log("🤖 Starting Claude Code CLI...");
        console.log(`   Working directory: ${workDir}`);
        console.log(`   System prompt: ${systemPromptPath}`);

        // Run Claude Code CLI
        const claude = spawn(
          "claude",
          [
            "--print", // Print output
            "--dangerously-skip-permissions", // Allow file operations
            "--system-prompt",
            systemPromptPath,
            prompt,
          ],
          {
            cwd: workDir,
            stdio: ["ignore", "pipe", "pipe"], // ignore stdin, pipe stdout/stderr
            env: {
              ...process.env,
            },
          },
        );

        console.log(`🤖 Claude process started (PID: ${claude.pid})`);

        let output = "";
        let errorOutput = "";

        claude.stdout.on("data", (data) => {
          const text = data.toString();
          output += text;
          process.stdout.write(text); // Use write for immediate output
        });

        claude.stderr.on("data", (data) => {
          const text = data.toString();
          errorOutput += text;
          process.stderr.write(text); // Use write for immediate output
        });

        claude.on("close", (code) => {
          if (code === 0) {
            resolve({ success: true, output });
          } else {
            reject(
              new Error(`Claude CLI exited with code ${code}: ${errorOutput}`),
            );
          }
        });

        claude.on("error", (err) => {
          reject(err);
        });
      })
      .catch(reject);
  });
}

/**
 * Push plugin to a branch and return the download URL
 */
async function publishPluginToBranch(issueNumber, pluginName, artifactPath) {
  const branchName = `plugin/issue-${issueNumber}-${pluginName.replace("matterbridge-", "")}`;
  const pluginDir = path.join(PLUGINS_DIR, `issue-${issueNumber}`, pluginName);

  console.log(`📤 Publishing plugin to branch: ${branchName}`);

  try {
    // Get the repo root directory
    const repoRoot = path.resolve(__dirname, "..");

    // Configure git user if not set
    try {
      execSync("git config user.email", { cwd: repoRoot, stdio: "pipe" });
    } catch {
      execSync('git config user.email "ai-factory@matterbridge.local"', {
        cwd: repoRoot,
      });
      execSync('git config user.name "Matterbridge AI Factory"', {
        cwd: repoRoot,
      });
    }

    // Fetch latest and create branch from main
    execSync("git fetch origin main", { cwd: repoRoot, stdio: "inherit" });

    // Resolve absolute paths and save copies to temp location
    const absPluginDir = path.resolve(pluginDir);
    const absArtifactPath = path.resolve(artifactPath);
    const artifactName = path.basename(artifactPath);

    // Copy to temp location before switching branches
    const tempDir = path.join(repoRoot, ".tmp-publish");
    const tempPluginDir = path.join(tempDir, pluginName);
    const tempArtifactPath = path.join(tempDir, artifactName);

    await fs.mkdir(tempDir, { recursive: true });
    execSync(`cp -r "${absPluginDir}" "${tempDir}/"`, { stdio: "inherit" });
    execSync(`cp "${absArtifactPath}" "${tempDir}/"`, { stdio: "inherit" });
    console.log("   Copied files to temp location");

    // Make sure we're on main first
    execSync("git checkout main", { cwd: repoRoot, stdio: "pipe" });

    // Delete local branch if exists
    try {
      execSync(`git branch -D ${branchName}`, { cwd: repoRoot, stdio: "pipe" });
    } catch {
      // Branch doesn't exist, that's fine
    }

    // Create new branch from main
    execSync(`git checkout -b ${branchName} origin/main`, {
      cwd: repoRoot,
      stdio: "inherit",
    });

    // Target directories in repo
    const repoPluginDir = path.join(
      repoRoot,
      "plugins",
      `issue-${issueNumber}`,
    );
    const repoArtifactDir = path.join(
      repoRoot,
      "artifacts",
      `issue-${issueNumber}`,
    );

    // Create directories and copy from temp
    await fs.mkdir(repoPluginDir, { recursive: true });
    await fs.mkdir(repoArtifactDir, { recursive: true });

    execSync(`cp -r "${tempPluginDir}" "${repoPluginDir}/"`, {
      stdio: "inherit",
    });
    execSync(`cp "${tempArtifactPath}" "${repoArtifactDir}/"`, {
      stdio: "inherit",
    });
    console.log("   Copied files to branch");

    // Clean up temp
    execSync(`rm -rf "${tempDir}"`, { stdio: "inherit" });

    // Add plugin and artifact files (force to override .gitignore)
    execSync(
      `git add -f plugins/issue-${issueNumber} artifacts/issue-${issueNumber}`,
      {
        cwd: repoRoot,
        stdio: "inherit",
      },
    );

    execSync(
      `git commit -m "feat: Add ${pluginName} for issue #${issueNumber}"`,
      { cwd: repoRoot, stdio: "inherit" },
    );

    // Push branch
    execSync(`git push -f origin ${branchName}`, {
      cwd: repoRoot,
      stdio: "inherit",
    });

    // Switch back to main
    execSync("git checkout main", { cwd: repoRoot, stdio: "inherit" });

    // Return the raw download URL for the artifact
    const artifactUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/raw/${branchName}/artifacts/issue-${issueNumber}/${artifactName}`;
    const branchUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/tree/${branchName}`;

    console.log(`✅ Plugin published to: ${branchUrl}`);

    return { artifactUrl, branchUrl, branchName };
  } catch (error) {
    console.error("Failed to publish plugin to branch:", error.message);
    throw error;
  }
}

/**
 * Build the plugin and create artifacts
 */
async function buildPlugin(issueNumber, pluginName) {
  const pluginDir = path.join(PLUGINS_DIR, `issue-${issueNumber}`, pluginName);
  const artifactDir = path.join(ARTIFACTS_DIR, `issue-${issueNumber}`);

  await fs.mkdir(artifactDir, { recursive: true });

  return new Promise((resolve, reject) => {
    // Install dependencies and build
    const npm = spawn("npm", ["install"], { cwd: pluginDir });

    npm.on("close", (installCode) => {
      if (installCode !== 0) {
        reject(new Error("npm install failed"));
        return;
      }

      // Run TypeScript build
      const build = spawn("npm", ["run", "build"], { cwd: pluginDir });

      build.on("close", (buildCode) => {
        if (buildCode !== 0) {
          reject(new Error("npm build failed"));
          return;
        }

        // Create tarball
        const pack = spawn("npm", ["pack"], { cwd: pluginDir });

        pack.on("close", (packCode) => {
          if (packCode !== 0) {
            reject(new Error("npm pack failed"));
            return;
          }

          // Move tarball to artifacts
          const tarball = `${pluginName}-1.0.0.tgz`;
          fs.rename(
            path.join(pluginDir, tarball),
            path.join(artifactDir, tarball),
          )
            .then(() => resolve(path.join(artifactDir, tarball)))
            .catch(reject);
        });
      });
    });
  });
}

/**
 * Process a single issue
 */
async function processIssue(issue) {
  const issueNumber = issue.number;
  console.log(`\n📋 Processing issue #${issueNumber}: ${issue.title}`);

  try {
    // Parse the issue body
    const parsedData = parseIssueBody(issue.body || "");
    console.log("Parsed data:", JSON.stringify(parsedData, null, 2));

    // Validate the request
    const validation = validateRequest(parsedData);

    if (!validation.valid) {
      // Post validation failure comment
      await postComment(
        issueNumber,
        `## ⚠️ Validation Failed

Your plugin request is missing required information:

${validation.issues.map((i) => `- ❌ ${i}`).join("\n")}

Please update your issue with the missing information.

---
*This is an automated response from the Matterbridge AI Plugin Factory*`,
      );

      await updateLabels(issueNumber, ["needs-info"], ["pending-review"]);
      return;
    }

    // Post acknowledgment
    await postComment(
      issueNumber,
      `## 🤖 AI Plugin Factory - Request Received

Thank you for your plugin request! I'm analyzing your submission.

**Device:** ${parsedData.deviceName}
**Category:** ${parsedData.deviceCategory}

### Analyzing
- Existing integrations: ${parsedData.existingIntegrations.length} provided
- Capabilities requested: ${parsedData.deviceCapabilities.length}

I'll begin development shortly.

---
*This is an automated response from the Matterbridge AI Plugin Factory*`,
    );

    await updateLabels(issueNumber, ["in-progress"], ["pending-review"]);

    // Create working directory
    const pluginName = `matterbridge-${generatePluginName(parsedData.deviceName)}`;
    const workDir = path.join(PLUGINS_DIR, `issue-${issueNumber}`);
    await fs.mkdir(workDir, { recursive: true });

    // Create AI prompt and run Claude
    const prompt = createAIPrompt(issueNumber, parsedData);

    await postComment(
      issueNumber,
      `## 🔨 Development Started

I'm now creating your Matterbridge plugin based on the analyzed integrations.

**Plugin name:** \`${pluginName}\`

I'll post the plugin code and testing instructions when ready.

---
*This is an automated response from the Matterbridge AI Plugin Factory*`,
    );

    // Run Claude Code CLI
    await runClaudeCodeCLI(issueNumber, prompt, workDir);

    // Build the plugin
    console.log("📦 Building plugin...");
    const artifactPath = await buildPlugin(issueNumber, pluginName);
    console.log(`✅ Plugin built: ${artifactPath}`);

    // Publish to branch
    console.log("📤 Publishing plugin to GitHub...");
    const { artifactUrl, branchUrl, branchName } = await publishPluginToBranch(
      issueNumber,
      pluginName,
      artifactPath,
    );

    // Post success comment with download link
    await postComment(
      issueNumber,
      `## ✅ Plugin Ready for Testing

Your Matterbridge plugin has been created!

### Plugin Details
- **Name:** \`${pluginName}\`
- **Version:** 1.0.0
- **Branch:** [\`${branchName}\`](${branchUrl})

### Installation

**Option 1: Direct download**
\`\`\`bash
curl -L -o ${pluginName}-1.0.0.tgz "${artifactUrl}"
npm install ./${pluginName}-1.0.0.tgz
\`\`\`

**Option 2: Install from GitHub**
\`\`\`bash
npm install ${artifactUrl}
\`\`\`

### 📦 [Download Plugin Artifact](${artifactUrl})

### Source Code

Browse the plugin source code: [${branchName}](${branchUrl}/plugins/issue-${issueNumber}/${pluginName})

### Feedback Requested

Please test the plugin and report back:
- [ ] Plugin installs correctly
- [ ] Device discovery works
- [ ] Basic controls function
- [ ] State updates properly

If you encounter issues, please describe them in detail.

---
*This is an automated response from the Matterbridge AI Plugin Factory*`,
    );

    await updateLabels(issueNumber, ["ready-for-testing"], ["in-progress"]);
  } catch (error) {
    console.error(`Error processing issue #${issueNumber}:`, error);

    await postComment(
      issueNumber,
      `## ❌ Error During Processing

An error occurred while processing your plugin request:

\`\`\`
${error.message}
\`\`\`

The team has been notified and will investigate.

---
*This is an automated response from the Matterbridge AI Plugin Factory*`,
    );

    await updateLabels(
      issueNumber,
      ["error"],
      ["in-progress", "pending-review"],
    );
  }
}

/**
 * Process all new issues with the plugin-request label
 */
async function processNewIssues() {
  console.log("🔍 Checking for new plugin requests...");

  try {
    const { data: issues } = await octokit.issues.listForRepo({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      labels: "plugin-request,pending-review",
      state: "open",
      sort: "created",
      direction: "asc",
    });

    console.log(`Found ${issues.length} pending plugin requests`);

    for (const issue of issues) {
      await processIssue(issue);
    }
  } catch (error) {
    console.error("Error fetching issues:", error);
    throw error;
  }
}

/**
 * Publish an existing plugin without regenerating
 */
async function publishOnly(issueNumber) {
  console.log(`📤 Publishing existing plugin for issue #${issueNumber}...`);

  try {
    // Get issue data for plugin name
    const { data: issue } = await octokit.issues.get({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      issue_number: issueNumber,
    });

    const parsedData = parseIssueBody(issue.body || "");
    const pluginName = `matterbridge-${generatePluginName(parsedData.deviceName)}`;
    const pluginDir = path.join(
      PLUGINS_DIR,
      `issue-${issueNumber}`,
      pluginName,
    );
    const artifactDir = path.join(ARTIFACTS_DIR, `issue-${issueNumber}`);

    // Check if plugin exists
    try {
      await fs.access(pluginDir);
    } catch {
      console.error(`❌ Plugin directory not found: ${pluginDir}`);
      console.log("Run without --publish-only to generate the plugin first.");
      process.exit(1);
    }

    // Find artifact
    const files = await fs.readdir(artifactDir);
    const tgzFile = files.find((f) => f.endsWith(".tgz"));
    if (!tgzFile) {
      console.error(`❌ No .tgz artifact found in: ${artifactDir}`);
      process.exit(1);
    }

    const artifactPath = path.join(artifactDir, tgzFile);
    console.log(`Found artifact: ${artifactPath}`);

    // Publish to branch
    const { artifactUrl, branchUrl, branchName } = await publishPluginToBranch(
      issueNumber,
      pluginName,
      artifactPath,
    );

    // Post comment with download link
    await postComment(
      issueNumber,
      `## ✅ Plugin Ready for Testing

Your Matterbridge plugin has been created!

### Plugin Details
- **Name:** \`${pluginName}\`
- **Version:** 1.0.0
- **Branch:** [\`${branchName}\`](${branchUrl})

### Installation

**Option 1: Direct download**
\`\`\`bash
curl -L -o ${pluginName}-1.0.0.tgz "${artifactUrl}"
npm install ./${pluginName}-1.0.0.tgz
\`\`\`

**Option 2: Install from GitHub**
\`\`\`bash
npm install ${artifactUrl}
\`\`\`

### 📦 [Download Plugin Artifact](${artifactUrl})

### Source Code

Browse the plugin source code: [${branchName}](${branchUrl}/plugins/issue-${issueNumber}/${pluginName})

### Feedback Requested

Please test the plugin and report back:
- [ ] Plugin installs correctly
- [ ] Device discovery works
- [ ] Basic controls function
- [ ] State updates properly

If you encounter issues, please describe them in detail.

---
*This is an automated response from the Matterbridge AI Plugin Factory*`,
    );

    await updateLabels(issueNumber, ["ready-for-testing"], ["in-progress"]);
    console.log("✅ Plugin published successfully!");
  } catch (error) {
    console.error("Error publishing plugin:", error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const publishOnlyFlag = args.includes("--publish-only");
  const issueNumber = args.find((a) => !a.startsWith("--"));

  if (publishOnlyFlag && issueNumber) {
    // Publish existing plugin only
    publishOnly(parseInt(issueNumber));
  } else if (issueNumber) {
    // Process specific issue (full generation)
    octokit.issues
      .get({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        issue_number: parseInt(issueNumber),
      })
      .then(({ data }) => processIssue(data))
      .catch(console.error);
  } else {
    // Process all pending issues
    processNewIssues().catch(console.error);
  }
}

module.exports = {
  processNewIssues,
  processIssue,
  parseIssueBody,
  validateRequest,
};
