import { describe, it, expect } from 'vitest';
import { shippingForZone } from '../src/lib/pricing.js';

const cat = {
  shipping: [{ id: 'standard', label: 'Standard', cost: 12 }, { id: 'expedited', label: 'Expedited', cost: 28 }],
  shipZones: [
    { key: 'ne', label: 'Northeast', standard: 15, expedited: 26 },
    { key: 'se', label: 'Southeast', standard: 21, expedited: 34 },
    { key: 'pm', label: 'Plains', standard: 32, expedited: 48 },
    { key: 'wc', label: 'West Coast', standard: 42, expedited: 60 },
    { key: 'akhi', label: 'AK/HI', standard: 60, expedited: 85 },
    { key: 'camx', label: 'Canada & Mexico', standard: 35, expedited: null },
    { key: 'eu', label: 'Europe & UK', standard: 50, expedited: null },
  ],
  freeShipOver: 0,
};
const cost = (state, zip, country = 'US', method = 'standard') => {
  const r = shippingForZone(cat, { state, zip, country }, method, 0);
  return r.gate ? 'GATE' : r.cost;
};

describe('shippingForZone — US region resolution', () => {
  it('resolves a valid state (name or code) to its zone', () => {
    expect(cost('California', '')).toBe(42);
    expect(cost('CA', '')).toBe(42);
    expect(cost('New York', '')).toBe(15);
  });

  it('falls back to ZIP when the state is unrecognized', () => {
    expect(cost('Calif', '90210')).toBe(42);   // CA -> wc
    expect(cost('Nwyrk', '10001')).toBe(15);    // NY -> ne
    expect(cost('xxx', '33101')).toBe(21);      // FL -> se
    expect(cost('xxx', '78701')).toBe(32);      // TX -> pm
    expect(cost('xxx', '99501')).toBe(60);      // AK -> akhi
  });

  it('uses the state, not the ZIP, when both are present (state is primary)', () => {
    expect(cost('California', '10001')).toBe(42);   // CA state wins over NY zip
  });

  it('NEVER defaults to a middle tier — an unresolvable US address gates', () => {
    expect(cost('xxx', '00000')).toBe('GATE');
    expect(cost('xxx', '42800')).toBe('GATE');      // ZIP falls in an unused gap
    expect(cost('xxx', '')).toBe('GATE');           // garbage state, no ZIP
    expect(cost('', '')).toBe('GATE');              // nothing at all
  });

  it('requires at least 3 ZIP digits before matching (no premature match while typing)', () => {
    expect(cost('', '9')).toBe('GATE');
    expect(cost('', '90')).toBe('GATE');
    expect(cost('', '902')).toBe(42);               // 902 -> CA
  });
});

describe('shippingForZone — international', () => {
  it('maps known countries to their intl zone', () => {
    expect(cost('', '', 'Canada')).toBe(35);
    expect(cost('', '', 'Mexico')).toBe(35);
    expect(cost('', '', 'Germany')).toBe(50);
    expect(cost('', '', 'United Kingdom')).toBe(50);
  });

  it('gates unmapped countries', () => {
    expect(cost('', '', 'Australia')).toBe('GATE');
    expect(cost('', '', 'Japan')).toBe('GATE');
    expect(cost('', '', 'Brazil')).toBe('GATE');
  });
});
