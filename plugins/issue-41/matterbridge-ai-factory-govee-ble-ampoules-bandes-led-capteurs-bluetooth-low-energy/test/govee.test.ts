import { describe, expect, it } from '@jest/globals';

import { buildBrightness, buildColor, buildPower, hsvToRgb, miredsToKelvin, parseAdvertisement } from '../src/govee.js';

describe('Govee BLE protocol', () => {
  it('builds 20-byte power frames with xor checksum', () => {
    const on = buildPower(true);
    expect(on.length).toBe(20);
    expect(on[0]).toBe(0x33);
    expect(on[2]).toBe(0x01);
    let xor = 0;
    for (let i = 0; i < 19; i++) xor ^= on[i];
    expect(on[19]).toBe(xor);
  });

  it('scales brightness to 0-100', () => {
    expect(buildBrightness(254)[2]).toBe(100);
    expect(buildBrightness(0)[2]).toBe(0);
  });

  it('encodes rgb color', () => {
    const f = buildColor(10, 20, 30);
    expect([f[3], f[4], f[5]]).toEqual([10, 20, 30]);
  });

  it('converts mireds to kelvin', () => {
    expect(miredsToKelvin(250)).toBe(4000);
  });

  it('converts hsv red', () => {
    expect(hsvToRgb(0, 254, 254)).toEqual([255, 0, 0]);
  });

  it('parses H5179 temperature/humidity', () => {
    const buf = Buffer.from([0x01, 0x00, 0x01, 0x01, 0xdc, 0x08, 0x10, 0x13, 0x64]);
    const r = parseAdvertisement('H5179', buf);
    expect(r.temperature).toBeCloseTo(22.52, 2);
    expect(r.battery).toBe(100);
  });

  it('parses H5121 motion', () => {
    expect(parseAdvertisement('H5121', Buffer.from([0, 0, 0, 1])).motion).toBe(true);
  });
});
