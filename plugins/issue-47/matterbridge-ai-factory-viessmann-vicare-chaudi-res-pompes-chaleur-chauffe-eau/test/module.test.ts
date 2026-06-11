import { describe, expect, it } from '@jest/globals';

import { buildPkceAuthorizeUrl, getBoolean, getNumber, getString, ViCareDevice } from '../src/vicareClient.js';

function makeDevice(): ViCareDevice {
  return {
    installationId: 1,
    gatewaySerial: 'GW',
    deviceId: '0',
    modelId: 'Vitodens',
    deviceType: 'heating',
    features: new Map([
      ['heating.dhw.temperature.main', { feature: '', isEnabled: true, isReady: true, properties: { value: { type: 'number', value: 50 } }, commands: {} }],
      ['heating.circuits.0.operating.modes.active', { feature: '', isEnabled: true, isReady: true, properties: { value: { type: 'string', value: 'heating' } }, commands: {} }],
      ['heating.burners.0', { feature: '', isEnabled: true, isReady: true, properties: { active: { type: 'boolean', value: true } }, commands: {} }],
    ]),
  };
}

describe('vicareClient helpers', () => {
  it('should read numeric, string and boolean properties when present', () => {
    const d = makeDevice();
    expect(getNumber(d, 'heating.dhw.temperature.main')).toBe(50);
    expect(getString(d, 'heating.circuits.0.operating.modes.active')).toBe('heating');
    expect(getBoolean(d, 'heating.burners.0', 'active')).toBe(true);
    expect(getNumber(d, 'missing.feature')).toBeUndefined();
  });

  it('should build a PKCE authorize url with S256 challenge when given a client id', () => {
    const { authorizeUrl, codeVerifier, codeChallenge } = buildPkceAuthorizeUrl('client-id');
    expect(codeVerifier).toBeTruthy();
    expect(codeChallenge).toBeTruthy();
    expect(authorizeUrl).toContain('code_challenge_method=S256');
    expect(authorizeUrl).toContain('client_id=client-id');
  });
});
