#!/usr/bin/env node

/**
 * Process the oldest never-generated plugin request.
 *
 * Fetches all open issues labeled `plugin-request` + `pending-review`,
 * sorted from oldest to newest, and generates the first one.
 *
 * Designed to be run by a daily CRON job on the VM so that one new plugin
 * is generated per day.
 *
 * Usage:
 *   node src/process-next-issue.js
 *   node src/process-next-issue.js --model claude-opus-4-7
 */

require("dotenv").config();

// Forward --model flag to process-issue.js via CLAUDE_MODEL env var BEFORE requiring it
// (process-issue.js reads CLAUDE_MODEL at module load time)
(function applyModelFlag() {
  const args = process.argv.slice(2);
  const modelIdx = args.findIndex((a) => a === "--model");
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    process.env.CLAUDE_MODEL = args[modelIdx + 1];
  } else {
    const modelEq = args.find((a) => a.startsWith("--model="));
    if (modelEq) process.env.CLAUDE_MODEL = modelEq.split("=")[1];
  }
})();

const { Octokit } = require("@octokit/rest");
const { processIssue, ensureCleanWorkspace } = require("./process-issue");
const {
  notifyStart,
  notifySuccess,
  notifyFailure,
  notifyInfo,
} = require("./telegram");

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_REPO_NAME;

// Labels that mean the factory has already started (or finished) working on it
const PROCESSED_LABELS = new Set([
  "in-progress",
  "ready-for-testing",
  "completed",
  "needs-info",
]);

async function processNextIssue() {
  await ensureCleanWorkspace();

  console.log("🔍 Looking for the oldest never-generated plugin request...");

  // Fetch all open issues (paginated) and filter client-side so that issues
  // without any labels are still considered.
  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    state: "open",
    sort: "created",
    direction: "asc",
    per_page: 100,
  });

  // Exclude pull requests and already-processed issues
  const candidates = issues.filter((issue) => {
    if (issue.pull_request) return false;
    const labels = (issue.labels || []).map((l) =>
      typeof l === "string" ? l : l.name,
    );
    return !labels.some((l) => PROCESSED_LABELS.has(l));
  });

  if (candidates.length === 0) {
    console.log("✅ No never-generated issues found. Nothing to do.");
    await notifyInfo("process-next-issue", "No pending issues to generate.");
    return;
  }

  const issue = candidates[0];
  const jobName = `generate #${issue.number}`;
  const issueUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/${issue.number}`;
  const summary = `{b}${issue.title}{/b}\n{link:${issueUrl}}${issueUrl}{/link}`;

  console.log(
    `➡️  Processing issue #${issue.number}: ${issue.title} (created ${issue.created_at})`,
  );
  await notifyStart(jobName, summary);

  try {
    await processIssue(issue);
    console.log(`✅ Finished processing issue #${issue.number}`);
    await notifySuccess(jobName, summary);
  } catch (err) {
    await notifyFailure(jobName, err);
    throw err;
  }
}

if (require.main === module) {
  processNextIssue().catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
  });
}

module.exports = { processNextIssue };
