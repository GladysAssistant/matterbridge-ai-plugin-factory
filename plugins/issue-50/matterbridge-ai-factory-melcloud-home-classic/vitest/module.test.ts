/**
 * Basic platform tests (Vitest) for matterbridge-ai-factory-melcloud-home-classic.
 */

import path from 'node:path';

import type { PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';
import { describe, expect, it, vi } from 'vitest';

import { MelcloudPlatform, type MelcloudPlatformConfig } from '../src/module.js';

const mockMatterbridge = {
  matterbridgeVersion: '3.8.0',
  aggregatorVendorId: VendorId(0xfff1),
  rootDirectory: path.join('.cache', 'vitest'),
  homeDirectory: path.join('.cache', 'vitest'),
  matterbridgeDirectory: path.join('.cache', 'vitest', '.matterbridge'),
  matterbridgePluginDirectory: path.join('.cache', 'vitest', 'plugins'),
  bridgeMode: 'bridge',
} as unknown as PlatformMatterbridge;

const mockLog = {
  fatal: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  notice: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
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

vi.spyOn(AnsiLogger.prototype, 'log').mockImplementation(() => {});

describe('MELCloud platform', () => {
  it('throws on an unsupported Matterbridge version', () => {
    expect(() => new MelcloudPlatform({ ...mockMatterbridge, matterbridgeVersion: '2.0.0' }, mockLog, mockConfig)).toThrow(
      /requires Matterbridge version/u,
    );
  });

  it('creates an instance', () => {
    expect(new MelcloudPlatform(mockMatterbridge, mockLog, mockConfig)).toBeInstanceOf(MelcloudPlatform);
  });
});
