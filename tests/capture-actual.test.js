import { describe, it, expect } from 'vitest';
import { captureAmountFor } from '../src/lib/pricing.js';

// Order: prints 99.38 (85.28 + 14.10) + shipping 50.00 = total 149.38 (tax 0 for the test).
const order = {
  total: 149.38,
  shippingCost: 50,
  items: [{ id: 1, line_total: 85.28 }, { id: 2, line_total: 14.10 }],
};

describe('captureAmountFor', () => {
  it('full approval with no adjustment captures the full authorized total', () => {
    expect(captureAmountFor(order, {})).toEqual({ amount: 149.38, partial: false, adjustedShipping: null });
  });

  it('lowers the capture by the shipping reduction (Julie enters the real international postage)', () => {
    const r = captureAmountFor(order, { actualShipping: 32 });
    expect(r.amount).toBe(131.38);        // 149.38 - (50 - 32)
    expect(r.adjustedShipping).toBe(32);
    expect(r.partial).toBe(false);
  });

  it('is down-only: an actualShipping above the quote is clamped to the quote (never charges more)', () => {
    const r = captureAmountFor(order, { actualShipping: 999 });
    expect(r.amount).toBe(149.38);
    expect(r.adjustedShipping).toBe(50);
  });

  it('clamps a negative actualShipping to zero', () => {
    const r = captureAmountFor(order, { actualShipping: -5 });
    expect(r.amount).toBe(99.38);         // 149.38 - 50
    expect(r.adjustedShipping).toBe(0);
  });

  it('setting actual shipping to exactly the quote is a no-op', () => {
    expect(captureAmountFor(order, { actualShipping: 50 })).toEqual({ amount: 149.38, partial: false, adjustedShipping: 50 });
  });

  it('partial approval captures only the selected line totals and ignores any shipping adjustment', () => {
    expect(captureAmountFor(order, { itemIds: [1], actualShipping: 10 }))
      .toEqual({ amount: 85.28, partial: true, adjustedShipping: null });
  });

  it('selecting every item is a full approval, not a partial', () => {
    const r = captureAmountFor(order, { itemIds: [1, 2] });
    expect(r.partial).toBe(false);
    expect(r.amount).toBe(149.38);
  });

  it('never captures above the authorized total for any shipping input', () => {
    for (const s of [0, 10, 25, 49.99, 50, 60, 1000]) {
      expect(captureAmountFor(order, { actualShipping: s }).amount).toBeLessThanOrEqual(order.total + 1e-9);
    }
  });

  it('rounds to cents (no floating-point tails)', () => {
    const o = { total: 100, shippingCost: 33.33, items: [{ id: 1, line_total: 66.67 }] };
    const r = captureAmountFor(o, { actualShipping: 11.11 });
    expect(r.amount).toBe(77.78);         // 100 - (33.33 - 11.11)
  });
});
