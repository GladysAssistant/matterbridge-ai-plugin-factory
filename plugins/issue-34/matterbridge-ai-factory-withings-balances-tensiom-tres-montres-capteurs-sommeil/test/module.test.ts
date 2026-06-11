/**
 * Basic tests for the Withings platform plugin.
 *
 * @file module.test.ts
 * @license Apache-2.0
 */

import { jest } from '@jest/globals';
import { AnsiLogger } from 'matterbridge/logger';

import initializePlugin, { WithingsPlatform } from '../src/module.js';

describe('WithingsPlatform', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as AnsiLogger;
  const matterbridge = {
    matterbridgeVersion: '3.8.0',
    aggregatorVendorId: 0xfff1,
  } as never;
  const config = {
    name: 'matterbridge-ai-factory-withings-balances-tensiom-tres-montres-capteurs-sommeil',
    type: 'DynamicPlatform',
    whiteList: [],
    blackList: [],
  } as never;

  it('exports an initializePlugin factory returning a WithingsPlatform', () => {
    const verify = jest.spyOn(WithingsPlatform.prototype, 'verifyMatterbridgeVersion').mockReturnValue(true);
    const platform = initializePlugin(matterbridge, log, config);
    expect(platform).toBeInstanceOf(WithingsPlatform);
    verify.mockRestore();
  });
});
