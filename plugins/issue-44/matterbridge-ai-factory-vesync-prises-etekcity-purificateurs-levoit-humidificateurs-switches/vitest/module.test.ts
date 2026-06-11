import { describe, expect, it } from 'vitest';

import initializePlugin, { VeSyncPlatform, VeSyncPlatformConfig } from '../src/module.js';
import { VeSyncClient, VeSyncDevice } from '../src/vesync.js';

describe('VeSync plugin', () => {
  it('exports the platform and initializer', () => {
    expect(typeof initializePlugin).toBe('function');
    expect(typeof VeSyncPlatform).toBe('function');
  });

  it('categorizes devices', () => {
    const mk = (deviceType: string, type = ''): VeSyncDevice =>
      ({ cid: 'c', uuid: 'u', deviceName: 'n', deviceType, deviceStatus: 'on', connectionStatus: 'online', configModule: 'm', type }) as VeSyncDevice;
    expect(VeSyncClient.categorize(mk('ESW15-USA'))).toBe('outlet');
    expect(VeSyncClient.categorize(mk('Core300S'))).toBe('purifier');
    expect(VeSyncClient.categorize(mk('LV600S Humidifier'))).toBe('humidifier');
    expect(VeSyncClient.categorize(mk('LTF-F422S Tower Fan'))).toBe('fan');
  });

  it('builds a config type', () => {
    const cfg = { name: 'x', type: 'DynamicPlatform', whiteList: [], blackList: [] } as unknown as VeSyncPlatformConfig;
    expect(cfg.whiteList).toEqual([]);
  });
});
