import { describe, expect, it } from '@jest/globals';

import initializePlugin, { OverkizPlatform } from '../src/module.js';

describe('OverkizPlatform', () => {
  it('exports a default initialize function', () => {
    expect(typeof initializePlugin).toBe('function');
  });

  it('exports the platform class', () => {
    expect(OverkizPlatform).toBeDefined();
  });
});
