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

// Claude model can be overridden via --model CLI flag or CLAUDE_MODEL env var
let CLAUDE_MODEL = process.env.CLAUDE_MODEL || null;

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
 * Get comments from an issue
 */
async function getIssueComments(issueNumber) {
  const { data: comments } = await octokit.issues.listComments({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
  });
  return comments;
}

/**
 * Get the latest bug report/feedback from comments
 */
function extractLatestFeedback(comments) {
  // Filter out bot comments and find the latest user feedback
  const userComments = comments.filter(
    (c) =>
      !c.body.includes(
        "*This is an automated response from the Matterbridge AI Plugin Factory*",
      ),
  );

  if (userComments.length === 0) return null;

  // Get the most recent user comment
  const latestComment = userComments[userComments.length - 1];
  return {
    author: latestComment.user.login,
    body: latestComment.body,
    createdAt: latestComment.created_at,
  };
}

/**
 * Extract image URLs from a GitHub comment body (markdown + HTML).
 * Returns a list of absolute image URLs.
 */
function extractImageUrls(body) {
  const urls = new Set();
  // Markdown: ![alt](url)
  const mdRe = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = mdRe.exec(body)) !== null) urls.add(m[1].trim());
  // HTML: <img src="..." />
  const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
  while ((m = imgRe.exec(body)) !== null) urls.add(m[1].trim());
  // Plain user-attachments links (GitHub auto-converts drag-dropped files)
  const plainRe =
    /https:\/\/github\.com\/user-attachments\/assets\/[a-z0-9-]+/gi;
  while ((m = plainRe.exec(body)) !== null) urls.add(m[0]);
  return Array.from(urls);
}

/**
 * Download an image URL to the given directory. Returns the absolute local path
 * or null on failure. Never throws.
 */
