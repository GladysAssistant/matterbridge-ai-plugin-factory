/**
 * Webhook server for real-time GitHub event processing
 */

const http = require('http');
const crypto = require('crypto');
const { processIssue } = require('./process-issue');
const { Octokit } = require('@octokit/rest');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3000;
const REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_REPO_NAME;

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

/**
 * Verify GitHub webhook signature
 */
function verifySignature(payload, signature) {
  if (!WEBHOOK_SECRET) {
    console.warn('WEBHOOK_SECRET not set, skipping signature verification');
    return true;
  }

  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

/**
 * Check if issue has required labels
 */
function hasRequiredLabels(issue) {
  const labels = issue.labels.map((l) => l.name);
  return labels.includes('plugin-request') && labels.includes('pending-review');
}

/**
 * Handle incoming webhook events
 */
async function handleWebhook(event, payload) {
  console.log(`📥 Received event: ${event}`);

  switch (event) {
    case 'issues':
      await handleIssueEvent(payload);
      break;

    case 'issue_comment':
      await handleCommentEvent(payload);
      break;

    default:
      console.log(`Ignoring event: ${event}`);
  }
}

/**
 * Handle issue events
 */
async function handleIssueEvent(payload) {
  const { action, issue } = payload;

  console.log(`Issue #${issue.number} - Action: ${action}`);

  // Process new issues or issues that were labeled
  if ((action === 'opened' || action === 'labeled') && hasRequiredLabels(issue)) {
    console.log(`🚀 Processing issue #${issue.number}`);
    await processIssue(issue);
  }
}

/**
 * Handle comment events (for feedback processing)
 */
async function handleCommentEvent(payload) {
  const { action, issue, comment } = payload;

  // Only process new comments
  if (action !== 'created') return;

  // Ignore bot comments
  if (comment.user.type === 'Bot') return;

  // Check if this is a feedback comment on a ready-for-testing issue
  const labels = issue.labels.map((l) => l.name);

  if (labels.includes('ready-for-testing')) {
    console.log(`📝 Feedback received on issue #${issue.number}`);

    // Check for specific feedback keywords
    const commentLower = comment.body.toLowerCase();

    if (commentLower.includes('works') || commentLower.includes('success')) {
      // Positive feedback - mark as completed
      await octokit.issues.createComment({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        issue_number: issue.number,
        body: `## 🎉 Great News!

Thank you for confirming the plugin works! 

The plugin will be considered for publishing to npm. Feel free to close this issue if everything is working as expected.

---
*This is an automated response from the Matterbridge AI Plugin Factory*`,
      });

      await octokit.issues.update({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        issue_number: issue.number,
        labels: [...labels.filter((l) => l !== 'ready-for-testing'), 'completed'],
      });
    } else if (
      commentLower.includes('error') ||
      commentLower.includes('bug') ||
      commentLower.includes('issue') ||
      commentLower.includes("doesn't work") ||
      commentLower.includes('not working')
    ) {
      // Negative feedback - mark for revision
      await octokit.issues.createComment({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        issue_number: issue.number,
        body: `## 🔧 Feedback Noted

Thank you for your feedback. I've noted the issues you've reported.

The AI agent will analyze your feedback and attempt to fix the problems. Please provide as much detail as possible about:
- Error messages
- Steps to reproduce
- Expected vs actual behavior

---
*This is an automated response from the Matterbridge AI Plugin Factory*`,
      });

      await octokit.issues.update({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        issue_number: issue.number,
        labels: [...labels.filter((l) => l !== 'ready-for-testing'), 'needs-revision'],
      });
    }
  }
}

/**
 * Start the webhook server
 */
async function startWebhookServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      // Verify signature
      const signature = req.headers['x-hub-signature-256'];
      if (!verifySignature(body, signature)) {
        console.error('Invalid webhook signature');
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      try {
        const payload = JSON.parse(body);
        const event = req.headers['x-github-event'];

        // Process asynchronously
        handleWebhook(event, payload).catch(console.error);

        res.writeHead(200);
        res.end('OK');
      } catch (error) {
        console.error('Error processing webhook:', error);
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });
  });

  server.listen(WEBHOOK_PORT, () => {
    console.log(`🌐 Webhook server listening on port ${WEBHOOK_PORT}`);
    console.log(`Endpoint: http://localhost:${WEBHOOK_PORT}/webhook`);
  });

  return server;
}

module.exports = { startWebhookServer };
