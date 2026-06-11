import initializePlugin, { ReolinkPlatform, ReolinkPlatformConfig } from '../src/module.js';

describe('ReolinkPlatform', () => {
  it('should export an initializePlugin function', () => {
    expect(typeof initializePlugin).toBe('function');
  });

  it('should export the ReolinkPlatform class', () => {
    expect(typeof ReolinkPlatform).toBe('function');
  });

  it('should accept a typed config shape when given host and username', () => {
    const cfg: Partial<ReolinkPlatformConfig> = { host: '192.168.1.100', username: 'admin' };
    expect(cfg.host).toBe('192.168.1.100');
    expect(cfg.username).toBe('admin');
  });
});
