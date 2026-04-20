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
const { processIssue } = require("./process-issue");

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_REPO_NAME;

async function processNextIssue() {
  console.log("🔍 Looking for the oldest never-generated plugin request...");

  const { data: issues } = await octokit.issues.listForRepo({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    labels: "plugin-request,pending-review",
    state: "open",
    sort: "created",
    direction: "asc",
    per_page: 1,
  });

  if (issues.length === 0) {
    console.log("✅ No pending plugin requests. Nothing to do.");
    return;
  }

  const issue = issues[0];
  console.log(
    `➡️  Processing issue #${issue.number}: ${issue.title} (created ${issue.created_at})`,
  );

  await processIssue(issue);
  console.log(`✅ Finished processing issue #${issue.number}`);
}

if (require.main === module) {
  processNextIssue().catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
  });
}

module.exports = { processNextIssue };
