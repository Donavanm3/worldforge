import { describe, expect, it } from 'vitest';
import { ValidationError } from '@wf/shared';
import { assertViewport } from './service.js';

const valid = { west: -0.2, south: 51.4, east: 0.1, north: 51.6 };

describe('assertViewport', () => {
  it('accepts a normal viewport', () => {
    expect(() => assertViewport(valid)).not.toThrow();
  });

  it('rejects inverted bounds', () => {
    expect(() => assertViewport({ ...valid, south: 52, north: 51 })).toThrow(ValidationError);
    expect(() => assertViewport({ ...valid, west: 1, east: 0 })).toThrow(/inverted/i);
  });

  it('rejects zero-area viewports', () => {
    expect(() => assertViewport({ west: 0, east: 0, south: 0, north: 1 })).toThrow(ValidationError);
  });

  it('rejects coordinates outside WGS84 bounds', () => {
    expect(() => assertViewport({ ...valid, north: 91 })).toThrow(/bounds/i);
    expect(() => assertViewport({ ...valid, south: -91 })).toThrow(/bounds/i);
    expect(() => assertViewport({ ...valid, west: -181 })).toThrow(/bounds/i);
    expect(() => assertViewport({ ...valid, east: 181 })).toThrow(/bounds/i);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => assertViewport({ ...valid, west: Number.NaN })).toThrow(ValidationError);
    expect(() => assertViewport({ ...valid, east: Number.POSITIVE_INFINITY })).toThrow(
      ValidationError,
    );
  });

  it('refuses a viewport large enough to scrape the whole world', () => {
    // Without this cap a client could request every parcel on Earth at once.
    expect(() => assertViewport({ west: -180, east: 180, south: -90, north: 90 })).toThrow(
      /too large/i,
    );
  });

  it('accepts a viewport just under the area cap', () => {
    expect(() => assertViewport({ west: 0, east: 1.9, south: 0, north: 1.9 })).not.toThrow();
  });
});
