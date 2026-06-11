#!/usr/bin/env node

/**
 * Remove duplicate spam comments left by the AI factory on GitHub issues.
 *
 * Deletes bot comments whose title is one of:
 *   - 🤖 AI Plugin Factory - Request Received
 *   - 🔨 Development Started
 *   - ❌ Error During Processing
 *
 * Success comments (✅ Plugin Ready, etc.) are kept.
 *
 * Usage:
 *   node scripts/cleanup-issue-comments.js --dry-run 33 34
 *   node scripts/cleanup-issue-comments.js --yes 33 34
 *
 * Requires .env: GITHUB_TOKEN, GITHUB_REPO_OWNER, GITHUB_REPO_NAME
 * Token needs `issues: write` (or repo scope).
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { Octokit } = require("@octokit/rest");

const BOT_SIGNATURE =
  "*This is an automated response from the Matterbridge AI Plugin Factory*";

/** Comment headings to delete (must match factory postComment templates). */
const DELETABLE_HEADINGS = [
  "## 🤖 AI Plugin Factory - Request Received",
  "## 🔨 Development Started",
  "## ❌ Error During Processing",
];

const DELETE_DELAY_MS = parseInt(process.env.CLEANUP_DELETE_DELAY_MS || "150", 10);

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO = process.env.GITHUB_REPO_NAME;

function usage() {
  console.log(`Usage:
  node scripts/cleanup-issue-comments.js [--dry-run] [--yes] <issue-number> [issue-number...]

Options:
  --dry-run   List comments that would be deleted, without deleting
  --yes       Skip confirmation prompt

Examples:
  node scripts/cleanup-issue-comments.js --dry-run 33
  node scripts/cleanup-issue-comments.js --yes 33 34 35`);
}

function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const yes = argv.includes("--yes");
  const issueNumbers = argv
    .filter((a) => !a.startsWith("--"))
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  return { dryRun, yes, issueNumbers };
}

function isDeletableComment(body) {
  if (!body || !body.includes(BOT_SIGNATURE)) return false;
  return DELETABLE_HEADINGS.some((heading) => body.includes(heading));
}

async function listIssueComments(issueNumber) {
  return octokit.paginate(octokit.issues.listComments, {
    owner: OWNER,
    repo: REPO,
    issue_number: issueNumber,
    per_page: 100,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupIssue(issueNumber, { dryRun }) {
  console.log(`\n📋 Issue #${issueNumber}`);

  const comments = await listIssueComments(issueNumber);
  const toDelete = comments.filter((c) => isDeletableComment(c.body));

  console.log(
    `   ${comments.length} comment(s) total, ${toDelete.length} to delete`,
  );

  if (toDelete.length === 0) return { total: comments.length, deleted: 0 };

  for (const comment of toDelete) {
    const heading =
      DELETABLE_HEADINGS.find((h) => comment.body.includes(h)) || "?";
    const short = heading.replace("## ", "");
    const when = comment.created_at?.slice(0, 19).replace("T", " ") || "?";

    if (dryRun) {
      console.log(`   [dry-run] would delete #${comment.id}  ${when}  ${short}`);
      continue;
    }

    await octokit.issues.deleteComment({
      owner: OWNER,
      repo: REPO,
      comment_id: comment.id,
    });
    console.log(`   🗑️  deleted #${comment.id}  ${when}  ${short}`);

    if (DELETE_DELAY_MS > 0) await sleep(DELETE_DELAY_MS);
  }

  return { total: comments.length, deleted: dryRun ? 0 : toDelete.length };
}

async function main() {
  const { dryRun, yes, issueNumbers } = parseArgs(process.argv.slice(2));

  if (issueNumbers.length === 0) {
    usage();
    process.exit(1);
  }

  if (!process.env.GITHUB_TOKEN || !OWNER || !REPO) {
    console.error(
      "❌ Missing GITHUB_TOKEN, GITHUB_REPO_OWNER or GITHUB_REPO_NAME in .env",
    );
    process.exit(1);
  }

  if (!dryRun && !yes) {
    console.log(
      `⚠️  About to delete spam factory comments on issue(s): ${issueNumbers.join(", ")}`,
    );
    console.log("   Re-run with --yes to confirm, or --dry-run to preview.\n");
    process.exit(1);
  }

  console.log(
    `🧹 Cleanup ${dryRun ? "(dry-run)" : ""} — ${OWNER}/${REPO}`,
  );
  console.log(`   Headings: ${DELETABLE_HEADINGS.map((h) => h.replace("## ", "")).join(" | ")}`);

  let grandTotal = 0;
  let grandDeleted = 0;

  for (const n of issueNumbers) {
    const { total, deleted } = await cleanupIssue(n, { dryRun });
    grandTotal += total;
    grandDeleted += deleted;
  }

  console.log(
    `\n✅ Done — ${grandDeleted} deleted, ${grandTotal - grandDeleted} kept` +
      (dryRun ? " (dry-run, nothing deleted)" : ""),
  );
}

main().catch((err) => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});
