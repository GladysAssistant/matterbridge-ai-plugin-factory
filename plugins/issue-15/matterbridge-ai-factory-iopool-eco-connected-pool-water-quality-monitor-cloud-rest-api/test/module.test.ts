import path from 'node:path';

import { jest } from '@jest/globals';
import { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';

import initializePlugin, { IopoolPlatform } from '../src/module.js';

const mockLog = {
  fatal: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  notice: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
} as unknown as AnsiLogger;

const mockMatterbridge: PlatformMatterbridge = {
  systemInformation: { ipv4Address: '192.168.1.1', ipv6Address: '::1', osRelease: 'x', nodeVersion: '22.10.0' },
  rootDirectory: path.join('.cache', 'jest'),
  homeDirectory: path.join('.cache', 'jest'),
  matterbridgeDirectory: path.join('.cache', 'jest', '.matterbridge'),
  matterbridgePluginDirectory: path.join('.cache', 'jest', 'Matterbridge'),
  matterbridgeCertDirectory: path.join('.cache', 'jest', '.mattercert'),
  globalModulesDirectory: path.join('.cache', 'jest', 'node_modules'),
  matterbridgeVersion: '3.7.3',
  matterbridgeLatestVersion: '3.7.3',
  matterbridgeDevVersion: '3.7.3',
  bridgeMode: 'bridge',
  restartMode: '',
  aggregatorVendorId: VendorId(0xfff1),
  aggregatorVendorName: 'Matterbridge',
  aggregatorProductId: 0x8000,
  aggregatorProductName: 'Matterbridge aggregator',
} as unknown as PlatformMatterbridge;

const mockConfig: PlatformConfig = {
  name: 'matterbridge-ai-factory-iopool-eco-connected-pool-water-quality-monitor-cloud-rest-api',
  type: 'DynamicPlatform',
  apiKey: 'test-key',
  pollingIntervalSeconds: 300,
  poolIds: [],
};

describe('IopoolPlatform', () => {
  it('should return an IopoolPlatform instance when initialized via the entry point', () => {
    const platform = initializePlugin(mockMatterbridge, mockLog, mockConfig);
    expect(platform).toBeInstanceOf(IopoolPlatform);
  });
});
