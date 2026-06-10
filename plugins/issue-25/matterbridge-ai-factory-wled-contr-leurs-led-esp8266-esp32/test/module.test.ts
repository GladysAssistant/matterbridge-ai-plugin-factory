// Warning: the tests in this unit are supposed to run sequentially.

import path from 'node:path';

import { jest } from '@jest/globals';
import { MatterbridgeEndpoint, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';

import { WledPlatform, WledPlatformConfig } from '../src/module.js';

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
    heapTotal: '0 B',
    heapUsed: '0 B',
  },
  uuid: '00000000-0000-0000-0000-000000000000',
  rootDirectory: path.join('.cache', 'jest', 'WledPlugin'),
  homeDirectory: path.join('.cache', 'jest', 'WledPlugin'),
  matterbridgeDirectory: path.join('.cache', 'jest', 'WledPlugin', '.matterbridge'),
  matterbridgePluginDirectory: path.join('.cache', 'jest', 'WledPlugin', 'Matterbridge'),
  matterbridgeCertDirectory: path.join('.cache', 'jest', 'WledPlugin', '.mattercert'),
  globalModulesDirectory: path.join('.cache', 'jest', 'WledPlugin', 'node_modules'),
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

const mockConfig: WledPlatformConfig = {
  name: 'matterbridge-ai-factory-wled-contr-leurs-led-esp8266-esp32',
  type: 'DynamicPlatform',
  version: '1.0.0',
  whiteList: [],
  blackList: [],
  controllers: [{ host: '192.168.1.50', name: 'Test WLED' }],
  pollInterval: 30,
  debug: false,
  unregisterOnShutdown: false,
};

// Mocked methods
const addBridgedEndpoint = jest.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {});
const removeBridgedEndpoint = jest.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {});
const removeAllBridgedEndpoints = jest.fn(async (pluginName: string) => {});
const registerVirtualDevice = jest.fn(async (name: string, type: 'light' | 'outlet' | 'switch' | 'mounted_switch', callback: () => Promise<void>) => {});

const wledJson = {
  state: { on: true, bri: 128, seg: [{ id: 0, col: [[255, 0, 0]], cct: 0 }] },
  info: { ver: '0.14.0', uptime: 1000, name: 'WLED Strip', mac: 'aabbccddeeff', wifi: { rssi: -60 }, leds: { count: 30 } },
};

let lastPost: any = null;
const mockFetch = jest.fn(async (url: any, init?: any) => {
  if (init?.body) lastPost = JSON.parse(init.body as string);
  return { ok: true, status: 200, statusText: 'OK', json: async () => wledJson } as any;
});
(globalThis as any).fetch = mockFetch;

const loggerLogSpy = jest.spyOn(AnsiLogger.prototype, 'log').mockImplementation((level: string, message: string, ...parameters: any[]) => {});

describe('Matterbridge WLED Plugin', () => {
  let instance: WledPlatform;

  beforeEach(() => {
    jest.clearAllMocks();
    lastPost = null;
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('should throw an error if matterbridge is not the required version', () => {
    expect(() => new WledPlatform({ ...mockMatterbridge, matterbridgeVersion: '2.0.0' }, mockLog, mockConfig)).toThrow(
      'This plugin requires Matterbridge version >= "3.6.0". Please update Matterbridge from 2.0.0 to the latest version in the frontend.',
    );
  });

  it('should create an instance of the platform', async () => {
    instance = (await import('../src/module.js')).default(mockMatterbridge, mockLog, mockConfig) as WledPlatform;
    expect(instance).toBeInstanceOf(WledPlatform);
    // @ts-expect-error Accessing private method for testing purposes
    instance.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, registerVirtualDevice);
    expect(mockLog.info).toHaveBeenCalledWith('Initializing WLED Platform...');
  });

  it('should start and register the WLED device', async () => {
    await instance.onStart('Jest');
    expect(mockLog.info).toHaveBeenCalledWith('onStart called with reason: Jest');
    expect(addBridgedEndpoint).toHaveBeenCalledTimes(1);
    expect(instance.getDevices().length).toBe(1);
  });

  it('should send WLED state on on/off command', async () => {
    const device = instance.getDevices()[0];
    await device.executeCommandHandler('on', {}, 'onOff', {} as any, device);
    expect(lastPost).toEqual({ on: true });
    await device.executeCommandHandler('off', {}, 'onOff', {} as any, device);
    expect(lastPost).toEqual({ on: false });
  });

  it('should send WLED brightness on moveToLevel', async () => {
    const device = instance.getDevices()[0];
    await device.executeCommandHandler('moveToLevel', { level: 254 }, 'levelControl', {} as any, device);
    expect(lastPost).toEqual({ bri: 255 });
  });

  it('should send WLED rgb on moveToHueAndSaturation', async () => {
    const device = instance.getDevices()[0];
    await device.executeCommandHandler('moveToHueAndSaturation', { hue: 0, saturation: 254 }, 'colorControl', {} as any, device);
    expect(lastPost.seg[0].col[0][0]).toBe(255);
  });

  it('should send WLED cct on moveToColorTemperature', async () => {
    const device = instance.getDevices()[0];
    await device.executeCommandHandler('moveToColorTemperature', { colorTemperatureMireds: 370 }, 'colorControl', {} as any, device);
    expect(typeof lastPost.seg[0].cct).toBe('number');
  });

  it('should configure and poll', async () => {
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
    expect(removeAllBridgedEndpoints).toHaveBeenCalled();
    mockConfig.unregisterOnShutdown = false;
  });
});