async function downloadImage(url, destDir, index) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      console.warn(`   ⚠️  Failed to download ${url}: HTTP ${res.status}`);
      return null;
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      console.warn(`   ⚠️  Skipping non-image URL ${url} (${contentType})`);
      return null;
    }
    const ext = contentType.split("/")[1].split(";")[0].split("+")[0] || "bin";
    const buf = Buffer.from(await res.arrayBuffer());
    const filename = `feedback-image-${index}.${ext}`;
    const destPath = path.join(destDir, filename);
    await fs.writeFile(destPath, buf);
    console.log(`   📥 Downloaded ${url} → ${destPath}`);
    return destPath;
  } catch (err) {
    console.warn(`   ⚠️  Download error for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Create a feedback/fix prompt for Claude.
 * `localImagePaths` is an array of absolute local file paths for images
 * that were attached to the GitHub comment.
 */
function createFeedbackPrompt(
  issueNumber,
  parsedData,
  feedback,
  pluginName,
  localImagePaths = [],
) {
  const imagesSection =
    localImagePaths.length > 0
      ? `\nThe user attached ${localImagePaths.length} image(s). Read them BEFORE fixing (use the Read tool; Claude Code supports image files):
${localImagePaths.map((p, i) => `${i + 1}. ${p}`).join("\n")}
`
      : "";

  return `Fix bug in ${pluginName}. Be concise, write code not explanations.

Bug report:
${feedback.body}
${imagesSection}
Fix the code, then test:
\`\`\`bash
npm run build && npm install -g . && timeout 30 matterbridge -add ${pluginName} 2>&1 || true && timeout 30 matterbridge -bridge 2>&1 || true
\`\`\`

Not done until matterbridge starts without errors.`;
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
  const pluginName = `matterbridge-ai-factory-${generatePluginName(parsedData.deviceName)}`;
  const integrations = [
    ...parsedData.existingIntegrations,
    ...parsedData.apiDocumentation,
  ].filter(Boolean);

  return `Create ${pluginName} for ${parsedData.deviceName}. Be concise, write code not explanations.

Study these integrations:
${integrations.map((url) => url).join("\n")}

Capabilities needed: ${parsedData.deviceCapabilities.join(", ")}
${parsedData.additionalContext ? `Context: ${parsedData.additionalContext}` : ""}

Create the plugin in the CURRENT working directory. The plugin folder name MUST be exactly "${pluginName}" (no nesting, no subdirectories). After cloning the template, you must end up with ./${pluginName}/package.json relative to CWD.`;
}

/**
 * Ensure the repo working tree is in a clean state before starting work.
 * - Resets any tracked-file changes
 * - Removes untracked files (including gitignored leftovers like plugins/issue-*)
 * - Switches to main and pulls latest
 * - Kills any stray matterbridge processes
 *
 * Files preserved regardless: `.env`, `node_modules/` (factory deps),
 * `/home/matterbridge/logs/` (outside the repo).
 *
 * Throws on any unrecoverable git error.
 */
async function ensureCleanWorkspace() {
  const repoRoot = path.resolve(__dirname, "..");
  console.log("🧼 Ensuring clean workspace...");

  killStrayMatterbridge();

  // Preserve .env by staging it out (it's gitignored so clean -fdx would nuke it)
  const envPath = path.join(repoRoot, ".env");
  const envBackup = `/tmp/.env.factory-backup-${Date.now()}`;
  let envSaved = false;
  try {
    await fs.access(envPath);
    execSync(`cp "${envPath}" "${envBackup}"`, { stdio: "pipe" });
    envSaved = true;
  } catch {
    // .env doesn't exist — nothing to preserve
  }

  try {
    // Discard tracked changes
    execSync("git reset --hard HEAD", { cwd: repoRoot, stdio: "pipe" });

    // Remove all untracked files INCLUDING gitignored ones
    // (this wipes plugins/issue-*, artifacts/issue-*, *.tgz, etc.)
    // We exclude node_modules so we don't have to reinstall factory deps every run.
    execSync("git clean -fdx -e node_modules", {
      cwd: repoRoot,
      stdio: "pipe",
    });

    // Make sure we're on main and up-to-date
    execSync("git fetch origin main", { cwd: repoRoot, stdio: "pipe" });
    execSync("git checkout main", { cwd: repoRoot, stdio: "pipe" });
    execSync("git reset --hard origin/main", { cwd: repoRoot, stdio: "pipe" });

    console.log("✅ Workspace is clean and on main @ origin/main");
  } finally {
    // Restore .env
    if (envSaved) {
      execSync(`cp "${envBackup}" "${envPath}"`, { stdio: "pipe" });
      execSync(`rm -f "${envBackup}"`, { stdio: "pipe" });
    }
  }
}

/**
 * Checkout an existing plugin branch so its files are available in the working tree.
 * Used by --fix flows to make sure the plugin source is present before running Claude.
 */
async function checkoutPluginBranch(branchName) {
  const repoRoot = path.resolve(__dirname, "..");
  console.log(`🔀 Checking out plugin branch: ${branchName}`);
  execSync(`git fetch origin ${branchName}`, { cwd: repoRoot, stdio: "pipe" });
  execSync(`git checkout ${branchName}`, { cwd: repoRoot, stdio: "pipe" });
  execSync(`git reset --hard origin/${branchName}`, {
    cwd: repoRoot,
    stdio: "pipe",
  });
}

/**
 * Kill any stray matterbridge processes left over from previous runs.
 * Safe to call at any time — never throws.
 */
function killStrayMatterbridge() {
  try {
    execSync('pkill -9 -f "matterbridge -bridge"', { stdio: "pipe" });
    console.log("🧹 Killed stray matterbridge processes");
  } catch {
    // pkill exits 1 when no process matched — that's fine
  }
}

/**
 * Run Claude Code CLI to generate the plugin
 */
async function runClaudeCodeCLI(issueNumber, prompt, workDir) {
  // Clean up before and after to prevent stuck processes eating CPU
  killStrayMatterbridge();

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
        if (CLAUDE_MODEL) {
          console.log(`   Model: ${CLAUDE_MODEL}`);
        }

        // Run Claude Code CLI in print mode (non-interactive) with streaming JSON
        const claudeArgs = [
          "-p", // Print mode (non-interactive)
          "--verbose", // Show detailed progress
          "--dangerously-skip-permissions", // Allow file operations
          "--output-format",
          "stream-json", // Stream output for real-time logs
          "--system-prompt-file",
          systemPromptPath,
        ];
        if (CLAUDE_MODEL) {
          claudeArgs.push("--model", CLAUDE_MODEL);
        }
        claudeArgs.push(prompt);

        const claude = spawn("claude", claudeArgs, {
          cwd: workDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
          },
        });

        console.log(`🤖 Claude process started (PID: ${claude.pid})`);

        claude.stdout.on("data", (data) => {
          const lines = data.toString().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const event = JSON.parse(line);
              // Log different event types
              if (event.type === "assistant" && event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === "text") {
                    console.log(`💬 ${block.text.substring(0, 200)}...`);
                  } else if (block.type === "tool_use") {
                    console.log(`🔧 Tool: ${block.name}`);
                  }
                }
              } else if (event.type === "result") {
                console.log(
                  `✅ Result: ${event.result?.substring(0, 100) || "done"}`,
                );
              }
            } catch {
              // Not JSON, print raw
              console.log(data.toString());
            }
          }
        });

        claude.stderr.on("data", (data) => {
          console.error(data.toString());
        });

        claude.on("close", (code, signal) => {
          killStrayMatterbridge();
          if (code === 0) {
            resolve({ success: true });
          } else if (code === null) {
            reject(
              new Error(
                `Claude CLI was killed by signal ${signal || "unknown"} ` +
                  `(likely OOM — check "dmesg | grep -i killed" and consider adding swap)`,
              ),
            );
          } else {
            reject(new Error(`Claude CLI exited with code ${code}`));
          }
        });

        claude.on("error", (err) => {
          killStrayMatterbridge();
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

    // Resolve absolute paths and save copy of source to temp location
    const absPluginDir = path.resolve(pluginDir);

    // Copy source to temp location OUTSIDE repo before switching branches
    const tempDir = path.join(
      "/tmp",
      `matterbridge-publish-${issueNumber}-${Date.now()}`,
    );
    const tempPluginDir = path.join(tempDir, pluginName);

    await fs.mkdir(tempDir, { recursive: true });
    execSync(`cp -r "${absPluginDir}" "${tempDir}/"`, { stdio: "inherit" });
    console.log(`   Copied source to temp location: ${tempDir}`);

    // Remove any working-tree changes that would block checkout.
    // The plugin files we care about are already safely copied to tempDir above.
    const issueDir = path.join(repoRoot, "plugins", `issue-${issueNumber}`);
    execSync(`rm -rf "${issueDir}"`, { stdio: "pipe" });
    // Discard any remaining tracked-file changes so `git checkout main` succeeds
    execSync("git checkout -- .", { cwd: repoRoot, stdio: "pipe" });
    // Also remove any other untracked files/dirs left by Claude
    execSync("git clean -fd", { cwd: repoRoot, stdio: "pipe" });

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

    // Target directory in repo
    const repoPluginDir = path.join(
      repoRoot,
      "plugins",
      `issue-${issueNumber}`,
    );

    // Create directory and copy source from temp
    await fs.mkdir(repoPluginDir, { recursive: true });
    execSync(`cp -r "${tempPluginDir}" "${repoPluginDir}/"`, {
      stdio: "inherit",
    });
    console.log("   Copied source files to branch");

    // Remove build artifacts before committing (kept only for local testing)
    const destPluginPath = path.join(repoPluginDir, pluginName);
    for (const d of ["node_modules", "dist"]) {
      execSync(`rm -rf "${path.join(destPluginPath, d)}"`, { stdio: "pipe" });
    }
    execSync(`find "${destPluginPath}" -name "*.tgz" -delete`, {
      stdio: "pipe",
    });
    execSync(`find "${destPluginPath}" -name "*.tsbuildinfo" -delete`, {
      stdio: "pipe",
    });
    console.log("   Cleaned build artifacts");

    // Clean up temp
    execSync(`rm -rf "${tempDir}"`, { stdio: "inherit" });

    // Add only source files (respects .gitignore)
    execSync(`git add plugins/issue-${issueNumber}`, {
      cwd: repoRoot,
      stdio: "inherit",
    });

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

    // Upload .tgz to GitHub release
    const artifactUrl = await uploadToRelease(
      issueNumber,
      pluginName,
      artifactPath,
    );
    const branchUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/tree/${branchName}`;

    console.log(`✅ Plugin published to: ${branchUrl}`);

    return { artifactUrl, branchUrl, branchName };
  } catch (error) {
    console.error("Failed to publish plugin to branch:", error.message);
    throw error;
  }
}

/**
 * Publish a fix to an existing plugin branch (commits directly to the branch)
 */
async function publishFixToBranch(issueNumber, pluginName, artifactPath) {
  const branchName = `plugin/issue-${issueNumber}-${pluginName.replace("matterbridge-", "")}`;
  const repoRoot = path.resolve(__dirname, "..");

  console.log(`📤 Committing fix to branch: ${branchName}`);

  try {
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

    // Save the modified plugin dir to a temp location before switching branches.
    // This is needed because `--fix` may be run from main, where the plugin
    // files are untracked but tracked on the target branch — git checkout
    // would refuse to overwrite them.
    const issueDir = path.join(repoRoot, "plugins", `issue-${issueNumber}`);
    const pluginPath = path.join(issueDir, pluginName);
    const tempDir = path.join(
      "/tmp",
      `matterbridge-fix-${issueNumber}-${Date.now()}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
    const tempPluginPath = path.join(tempDir, pluginName);

    try {
      await fs.access(pluginPath);
      execSync(`cp -r "${pluginPath}" "${tempDir}/"`, { stdio: "inherit" });
      console.log(`   Saved modified plugin to ${tempPluginPath}`);
    } catch {
      throw new Error(
        `Expected modified plugin at ${pluginPath} but it does not exist`,
      );
    }

    // Remove the untracked plugin dir so git checkout can proceed
    execSync(`rm -rf "${issueDir}"`, { stdio: "pipe" });

    // Checkout the existing plugin branch
    execSync(`git fetch origin ${branchName}`, {
      cwd: repoRoot,
      stdio: "inherit",
    });
    execSync(`git checkout ${branchName}`, { cwd: repoRoot, stdio: "inherit" });

    // Pull latest changes
    execSync(`git pull origin ${branchName}`, {
      cwd: repoRoot,
      stdio: "inherit",
    });

    // Replace branch's plugin dir with the modified one from temp
    execSync(`rm -rf "${pluginPath}"`, { stdio: "pipe" });
    await fs.mkdir(issueDir, { recursive: true });
    execSync(`cp -r "${tempPluginPath}" "${issueDir}/"`, { stdio: "inherit" });
    execSync(`rm -rf "${tempDir}"`, { stdio: "pipe" });

    // Remove build artifacts before committing
    for (const d of ["node_modules", "dist"]) {
      execSync(`rm -rf "${path.join(pluginPath, d)}"`, { stdio: "pipe" });
    }
    execSync(`find "${pluginPath}" -name "*.tgz" -delete`, { stdio: "pipe" });
    execSync(`find "${pluginPath}" -name "*.tsbuildinfo" -delete`, {
      stdio: "pipe",
    });

    // Add only source files (respects .gitignore)
    execSync(`git add plugins/issue-${issueNumber}`, {
      cwd: repoRoot,
      stdio: "inherit",
    });

    // Commit only if there are changes
    try {
      execSync(`git commit -m "fix: Update ${pluginName} based on feedback"`, {
        cwd: repoRoot,
        stdio: "inherit",
      });

      // Push to branch
      execSync(`git push origin ${branchName}`, {
        cwd: repoRoot,
        stdio: "inherit",
      });
    } catch {
      console.log(
        "   No source changes to commit (only build artifacts changed)",
      );
    }

    // Switch back to main
    execSync("git checkout main", { cwd: repoRoot, stdio: "inherit" });

    // Upload updated .tgz to GitHub release (replaces existing asset)
    const artifactUrl = await uploadToRelease(
      issueNumber,
      pluginName,
      artifactPath,
    );
    const branchUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/tree/${branchName}`;

    console.log(`✅ Fix published to: ${branchUrl}`);
    return { artifactUrl, branchUrl, branchName };
  } catch (error) {
    console.error("Failed to publish fix:", error.message);
    throw error;
  }
}

/**
 * Create or update a GitHub release for the issue and upload the plugin .tgz
 */
async function uploadToRelease(issueNumber, pluginName, artifactPath) {
  const tag = `plugin-issue-${issueNumber}`;
  const artifactName = path.basename(artifactPath);

  console.log(`📦 Uploading to GitHub release: ${tag}`);

  // Find or create release
  let release;
  try {
    const { data } = await octokit.repos.getReleaseByTag({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      tag,
    });
    release = data;
    console.log(`   Found existing release: ${tag}`);
  } catch (err) {
    if (err.status === 404) {
      const { data } = await octokit.repos.createRelease({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        tag_name: tag,
        name: `Plugin for issue #${issueNumber}: ${pluginName}`,
        body: `Automated build of \`${pluginName}\` for issue #${issueNumber}.\n\nDownload the \`.tgz\` below and install via Matterbridge UI.`,
        draft: false,
        prerelease: false,
      });
      release = data;
      console.log(`   Created release: ${tag}`);
    } else {
      throw err;
    }
  }

  // Delete existing asset with same name (to replace)
  const existingAsset = release.assets.find((a) => a.name === artifactName);
  if (existingAsset) {
    console.log(`   Deleting existing asset: ${artifactName}`);
    await octokit.repos.deleteReleaseAsset({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      asset_id: existingAsset.id,
    });
  }

  // Upload new asset
  const fileData = await fs.readFile(artifactPath);
  const { data: asset } = await octokit.repos.uploadReleaseAsset({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    release_id: release.id,
    name: artifactName,
    data: fileData,
    headers: {
      "content-type": "application/gzip",
      "content-length": fileData.length,
    },
  });

  console.log(`✅ Uploaded asset: ${asset.browser_download_url}`);
  return asset.browser_download_url;
}

