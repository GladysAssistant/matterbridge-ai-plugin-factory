/**
 * iRobot cloud helper. Logs into the iRobot account (Gigya + iRobot API) and
 * returns the local MQTT credentials (BLID + password) for each robot, so the
 * plugin can connect locally over MQTT/TLS on port 8883 with dorita980.
 *
 * @file cloud.ts
 * @license Apache-2.0
 */

import { AnsiLogger } from 'matterbridge/logger';

/** Local MQTT credentials for a single robot as returned by the iRobot cloud. */
export interface RobotCloudCredentials {
  /** The robot BLID (also the MQTT username). */
  blid: string;
  /** The robot name as configured in the iRobot app. */
  name: string;
  /** The local MQTT password. */
  password: string;
  /** The robot SKU, when available. */
  sku?: string;
}

interface IRobotEndpoints {
  apiKey: string;
  gigyaBase: string;
  httpBase: string;
}

const APP_ID = 'ANDROID-C7FB240E-DF34-42D7-AE4E-A8C17079A294';

async function discoverEndpoints(countryCode: string, log: AnsiLogger): Promise<IRobotEndpoints> {
  const url = `https://disc-prod.iot.irobotapi.com/v1/discover/endpoints?country_code=${encodeURIComponent(countryCode)}`;
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`Endpoint discovery failed with status ${response.status}`);
  const body = (await response.json()) as { gigya?: { api_key?: string; datacenter_domain?: string }; deployments?: Record<string, { httpBase?: string }> };
  const apiKey = body.gigya?.api_key;
  if (!apiKey) throw new Error('No Gigya API key in discovery response');
  const datacenter = body.gigya?.datacenter_domain;
  const gigyaBase = datacenter ? `https://accounts.${datacenter}` : 'https://accounts.us1.gigya.com';
  const deployments = body.deployments ?? {};
  const keys = Object.keys(deployments).sort().reverse();
  let httpBase = 'https://unauth2.prod.iot.irobotapi.com';
  for (const key of keys) {
    if (deployments[key]?.httpBase) {
      httpBase = deployments[key].httpBase as string;
      break;
    }
  }
  log.debug(`iRobot endpoints discovered: gigya=${gigyaBase} http=${httpBase}`);
  return { apiKey, gigyaBase, httpBase };
}

/**
 * Fetch the local MQTT credentials for every robot on an iRobot account.
 *
 * @param {string} email - The iRobot account email.
 * @param {string} password - The iRobot account password.
 * @param {string} countryCode - The ISO country code of the account (default 'US').
 * @param {AnsiLogger} log - Logger instance.
 * @returns {Promise<RobotCloudCredentials[]>} The credentials of each robot.
 */
export async function getCloudCredentials(email: string, password: string, countryCode: string, log: AnsiLogger): Promise<RobotCloudCredentials[]> {
  const endpoints = await discoverEndpoints(countryCode, log);

  // Step 1: Gigya login.
  const gigyaResponse = await fetch(`${endpoints.gigyaBase}/accounts.login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
    body: new URLSearchParams({ apiKey: endpoints.apiKey, targetenv: 'mobile', loginID: email, password, format: 'json', targetEnv: 'mobile' }),
  });
  const gigya = (await gigyaResponse.json()) as {
    statusCode?: number;
    errorCode?: number;
    UID?: string;
    UIDSignature?: string;
    signatureTimestamp?: string;
    sessionInfo?: { sessionToken?: string };
  };
  if (gigya.errorCode !== 0 || !gigya.UID || !gigya.UIDSignature || !gigya.signatureTimestamp) {
    throw new Error(`Gigya authentication failed (statusCode ${gigya.statusCode ?? 'unknown'}, errorCode ${gigya.errorCode ?? 'unknown'}). Check the iRobot credentials.`);
  }

  // Step 2: iRobot login.
  const irobotResponse = await fetch(`${endpoints.httpBase}/v2/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({
      app_id: APP_ID,
      assume_robot_ownership: 0,
      gigya: { signature: gigya.UIDSignature, timestamp: gigya.signatureTimestamp, uid: gigya.UID },
    }),
  });
  const irobot = (await irobotResponse.json()) as { robots?: Record<string, { name?: string; password?: string; sku?: string }> };
  if (!irobot.robots) throw new Error('iRobot login succeeded but no robots were returned for this account.');

  const credentials: RobotCloudCredentials[] = [];
  for (const [blid, robot] of Object.entries(irobot.robots)) {
    if (!robot.password) continue;
    credentials.push({ blid, name: robot.name ?? blid, password: robot.password, sku: robot.sku });
  }
  log.info(`Retrieved local credentials for ${credentials.length} robot(s) from the iRobot cloud`);
  return credentials;
}
