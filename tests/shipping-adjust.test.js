import { describe, it, expect } from 'vitest';
import { captureAmountFor, isShippingAdjustable } from '../src/lib/pricing.js';

const items = [{ id: 1, line_total: 0.79 }];

describe('shipping is only reducible on international orders', () => {
  it('domestic and unknown countries are not adjustable', () => {
    expect(isShippingAdjustable('United States')).toBe(false);
    expect(isShippingAdjustable('US')).toBe(false);
    expect(isShippingAdjustable('')).toBe(false);
    expect(isShippingAdjustable(undefined)).toBe(false);
  });
  it('international countries are adjustable', () => {
    expect(isShippingAdjustable('Canada')).toBe(true);
    expect(isShippingAdjustable('United Kingdom')).toBe(true);
  });
});

describe('a full approval never silently drops shipping', () => {
  it('no actualShipping captures the full authorized total', () => {
    const r = captureAmountFor({ total: 17.19, shippingCost: 15, items }, {});
    expect(r.amount).toBe(17.19);
    expect(r.adjustedShipping).toBe(null);
  });
  it('shipping passed unchanged still captures the full total', () => {
    const r = captureAmountFor({ total: 17.19, shippingCost: 15, items }, { actualShipping: 15 });
    expect(r.amount).toBe(17.19);
  });
});
