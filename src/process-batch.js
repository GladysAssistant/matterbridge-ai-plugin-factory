#!/usr/bin/env node

/**
 * Batch factory runner — depile the queue until time or credits run out.
 *
 * Designed for an hourly cron: each invocation processes as many plugins as
 * possible within a time budget, then stops cleanly. When Claude credits are
 * exhausted, the factory pauses itself and re-queues the current issue.
 *
 * Usage:
 *   node src/process-batch.js
 *   node src/process-batch.js --model claude-opus-4-7
 *   node src/process-batch.js --dry-run
 *   node src/process-batch.js --status
 *   node src/process-batch.js --clear-pause
 *
 * Environment (all optional):
 *   FACTORY_MAX_RUNTIME_MS      — stop starting new jobs after this (default 4.5h)
 *   FACTORY_MIN_JOB_MS          — need at least this much time left (default 45min)
 *   FACTORY_MAX_PLUGINS         — max successful jobs per run (default 6)
 *   FACTORY_PAUSE_DURATION_MS   — pause after credit exhaustion (default 5h)
 *   FACTORY_STALE_IN_PROGRESS_MS — recover stuck in-progress after (default 3h)
 */

require("dotenv").config();

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
const {
  processIssue,
  processFeedback,
  ensureCleanWorkspace,
  ensureCleanBetweenJobs,
  requeueInterruptedIssue,
  CreditsExhaustedError,
} = require("./process-issue");
const {
  acquireFactoryLock,
  isPaused,
  getPauseInfo,
  setPause,
  clearPause,
  recoverStaleInProgressIssues,
} = require("./factory-state");
const { notifyStart, notifySuccess, notifyFailure, notifyInfo } = require("./telegram");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_REPO_NAME;

const BOT_SIGNATURE =
  "*This is an automated response from the Matterbridge AI Plugin Factory*";

const PROCESSED_LABELS = new Set([
  "in-progress",
  "ready-for-testing",
  "completed",
]);

const DEFAULT_MAX_RUNTIME_MS = 4.5 * 60 * 60 * 1000;
const DEFAULT_MIN_JOB_MS = 45 * 60 * 1000;
const DEFAULT_MAX_PLUGINS = 6;

function envMs(name, fallback) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envInt(name, fallback) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function isBotComment(comment) {
  return (comment?.body || "").includes(BOT_SIGNATURE);
}

function issueUrl(issue) {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/${issue.number}`;
}

function formatIssueSummary(issue, extra = "") {
  const url = issueUrl(issue);
  return `{b}${issue.title}{/b}${extra ? `\n${extra}` : ""}\n{link:${url}}${url}{/link}`;
}

function remainingMs(startedAt, maxRuntimeMs) {
  return maxRuntimeMs - (Date.now() - startedAt);
}

function canStartAnotherJob(startedAt, maxRuntimeMs, minJobMs) {
  return remainingMs(startedAt, maxRuntimeMs) >= minJobMs;
}

async function getIssueLabels(issueNumber) {
  const { data } = await octokit.issues.get({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
  });
  return (data.labels || []).map((l) => (typeof l === "string" ? l : l.name));
}

/**
 * Pick the next job. Fixes (user waiting) take priority over new generations.
 */
async function pickNextJob() {
  const fix = await pickNextFix();
  if (fix) return fix;
  return pickNextGeneration();
}

async function pickNextGeneration() {
  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    state: "open",
    sort: "created",
    direction: "asc",
    per_page: 100,
  });

  const candidates = issues.filter((issue) => {
    if (issue.pull_request) return false;
    const labels = (issue.labels || []).map((l) =>
      typeof l === "string" ? l : l.name,
    );
    return !labels.some((l) => PROCESSED_LABELS.has(l));
  });

  if (candidates.length === 0) return null;

  const issue = candidates[0];
  return {
    type: "generate",
    issue,
    jobName: `generate #${issue.number}`,
    summary: formatIssueSummary(issue),
  };
}

async function pickNextFix() {
  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    labels: "ready-for-testing",
    state: "open",
    sort: "updated",
    direction: "asc",
    per_page: 100,
  });

  const openIssues = issues.filter((i) => !i.pull_request);
  if (openIssues.length === 0) return null;

  for (const issue of openIssues) {
    const totalComments = issue.comments || 0;
    if (totalComments === 0) continue;

    const perPage = 100;
    const lastPage = Math.ceil(totalComments / perPage);
    const { data: comments } = await octokit.issues.listComments({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      issue_number: issue.number,
      per_page: perPage,
      page: lastPage,
    });

    if (comments.length === 0) continue;
    const lastComment = comments[comments.length - 1];
    if (isBotComment(lastComment)) continue;

    return {
      type: "fix",
      issue,
      jobName: `fix #${issue.number}`,
      summary: formatIssueSummary(
        issue,
        `Feedback by {b}@${lastComment.user.login}{/b}`,
      ),
    };
  }

  return null;
}

async function runJob(job) {
  if (job.type === "fix") {
    await processFeedback(job.issue.number);
  } else {
    await processIssue(job.issue);
  }

  const labels = await getIssueLabels(job.issue.number);
  if (labels.includes("ready-for-testing")) return "success";
  if (labels.includes("needs-info")) return "skipped";
  if (labels.includes("error")) return "failed";
  return "unknown";
}

