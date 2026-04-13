#!/usr/bin/env node

/**
 * Matterbridge AI Plugin Factory
 * Main entry point for the factory automation
 */

require('dotenv').config();

const { processNewIssues } = require('./process-issue');
const { startWebhookServer } = require('./webhook-server');

const MODE = process.env.FACTORY_MODE || 'polling';

async function main() {
  console.log('🏭 Matterbridge AI Plugin Factory Starting...');
  console.log(`Mode: ${MODE}`);

  if (MODE === 'webhook') {
    // Start webhook server for real-time GitHub events
    await startWebhookServer();
  } else {
    // Polling mode - check for new issues periodically
    console.log('Running in polling mode...');
    await processNewIssues();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
