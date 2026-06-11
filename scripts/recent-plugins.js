#!/usr/bin/env node

/**
 * List plugin integrations published by the factory in the last N hours.
 *
 * Uses GitHub releases tagged `plugin-issue-N` (artifact publish time).
 * If a release was updated (fix republish), the latest asset `updated_at` counts.
 *
 * Usage:
 *   node scripts/recent-plugins.js
 *   node scripts/recent-plugins.js --hours 24
 *   node scripts/recent-plugins.js --json
 *
 * Requires .env: GITHUB_TOKEN, GITHUB_REPO_OWNER, GITHUB_REPO_NAME
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { Octokit } = require("@octokit/rest");
const { parseIssueBody } = require("../src/process-issue");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO = process.env.GITHUB_REPO_NAME;

const DEFAULT_HOURS = 12;

function parseArgs(argv) {
  let hours = DEFAULT_HOURS;
  const json = argv.includes("--json");

  const hoursIdx = argv.findIndex((a) => a === "--hours");
  if (hoursIdx !== -1 && argv[hoursIdx + 1]) {
    hours = parseFloat(argv[hoursIdx + 1]);
  }

  return { hours, json };
}

function formatTitle(title) {
  return title.replace(/^\[PLUGIN REQUEST\]\s*/i, "").trim();
}

function deviceNameFromIssue(issue) {
  const parsed = parseIssueBody(issue.body || "");
  if (parsed.deviceName) return parsed.deviceName;
  return formatTitle(issue.title || "");
}

function latestAssetTime(release) {
  if (!release.assets?.length) {
    return new Date(release.published_at || release.created_at).getTime();
  }
  return Math.max(
    ...release.assets.map((a) => new Date(a.updated_at).getTime()),
  );
}

async function fetchRecentPlugins(hours) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  const releases = await octokit.paginate(octokit.repos.listReleases, {
    owner: OWNER,
    repo: REPO,
    per_page: 100,
  });

  const recent = [];

  for (const release of releases) {
    const match = release.tag_name.match(/^plugin-issue-(\d+)$/);
    if (!match) continue;

    const publishedMs = latestAssetTime(release);
    if (publishedMs < cutoff) continue;

    const issueNumber = parseInt(match[1], 10);
    const { data: issue } = await octokit.issues.get({
      owner: OWNER,
      repo: REPO,
      issue_number: issueNumber,
    });

    const artifact = release.assets.find((a) => a.name.endsWith(".tgz"));

    recent.push({
      issueNumber,
      deviceName: deviceNameFromIssue(issue),
      title: issue.title,
      publishedAt: new Date(publishedMs).toISOString(),
      ageHours: ((Date.now() - publishedMs) / (60 * 60 * 1000)).toFixed(1),
      issueUrl: issue.html_url,
      releaseUrl: release.html_url,
      downloadUrl: artifact?.browser_download_url || null,
      artifactName: artifact?.name || null,
    });
  }

  recent.sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

  return recent;
}

function printTable(plugins, hours) {
  if (plugins.length === 0) {
    console.log(`✅ No plugins published in the last ${hours} hour(s).`);
    return;
  }

  console.log(
    `🆕 ${plugins.length} plugin(s) published in the last ${hours} hour(s)\n`,
  );

  for (const p of plugins) {
    console.log(`#${p.issueNumber}  ${p.deviceName}`);
    console.log(`   ${p.ageHours}h ago  ·  ${p.publishedAt.replace("T", " ").slice(0, 19)} UTC`);
    console.log(`   ${p.issueUrl}`);
    if (p.downloadUrl) console.log(`   📦 ${p.downloadUrl}`);
    console.log();
  }
}

async function main() {
  const { hours, json } = parseArgs(process.argv.slice(2));

  if (!process.env.GITHUB_TOKEN || !OWNER || !REPO) {
    console.error(
      "❌ Missing GITHUB_TOKEN, GITHUB_REPO_OWNER or GITHUB_REPO_NAME in .env",
    );
    process.exit(1);
  }

  const plugins = await fetchRecentPlugins(hours);

  if (json) {
    console.log(JSON.stringify(plugins, null, 2));
  } else {
    printTable(plugins, hours);
  }
}

main().catch((err) => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});
