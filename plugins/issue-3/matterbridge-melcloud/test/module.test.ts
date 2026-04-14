import path from 'node:path';

import { jest } from '@jest/globals';
import { MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';

import { MelCloudPlatform } from '../src/module.js';
import { MelCloudDeviceState } from '../src/melcloudApi.js';

const mockDeviceState: MelCloudDeviceState = {
  Power: true,
  OperationMode: 1, // Heat
  SetTemperature: 21,
  RoomTemperature: 20,
  MinTempCoolDry: 16,
  MaxTempCoolDry: 31,
  MinTempHeat: 10,
  MaxTempHeat: 31,
  MinTempAutomatic: 10,
  MaxTempAutomatic: 31,
  DeviceType: 0,
};

const mockApi = {
  login: jest.fn(async () => {}),
  listDevices: jest.fn(async () => [
    {
      DeviceID: 12345,
      DeviceName: 'Living Room AC',
      BuildingID: 1,
      Device: mockDeviceState,
    },
  ]),
  getDeviceState: jest.fn(async () => mockDeviceState),
  setDeviceState: jest.fn(async () => {}),
};

const mockLog = {
  fatal: jest.fn((message: string, ...parameters: any[]) => {}),
  error: jest.fn((message: string, ...parameters: any[]) => {}),
  warn: jest.fn((message: string, ...parameters: any[]) => {}),
  notice: jest.fn((message: string, ...parameters: any[]) => {}),
  info: jest.fn((message: string, ...parameters: any[]) => {}),
  debug: jest.fn((message: string, ...parameters: any[]) => {}),
} as unknown as AnsiLogger;

const mockMatterbridge: PlatformMatterbridge = {
  systemInformation: {
    ipv4Address: '192.168.1.1',
    ipv6Address: 'fd78:cbf8:4939:746:a96:8277:346f:416e',
    osRelease: 'x.y.z',
    nodeVersion: '22.10.0',
  },
  rootDirectory: path.join('.cache', 'jest', 'MelCloudPlugin'),
  homeDirectory: path.join('.cache', 'jest', 'MelCloudPlugin'),
  matterbridgeDirectory: path.join('.cache', 'jest', 'MelCloudPlugin', '.matterbridge'),
  matterbridgePluginDirectory: path.join('.cache', 'jest', 'MelCloudPlugin', 'Matterbridge'),
  matterbridgeCertDirectory: path.join('.cache', 'jest', 'MelCloudPlugin', '.mattercert'),
  globalModulesDirectory: path.join('.cache', 'jest', 'MelCloudPlugin', 'node_modules'),
  matterbridgeVersion: '3.5.0',
  matterbridgeLatestVersion: '3.5.0',
  matterbridgeDevVersion: '3.5.0',
  bridgeMode: 'bridge',
  restartMode: '',
  aggregatorVendorId: VendorId(0xfff1),
  aggregatorVendorName: 'Matterbridge',
  aggregatorProductId: 0x8000,
  aggregatorProductName: 'Matterbridge aggregator',
  registerVirtualDevice: jest.fn(async (name: string, type: 'light' | 'outlet' | 'switch' | 'mounted_switch', callback: () => Promise<void>) => {}),
  addBridgedEndpoint: jest.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {}),
  removeBridgedEndpoint: jest.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {}),
  removeAllBridgedEndpoints: jest.fn(async (pluginName: string) => {}),
} as unknown as PlatformMatterbridge;

const mockConfig: PlatformConfig = {
  name: 'matterbridge-melcloud',
  type: 'DynamicPlatform',
  version: '1.0.0',
  email: 'test@example.com',
  password: 'testpassword',
  pollingInterval: 60000,
  whiteList: [],
  blackList: [],
  debug: false,
  unregisterOnShutdown: false,
};

const loggerLogSpy = jest.spyOn(AnsiLogger.prototype, 'log').mockImplementation((level: string, message: string, ...parameters: any[]) => {});

describe('MelCloudPlatform', () => {
  let instance: MelCloudPlatform;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('should create an instance of the platform', async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    instance = (await import('../src/module.ts')).default(mockMatterbridge, mockLog, mockConfig) as unknown as MelCloudPlatform;
    // Inject mock API before any calls
    // @ts-expect-error accessing private for testing
    instance.api = mockApi;
    // @ts-expect-error Accessing private method for testing purposes
    instance.setMatterNode(
      // @ts-expect-error
      mockMatterbridge.addBridgedEndpoint,
      // @ts-expect-error
      mockMatterbridge.removeBridgedEndpoint,
      // @ts-expect-error
      mockMatterbridge.removeAllBridgedEndpoints,
      // @ts-expect-error
      mockMatterbridge.registerVirtualDevice,
    );
    expect(instance).toBeInstanceOf(MelCloudPlatform);
    expect(instance.matterbridge).toBe(mockMatterbridge);
    expect(instance.log).toBe(mockLog);
    expect(instance.config).toBe(mockConfig);
  });

  it('should error when email/password are missing', async () => {
    const noCredConfig = { ...mockConfig, email: undefined, password: undefined };
    // @ts-ignore
    const noCredInstance = (await import('../src/module.ts')).default(mockMatterbridge, mockLog, noCredConfig) as unknown as MelCloudPlatform;
    // @ts-expect-error accessing private for testing
    noCredInstance.api = mockApi;
    // @ts-expect-error
    noCredInstance.setMatterNode(
      // @ts-expect-error
      mockMatterbridge.addBridgedEndpoint,
      // @ts-expect-error
      mockMatterbridge.removeBridgedEndpoint,
      // @ts-expect-error
      mockMatterbridge.removeAllBridgedEndpoints,
      // @ts-expect-error
      mockMatterbridge.registerVirtualDevice,
    );
    await noCredInstance.onStart('test');
    expect(mockLog.error).toHaveBeenCalledWith('MELCloud email and password must be configured');
  });

  it('should start and discover devices', async () => {
    await instance.onStart('Jest');
    expect(mockLog.info).toHaveBeenCalledWith('onStart: Jest');
    expect(mockApi.login).toHaveBeenCalled();
    expect(mockApi.listDevices).toHaveBeenCalled();
  });

  it('should start without reason', async () => {
    await instance.onStart();
    expect(mockLog.info).toHaveBeenCalledWith('onStart: none');
  });

  it('should call on/off command handlers', async () => {
    for (const device of instance.getDevices()) {
      if (device.hasClusterServer('onOff')) {
        await device.executeCommandHandler('on', {}, 'onOff', {} as any, device);
        await device.executeCommandHandler('off', {}, 'onOff', {} as any, device);
      }
    }
    expect(mockApi.getDeviceState).toHaveBeenCalled();
    expect(mockApi.setDeviceState).toHaveBeenCalled();
  });

  it('should configure', async () => {
    await instance.onConfigure();
    expect(mockLog.info).toHaveBeenCalledWith('onConfigure called');
  });

  it('should shutdown', async () => {
    await instance.onShutdown('Jest');
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown: Jest');
  });

  it('should shutdown and unregister devices', async () => {
    mockConfig.unregisterOnShutdown = true;
    await instance.onShutdown();
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown: none');
    // @ts-expect-error
    expect(mockMatterbridge.removeAllBridgedEndpoints).toHaveBeenCalled();
    mockConfig.unregisterOnShutdown = false;
  });
});
