#!/usr/bin/env node

/**
 * Process the oldest issue that needs a --fix pass.
 *
 * An issue needs a fix when:
 *   - it has the `ready-for-testing` label, AND
 *   - its most recent comment is from a human (not the Matterbridge AI Factory bot).
 *
 * Fetches such issues sorted by least-recently-updated first and runs
 * `processFeedback` on the oldest one, then exits.
 *
 * Designed to be run by a CRON job on the VM alongside `process-next-issue.js`
 * so that user feedback is handled automatically.
 *
 * Usage:
 *   node src/process-next-fix.js
 *   node src/process-next-fix.js --model claude-opus-4-7
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
const { processFeedback, ensureCleanWorkspace } = require("./process-issue");
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

// Signature used by the factory in every comment it posts
const BOT_SIGNATURE =
  "*This is an automated response from the Matterbridge AI Plugin Factory*";

/**
 * Return true if the given comment was posted by the factory bot.
 */
function isBotComment(comment) {
  return (comment?.body || "").includes(BOT_SIGNATURE);
}

async function processNextFix() {
  await ensureCleanWorkspace();

  console.log("🔍 Looking for the oldest issue needing a fix...");

  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    labels: "ready-for-testing",
    state: "open",
    sort: "updated",
    direction: "asc",
    per_page: 100,
  });

  // Exclude pull requests
  const openIssues = issues.filter((i) => !i.pull_request);

  if (openIssues.length === 0) {
    console.log("✅ No issues in `ready-for-testing`. Nothing to do.");
    return;
  }

  // Find the first issue whose latest comment is from a human
  for (const issue of openIssues) {
    const { data: comments } = await octokit.issues.listComments({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      issue_number: issue.number,
      per_page: 100,
    });

    if (comments.length === 0) continue;

    const lastComment = comments[comments.length - 1];
    if (isBotComment(lastComment)) continue;

    const jobName = `fix #${issue.number}`;
    const summary = `*${issue.title}*\nFeedback by @${lastComment.user.login}\nhttps://github.com/${REPO_OWNER}/${REPO_NAME}/issues/${issue.number}`;

    console.log(
      `➡️  Fixing issue #${issue.number}: ${issue.title} (last feedback by @${lastComment.user.login} at ${lastComment.created_at})`,
    );
    await notifyStart(jobName, summary);

    try {
      await processFeedback(issue.number);
      console.log(`✅ Finished fixing issue #${issue.number}`);
      await notifySuccess(jobName, summary);
    } catch (err) {
      await notifyFailure(jobName, err);
      throw err;
    }
    return;
  }

  console.log("✅ No issues with pending user feedback. Nothing to do.");
  await notifyInfo("process-next-fix", "No issues with pending feedback.");
}

if (require.main === module) {
  processNextFix().catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
  });
}

module.exports = { processNextFix };
