/**
 * Persistent factory state: pause flag, process lock, stale-issue recovery.
 */

const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(REPO_ROOT, ".factory-state.json");
const LOCK_FILE = path.join(REPO_ROOT, ".factory.lock");

const DEFAULT_PAUSE_MS = 5 * 60 * 60 * 1000; // 5h Claude window
const DEFAULT_STALE_IN_PROGRESS_MS = 3 * 60 * 60 * 1000;
const DEFAULT_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function isPaused(now = Date.now()) {
  const state = readState();
  if (!state.paused) return false;
  if (state.resumeAfter && now >= Date.parse(state.resumeAfter)) {
    clearPause();
    return false;
  }
  return true;
}

function getPauseInfo() {
  const state = readState();
  if (!state.paused) return null;
  return state;
}

function setPause(reason, { resumeAfterMs = DEFAULT_PAUSE_MS, lastIssue = null } = {}) {
  const resumeAfter = new Date(Date.now() + resumeAfterMs).toISOString();
  writeState({
    paused: true,
    reason,
    pausedAt: new Date().toISOString(),
    resumeAfter,
    lastIssue,
  });
  return resumeAfter;
}

function clearPause() {
  const state = readState();
  writeState({
    ...state,
    paused: false,
    reason: null,
    pausedAt: null,
    resumeAfter: null,
  });
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prevent overlapping batch runs (e.g. hourly cron while a long batch is still running).
 * Returns true if the lock was acquired.
 */
function acquireFactoryLock() {
  const staleMs = parseInt(process.env.FACTORY_LOCK_STALE_MS || "", 10) || DEFAULT_LOCK_STALE_MS;

  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      const age = Date.now() - Date.parse(lock.startedAt || 0);
      if (isPidAlive(lock.pid) && age < staleMs) {
        console.log(
          `⏭️  Factory already running (PID ${lock.pid}, started ${lock.startedAt}). Skipping.`,
        );
        return false;
      }
      console.warn(
        `⚠️  Stale factory lock (PID ${lock.pid}, age ${Math.round(age / 60000)} min). Taking over.`,
      );
    } catch {
      console.warn("⚠️  Unreadable factory lock. Taking over.");
    }
  }

  const lock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + "\n");

  const release = () => {
    try {
      if (!fs.existsSync(LOCK_FILE)) return;
      const current = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      if (current.pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch {
      // best effort
    }
  };

  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      release();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }

  return true;
}

/**
 * Re-queue issues stuck in `in-progress` after a crash or workspace wipe.
 */
async function recoverStaleInProgressIssues(octokit, repoOwner, repoName, requeueFn) {
  const staleMs =
    parseInt(process.env.FACTORY_STALE_IN_PROGRESS_MS || "", 10) ||
    DEFAULT_STALE_IN_PROGRESS_MS;

  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner: repoOwner,
    repo: repoName,
    labels: "in-progress",
    state: "open",
    per_page: 100,
  });

  const openIssues = issues.filter((i) => !i.pull_request);
  if (openIssues.length === 0) return 0;

  let recovered = 0;
  for (const issue of openIssues) {
    const age = Date.now() - Date.parse(issue.updated_at);
    if (age < staleMs) {
      console.log(
        `   Issue #${issue.number} in-progress (${Math.round(age / 60000)} min) — still fresh, skipping`,
      );
      continue;
    }

    const tag = `plugin-issue-${issue.number}`;
    let hasRelease = false;
    try {
      await octokit.repos.getReleaseByTag({
        owner: repoOwner,
        repo: repoName,
        tag,
      });
      hasRelease = true;
    } catch {
      // no published artifact yet
    }

    console.log(
      `♻️  Recovering stale in-progress issue #${issue.number} (${hasRelease ? "fix" : "generate"})`,
    );
    await requeueFn(issue.number, { mode: hasRelease ? "fix" : "generate", recovered: true });
    recovered++;
  }

  return recovered;
}

module.exports = {
  STATE_FILE,
  LOCK_FILE,
  acquireFactoryLock,
  isPaused,
  getPauseInfo,
  setPause,
  clearPause,
  recoverStaleInProgressIssues,
};
