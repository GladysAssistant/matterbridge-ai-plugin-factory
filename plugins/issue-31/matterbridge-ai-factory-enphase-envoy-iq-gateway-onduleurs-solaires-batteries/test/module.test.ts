import { jest } from '@jest/globals';
import { PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';

import initializePlugin, { EnphasePlatform, EnphasePlatformConfig } from '../src/module.js';

const mockLog = {
  fatal: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  notice: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
} as unknown as AnsiLogger;

const mockMatterbridge = {
  matterbridgeVersion: '3.8.0',
  aggregatorVendorId: 0xfff1,
  matterbridgeDirectory: '/tmp/matterbridge-test',
  matterbridgePluginDirectory: '/tmp/matterbridge-test/plugins',
  log: mockLog,
  getDevices: jest.fn(() => []),
  getPlugins: jest.fn(() => []),
  addBridgedEndpoint: jest.fn(),
  removeBridgedEndpoint: jest.fn(),
  removeAllBridgedEndpoints: jest.fn(),
} as unknown as PlatformMatterbridge;

const config = {
  name: 'matterbridge-ai-factory-enphase-envoy-iq-gateway-onduleurs-solaires-batteries',
  type: 'DynamicPlatform',
  version: '1.0.0',
} as unknown as EnphasePlatformConfig;

describe('EnphasePlatform', () => {
  it('should expose an initializePlugin factory when imported', () => {
    expect(typeof initializePlugin).toBe('function');
  });

  it('should construct the platform when given a valid matterbridge version', () => {
    const platform = new EnphasePlatform(mockMatterbridge, mockLog, config);
    expect(platform).toBeInstanceOf(EnphasePlatform);
  });
});
