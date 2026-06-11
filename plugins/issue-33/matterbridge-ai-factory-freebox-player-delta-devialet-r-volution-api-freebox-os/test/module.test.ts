import { jest } from '@jest/globals';

import initializePlugin, { FreeboxPlatform } from '../src/module.js';

describe('FreeboxPlatform', () => {
  const matterbridge = {
    matterbridgeVersion: '3.8.0',
    aggregatorVendorId: 0xfff1,
  } as unknown as Parameters<typeof initializePlugin>[0];
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Parameters<typeof initializePlugin>[1];

  it('returns a FreeboxPlatform instance', () => {
    const config = {
      name: 'matterbridge-ai-factory-freebox-player-delta-devialet-r-volution-api-freebox-os',
      type: 'DynamicPlatform',
      whiteList: [],
      blackList: [],
    } as unknown as Parameters<typeof initializePlugin>[2];
    jest.spyOn(FreeboxPlatform.prototype, 'verifyMatterbridgeVersion').mockReturnValue(true);
    const platform = initializePlugin(matterbridge, log, config);
    expect(platform).toBeInstanceOf(FreeboxPlatform);
  });
});
