/**
 * Basic platform tests for matterbridge-ai-factory-melcloud-home-classic.
 */

import path from 'node:path';

import { jest } from '@jest/globals';
import type { PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';

import { MelcloudPlatform, type MelcloudPlatformConfig } from '../src/module.js';

const mockMatterbridge = {
  matterbridgeVersion: '3.8.0',
  aggregatorVendorId: VendorId(0xfff1),
  rootDirectory: path.join('.cache', 'jest'),
  homeDirectory: path.join('.cache', 'jest'),
  matterbridgeDirectory: path.join('.cache', 'jest', '.matterbridge'),
  matterbridgePluginDirectory: path.join('.cache', 'jest', 'plugins'),
  bridgeMode: 'bridge',
} as unknown as PlatformMatterbridge;

const mockLog = {
  fatal: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  notice: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
} as unknown as AnsiLogger;

const mockConfig: MelcloudPlatformConfig = {
  name: 'matterbridge-ai-factory-melcloud-home-classic',
  type: 'DynamicPlatform',
  version: '1.0.0',
  application: 'classic',
  whiteList: [],
  blackList: [],
  debug: false,
  unregisterOnShutdown: false,
};

jest.spyOn(AnsiLogger.prototype, 'log').mockImplementation(() => {});

describe('MELCloud platform', () => {
  it('throws on an unsupported Matterbridge version', () => {
    expect(() => new MelcloudPlatform({ ...mockMatterbridge, matterbridgeVersion: '2.0.0' }, mockLog, mockConfig)).toThrow(
      /requires Matterbridge version/u,
    );
  });

  it('creates an instance', () => {
    const instance = new MelcloudPlatform(mockMatterbridge, mockLog, mockConfig);
    expect(instance).toBeInstanceOf(MelcloudPlatform);
  });
});