async function handleCreditsExhausted(job, err) {
  const pauseMs = envMs("FACTORY_PAUSE_DURATION_MS", 5 * 60 * 60 * 1000);
  const resumeAfter = setPause("credits_exhausted", {
    resumeAfterMs: pauseMs,
    lastIssue: job?.issue?.number ?? null,
  });

  const details =
    `Credits exhausted on {b}${job.jobName}{/b}\n` +
    `Paused until {code}${resumeAfter}{/code}\n` +
    `{code}${err.message}{/code}`;

  await notifyInfo("factory paused", details);
  console.log(`⏸️  Factory paused until ${resumeAfter}`);
}

async function processBatch({ dryRun = false } = {}) {
  if (isPaused()) {
    const info = getPauseInfo();
    console.log(
      `⏸️  Factory paused (${info.reason}). Resumes after ${info.resumeAfter}.`,
    );
    return { paused: true, processed: 0 };
  }

  if (!acquireFactoryLock()) {
    return { locked: true, processed: 0 };
  }

  const maxRuntimeMs = envMs("FACTORY_MAX_RUNTIME_MS", DEFAULT_MAX_RUNTIME_MS);
  const minJobMs = envMs("FACTORY_MIN_JOB_MS", DEFAULT_MIN_JOB_MS);
  const maxPlugins = envInt("FACTORY_MAX_PLUGINS", DEFAULT_MAX_PLUGINS);

  console.log("🏭 Matterbridge AI Plugin Factory — batch run");
  console.log(
    `   Budget: ${(maxRuntimeMs / 3600000).toFixed(1)}h max, ${(minJobMs / 60000).toFixed(0)}min min/job, ${maxPlugins} plugins max`,
  );

  const recovered = await recoverStaleInProgressIssues(
    octokit,
    REPO_OWNER,
    REPO_NAME,
    requeueInterruptedIssue,
  );
  if (recovered > 0) {
    console.log(`♻️  Recovered ${recovered} stale in-progress issue(s)`);
  }

  if (dryRun) {
    const job = await pickNextJob();
    if (!job) {
      console.log("✅ Dry run: queue empty.");
      return { dryRun: true, processed: 0 };
    }
    console.log(`🔎 Dry run: would run ${job.jobName} — ${job.issue.title}`);
    return { dryRun: true, nextJob: job.jobName };
  }

  await ensureCleanWorkspace();
  const startedAt = Date.now();

  let completed = 0;
  let failed = 0;
  let skipped = 0;

  while (completed < maxPlugins) {
    if (!canStartAnotherJob(startedAt, maxRuntimeMs, minJobMs)) {
      const left = Math.round(remainingMs(startedAt, maxRuntimeMs) / 60000);
      console.log(
        `⏱️  Time budget nearly exhausted (${left} min left, need ${Math.round(minJobMs / 60000)} min). Stopping cleanly.`,
      );
      break;
    }

    const job = await pickNextJob();
    if (!job) {
      console.log("✅ Queue empty. Nothing left to process.");
      break;
    }

    const leftMin = Math.round(remainingMs(startedAt, maxRuntimeMs) / 60000);
    console.log(
      `\n➡️  [${completed + failed + skipped + 1}] ${job.jobName}: ${job.issue.title} (~${leftMin} min left)`,
    );
    await notifyStart(job.jobName, job.summary);

    try {
      const outcome = await runJob(job);

      if (outcome === "success") {
        completed++;
        console.log(`✅ ${job.jobName} succeeded`);
        await notifySuccess(job.jobName, job.summary);
      } else if (outcome === "skipped") {
        skipped++;
        console.log(`⏭️  ${job.jobName} skipped (needs-info)`);
      } else {
        failed++;
        console.log(`❌ ${job.jobName} failed`);
        await notifyFailure(job.jobName, new Error("Issue labeled error after processing"));
      }
    } catch (err) {
      if (err instanceof CreditsExhaustedError) {
        await handleCreditsExhausted(job, err);
        return {
          creditsExhausted: true,
          completed,
          failed,
          skipped,
          lastJob: job.jobName,
        };
      }

      failed++;
      console.error(`❌ ${job.jobName} error:`, err.message);
      await notifyFailure(job.jobName, err);
    }

    if (completed + failed + skipped > 0) {
      await ensureCleanBetweenJobs();
    }
  }

  const elapsedMin = Math.round((Date.now() - startedAt) / 60000);
  const summary =
    `Batch done in {b}${elapsedMin}{/b} min\n` +
    `✅ ${completed} succeeded · ❌ ${failed} failed · ⏭️ ${skipped} skipped`;

  console.log(`\n📊 Batch complete: ${completed} ok, ${failed} failed, ${skipped} skipped (${elapsedMin} min)`);
  await notifyInfo("batch complete", summary);

  return { completed, failed, skipped, elapsedMin };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--status")) {
    const info = getPauseInfo();
    if (!info?.paused) {
      console.log("✅ Factory is active (not paused).");
    } else {
      console.log(JSON.stringify(info, null, 2));
    }
    return;
  }

  if (args.includes("--clear-pause")) {
    clearPause();
    console.log("✅ Factory pause cleared.");
    return;
  }

  const dryRun = args.includes("--dry-run");
  const result = await processBatch({ dryRun });

  if (result.creditsExhausted) {
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
  });
}

module.exports = { processBatch, pickNextJob };
