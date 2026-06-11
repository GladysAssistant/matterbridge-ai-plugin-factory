import { describe, expect, it } from '@jest/globals';

import initializePlugin, { LutronPlatform } from '../src/module.js';

describe('Lutron plugin entry point', () => {
  it('exports a default initializer function', () => {
    expect(typeof initializePlugin).toBe('function');
  });

  it('exports the LutronPlatform class', () => {
    expect(typeof LutronPlatform).toBe('function');
  });
});