/**
 * Build the plugin and create artifacts
 */
async function buildPlugin(issueNumber, pluginName) {
  const pluginDir = path.join(PLUGINS_DIR, `issue-${issueNumber}`, pluginName);
  const artifactDir = path.join(ARTIFACTS_DIR, `issue-${issueNumber}`);

  try {
    await fs.access(pluginDir);
  } catch {
    throw new Error(
      `Plugin directory not found: ${pluginDir}. Claude may have placed the plugin in an unexpected location.`,
    );
  }

  await fs.mkdir(artifactDir, { recursive: true });

  // Use shell: true to ensure npm is found in PATH
  const spawnOptions = { cwd: pluginDir, shell: true, stdio: "inherit" };

  return new Promise((resolve, reject) => {
    console.log("   Running npm install...");
    const npm = spawn("npm", ["install"], spawnOptions);

    npm.on("error", (err) =>
      reject(new Error(`npm install error: ${err.message}`)),
    );
    npm.on("close", (installCode) => {
      if (installCode !== 0) {
        reject(new Error(`npm install failed with code ${installCode}`));
        return;
      }

      console.log("   Running sudo npm link matterbridge...");
      const link = spawn("sudo", ["npm", "link", "matterbridge"], spawnOptions);

      link.on("error", (err) =>
        reject(new Error(`npm link matterbridge error: ${err.message}`)),
      );
      link.on("close", (linkCode) => {
        if (linkCode !== 0) {
          reject(
            new Error(`npm link matterbridge failed with code ${linkCode}`),
          );
          return;
        }

        console.log("   Running npm run build...");
        const build = spawn("npm", ["run", "build"], spawnOptions);

        build.on("error", (err) =>
          reject(new Error(`npm build error: ${err.message}`)),
        );
        build.on("close", (buildCode) => {
          if (buildCode !== 0) {
            reject(new Error(`npm build failed with code ${buildCode}`));
            return;
          }

          console.log("   Running npm pack...");
          const pack = spawn("npm", ["pack"], { cwd: pluginDir, shell: true });

          let packOutput = "";
          pack.stdout?.on("data", (data) => {
            packOutput += data.toString();
          });

          pack.on("error", (err) =>
            reject(new Error(`npm pack error: ${err.message}`)),
          );
          pack.on("close", (packCode) => {
            if (packCode !== 0) {
              reject(new Error(`npm pack failed with code ${packCode}`));
              return;
            }

            // Get tarball name from npm pack output or use default
            const tarball = packOutput.trim() || `${pluginName}-1.0.0.tgz`;
            console.log(`   Created tarball: ${tarball}`);

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
    const pluginName = `matterbridge-ai-factory-${generatePluginName(parsedData.deviceName)}`;
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
    const pluginName = `matterbridge-ai-factory-${generatePluginName(parsedData.deviceName)}`;
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

    // Publish to branch (use fix method to commit to existing branch if it exists)
    const branchName = `plugin/issue-${issueNumber}-${pluginName.replace("matterbridge-", "")}`;
    let publishResult;

    // Check if branch already exists on remote
    const repoRoot = path.resolve(__dirname, "..");
    try {
      execSync(`git ls-remote --exit-code origin ${branchName}`, {
        cwd: repoRoot,
        stdio: "pipe",
      });
      // Branch exists, use fix method
      console.log(`   Branch ${branchName} exists, updating...`);
      publishResult = await publishFixToBranch(
        issueNumber,
        pluginName,
        artifactPath,
      );
    } catch {
      // Branch doesn't exist, create new
      console.log(`   Branch ${branchName} doesn't exist, creating...`);
      publishResult = await publishPluginToBranch(
        issueNumber,
        pluginName,
        artifactPath,
      );
    }

    const { artifactUrl, branchUrl } = publishResult;

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

/**
 * Resume interrupted work on a plugin
 */
async function resumeWork(issueNumber) {
  console.log(`🔄 Resuming work on issue #${issueNumber}...`);

  try {
    // Get issue data
    const { data: issue } = await octokit.issues.get({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      issue_number: issueNumber,
    });

    const parsedData = parseIssueBody(issue.body || "");
    const pluginName = `matterbridge-ai-factory-${generatePluginName(parsedData.deviceName)}`;
    const pluginDir = path.join(
      PLUGINS_DIR,
      `issue-${issueNumber}`,
      pluginName,
    );

    // Create resume prompt
    const prompt = `Resume work on ${pluginName}. Be concise, write code not explanations.

The previous session was interrupted. Continue where you left off:
1. Check what files exist and what's missing
2. Complete any unfinished code
3. Build and test the plugin
4. Make sure everything compiles and works

The plugin directory is: ${pluginDir}
If the directory doesn't exist, start fresh by cloning the template.`;

    // Ensure plugin directory exists (create if needed)
    await fs.mkdir(path.dirname(pluginDir), { recursive: true });

    // Run Claude to resume work
    await runClaudeCodeCLI(issueNumber, prompt, path.dirname(pluginDir));

    // Build the plugin
    console.log("📦 Building plugin...");
    const artifactPath = await buildPlugin(issueNumber, pluginName);
    console.log(`✅ Plugin built: ${artifactPath}`);

    // Publish to branch
    console.log("📤 Publishing plugin to branch...");
    const { artifactUrl, branchUrl, branchName } = await publishPluginToBranch(
      issueNumber,
      pluginName,
      artifactPath,
    );

    // Post success comment
    await postComment(
      issueNumber,
      `## ✅ Plugin Ready for Testing

Your Matterbridge plugin has been created!

### Plugin Details
- **Name:** \`${pluginName}\`
- **Branch:** [\`${branchName}\`](${branchUrl})

### Installation

\`\`\`bash
curl -L -o ${pluginName}.tgz "${artifactUrl}"
\`\`\`

Then upload the .tgz file to Matterbridge UI or install via npm.

### 📦 [Download Plugin](${artifactUrl})

Please test and report any issues.

---
*This is an automated response from the Matterbridge AI Plugin Factory*`,
    );

    await updateLabels(issueNumber, ["ready-for-testing"], ["in-progress"]);
    console.log("✅ Resume completed successfully!");
  } catch (error) {
    console.error("Error resuming work:", error);
    process.exit(1);
  }
}

/**
 * Process feedback/bug report and fix the plugin
 */
async function processFeedback(issueNumber) {
  console.log(`🔧 Processing feedback for issue #${issueNumber}...`);

  try {
    // Get issue data
    const { data: issue } = await octokit.issues.get({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      issue_number: issueNumber,
    });

    const parsedData = parseIssueBody(issue.body || "");
    const pluginName = `matterbridge-ai-factory-${generatePluginName(parsedData.deviceName)}`;
    const branchName = `plugin/issue-${issueNumber}-${pluginName.replace("matterbridge-", "")}`;
    const pluginDir = path.join(
      PLUGINS_DIR,
      `issue-${issueNumber}`,
      pluginName,
    );

    // Ensure the plugin source is present in the working tree by checking out
    // the plugin branch. Safe because we expect the caller (cron wrapper or
    // user) to have run `ensureCleanWorkspace` beforehand.
    try {
      await checkoutPluginBranch(branchName);
    } catch (err) {
      console.error(
        `❌ Could not checkout branch ${branchName}: ${err.message}`,
      );
      console.log("Run without --fix to generate the plugin first.");
      process.exit(1);
    }

    // Verify plugin dir now exists
    try {
      await fs.access(pluginDir);
    } catch {
      console.error(
        `❌ Plugin directory not found after branch checkout: ${pluginDir}`,
      );
      process.exit(1);
    }

    // Get comments and extract feedback
    const comments = await getIssueComments(issueNumber);
    const feedback = extractLatestFeedback(comments);

    if (!feedback) {
      console.error("❌ No user feedback found in comments");
      process.exit(1);
    }

    console.log(`📝 Found feedback from ${feedback.author}`);
    console.log(`   "${feedback.body.substring(0, 100)}..."`);

    // Post acknowledgment
    await postComment(
      issueNumber,
      `## 🔧 Processing Bug Report

I'm analyzing the feedback and working on a fix.

**Feedback from:** @${feedback.author}

I'll post an updated plugin when ready.

---
*This is an automated response from the Matterbridge AI Plugin Factory*`,
    );

    await updateLabels(issueNumber, ["in-progress"], ["ready-for-testing"]);

    // Download any images attached to the feedback so Claude can read them.
    // Stored in /tmp so they never risk being committed to the plugin branch.
    const imageUrls = extractImageUrls(feedback.body);
    const localImagePaths = [];
    let imagesDir = null;
    if (imageUrls.length > 0) {
      console.log(
        `🖼️  Found ${imageUrls.length} image(s) in feedback, downloading...`,
      );
      imagesDir = path.join(
        "/tmp",
        `matterbridge-feedback-images-${issueNumber}-${Date.now()}`,
      );
      await fs.mkdir(imagesDir, { recursive: true });
      for (let i = 0; i < imageUrls.length; i++) {
        const local = await downloadImage(imageUrls[i], imagesDir, i + 1);
        if (local) localImagePaths.push(local);
      }
    }

    // Create fix prompt
    const prompt = createFeedbackPrompt(
      issueNumber,
      parsedData,
      feedback,
      pluginName,
      localImagePaths,
    );

    // Run Claude to fix the plugin
    try {
      await runClaudeCodeCLI(issueNumber, prompt, pluginDir);
    } finally {
      // Clean up feedback images from /tmp (Claude has already read them)
      if (imagesDir) {
        execSync(`rm -rf "${imagesDir}"`, { stdio: "pipe" });
      }
    }

    // Rebuild the plugin
    console.log("📦 Rebuilding plugin...");
    const artifactPath = await buildPlugin(issueNumber, pluginName);
    console.log(`✅ Plugin rebuilt: ${artifactPath}`);

    // Publish fix to existing branch
    console.log("📤 Publishing fix to branch...");
    const {
      artifactUrl,
      branchUrl,
      branchName: publishedBranchName,
    } = await publishFixToBranch(issueNumber, pluginName, artifactPath);
    // keep a reference without shadowing the outer branchName
    void publishedBranchName;

    // Post success comment
    await postComment(
      issueNumber,
      `## ✅ Plugin Updated

I've applied a fix based on your feedback.

### Plugin Details
- **Name:** \`${pluginName}\`
- **Branch:** [\`${branchName}\`](${branchUrl})

### Installation

\`\`\`bash
curl -L -o ${pluginName}-1.0.0.tgz "${artifactUrl}"
npm install ./${pluginName}-1.0.0.tgz
\`\`\`

### 📦 [Download Updated Plugin](${artifactUrl})

Please test again and let me know if the issue is resolved.

---
*This is an automated response from the Matterbridge AI Plugin Factory*`,
    );

    await updateLabels(issueNumber, ["ready-for-testing"], ["in-progress"]);
    console.log("✅ Plugin fix published successfully!");
  } catch (error) {
    console.error("Error processing feedback:", error);

    await postComment(
      issueNumber,
      `## ❌ Error Processing Feedback

An error occurred while trying to fix the plugin:

\`\`\`
${error.message}
\`\`\`

---
*This is an automated response from the Matterbridge AI Plugin Factory*`,
    );

    await updateLabels(issueNumber, ["error"], ["in-progress"]);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const publishOnlyFlag = args.includes("--publish-only");
  const fixFlag = args.includes("--fix");
  const resumeFlag = args.includes("--resume");

  // Parse --model flag (supports both "--model value" and "--model=value")
  const modelIdx = args.findIndex((a) => a === "--model");
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    CLAUDE_MODEL = args[modelIdx + 1];
  } else {
    const modelEq = args.find((a) => a.startsWith("--model="));
    if (modelEq) CLAUDE_MODEL = modelEq.split("=")[1];
  }

  // Issue number is the first non-flag argument (and not a flag value)
  const issueNumber = args.find((a, i) => {
    if (a.startsWith("--")) return false;
    // Skip value of --model
    if (i > 0 && args[i - 1] === "--model") return false;
    return true;
  });

  if (publishOnlyFlag && issueNumber) {
    // Publish existing plugin only
    publishOnly(parseInt(issueNumber));
  } else if (fixFlag && issueNumber) {
    // Process feedback and fix the plugin
    processFeedback(parseInt(issueNumber));
  } else if (resumeFlag && issueNumber) {
    // Resume interrupted work
    resumeWork(parseInt(issueNumber));
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
  processFeedback,
  resumeWork,
  parseIssueBody,
  validateRequest,
  ensureCleanWorkspace,
  checkoutPluginBranch,
};
