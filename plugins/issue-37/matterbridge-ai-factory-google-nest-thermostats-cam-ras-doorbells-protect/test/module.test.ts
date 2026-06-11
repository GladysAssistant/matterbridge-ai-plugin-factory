// Warning: the tests in this unit are supposed to run sequentially.

import path from 'node:path';

import { jest } from '@jest/globals';
import { MatterbridgeEndpoint, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';

import { NestPlatform, NestPlatformConfig } from '../src/module.js';

const mockMatterbridge: PlatformMatterbridge = {
  systemInformation: {
    interfaceName: 'eth0',
    macAddress: 'aa:bb:cc:dd:ee:ff',
    ipv4Address: '192.168.1.1',
    ipv6Address: 'fd78:cbf8:4939:746:a96:8277:346f:416e',
    osRelease: 'x.y.z',
    nodeVersion: '22.10.0',
    hostname: 'matterbridge',
    user: 'jest',
    osType: 'Linux',
    osPlatform: 'linux',
    osArch: 'x64',
    totalMemory: '0 B',
    freeMemory: '0 B',
    systemUptime: '0s',
    processUptime: '0s',
    cpuUsage: '0%',
    processCpuUsage: '0%',
    rss: '0 B',
    heapUsed: '0 B',
    heapTotal: '0 B',
  },
  uuid: '00000000-0000-0000-0000-000000000000',
  rootDirectory: path.join('.cache', 'jest', 'NestPlugin'),
  homeDirectory: path.join('.cache', 'jest', 'NestPlugin'),
  matterbridgeDirectory: path.join('.cache', 'jest', 'NestPlugin', '.matterbridge'),
  matterbridgePluginDirectory: path.join('.cache', 'jest', 'NestPlugin', 'Matterbridge'),
  matterbridgeCertDirectory: path.join('.cache', 'jest', 'NestPlugin', '.mattercert'),
  globalModulesDirectory: path.join('.cache', 'jest', 'NestPlugin', 'node_modules'),
  matterbridgeVersion: '3.8.0',
  matterbridgeLatestVersion: '3.8.0',
  matterbridgeDevVersion: '3.8.0',
  frontendVersion: '3.8.1',
  bridgeMode: 'bridge',
  restartMode: '',
  virtualMode: 'mounted_switch',
  aggregatorVendorId: VendorId(0xfff1),
  aggregatorVendorName: 'Matterbridge',
  aggregatorProductId: 0x8000,
  aggregatorProductName: 'Matterbridge Jest Aggregator',
};

const mockLog = {
  fatal: jest.fn((message: string, ...parameters: any[]) => {}),
  error: jest.fn((message: string, ...parameters: any[]) => {}),
  warn: jest.fn((message: string, ...parameters: any[]) => {}),
  notice: jest.fn((message: string, ...parameters: any[]) => {}),
  info: jest.fn((message: string, ...parameters: any[]) => {}),
  debug: jest.fn((message: string, ...parameters: any[]) => {}),
} as unknown as AnsiLogger;

const mockConfig: NestPlatformConfig = {
  name: 'matterbridge-ai-factory-google-nest-thermostats-cam-ras-doorbells-protect',
  type: 'DynamicPlatform',
  version: '1.0.0',
  whiteList: [],
  blackList: [],
  debug: false,
  unregisterOnShutdown: false,
};

const addBridgedEndpoint = jest.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {});
const removeBridgedEndpoint = jest.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {});
const removeAllBridgedEndpoints = jest.fn(async (pluginName: string) => {});
const registerVirtualDevice = jest.fn(async (name: string, type: 'light' | 'outlet' | 'switch' | 'mounted_switch', callback: () => Promise<void>) => {});

const loggerLogSpy = jest.spyOn(AnsiLogger.prototype, 'log').mockImplementation((level: string, message: string, ...parameters: any[]) => {});

describe('Matterbridge Google Nest Plugin', () => {
  let instance: NestPlatform;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('should throw an error if matterbridge is not the required version', async () => {
    expect(() => new NestPlatform({ ...mockMatterbridge, matterbridgeVersion: '2.0.0' }, mockLog, mockConfig)).toThrow(
      'This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from 2.0.0 to the latest version in the frontend.',
    );
  });

  it('should create an instance of the platform', async () => {
    instance = (await import('../src/module.js')).default(mockMatterbridge, mockLog, mockConfig) as NestPlatform;
    expect(instance).toBeInstanceOf(NestPlatform);
    // @ts-expect-error Accessing private method for testing purposes
    instance.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, registerVirtualDevice);
    expect(instance.matterbridge).toBe(mockMatterbridge);
    expect(instance.log).toBe(mockLog);
    expect(instance.config).toBe(mockConfig);
    expect(mockLog.info).toHaveBeenCalledWith('Initializing Google Nest Platform...');
  });

  it('should warn and register no devices when unconfigured', async () => {
    await instance.onStart('Jest');
    expect(mockLog.info).toHaveBeenCalledWith('onStart called with reason: Jest');
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('not configured'));
    expect(addBridgedEndpoint).not.toHaveBeenCalled();
  });

  it('should configure', async () => {
    await instance.onConfigure();
    expect(mockLog.info).toHaveBeenCalledWith('onConfigure called');
  });

  it('should change logger level', async () => {
    await instance.onChangeLoggerLevel(LogLevel.DEBUG);
    expect(mockLog.info).toHaveBeenCalledWith('onChangeLoggerLevel called with: debug');
  });

  it('should shutdown', async () => {
    await instance.onShutdown('Jest');
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown called with reason: Jest');
    expect(removeAllBridgedEndpoints).not.toHaveBeenCalled();

    mockConfig.unregisterOnShutdown = true;
    await instance.onShutdown();
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown called with reason: none');
    expect(removeAllBridgedEndpoints).toHaveBeenCalled();
    mockConfig.unregisterOnShutdown = false;
  });
});
