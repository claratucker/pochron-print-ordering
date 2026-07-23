// A mistyped address is silent and expensive: no confirmation, no hold message,
// and order lookup is email-guarded, so the customer can't even check status.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';
import { suggestEmailFix } from '../src/lib/emailcheck.js';

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

describe('typo detection (unit)', () => {
  it.each([
    ['clara@gmial.com', 'clara@gmail.com'],
    ['clara@gmal.com', 'clara@gmail.com'],
    ['clara@gmai.com', 'clara@gmail.com'],
    ['clara@gmail.co', 'clara@gmail.com'],
    ['clara@gmail.con', 'clara@gmail.com'],
    ['clara@yahooo.com', 'clara@yahoo.com'],
    ['clara@hotmial.com', 'clara@hotmail.com'],
    ['clara@iclould.com', 'clara@icloud.com'],
    ['clara@outlok.com', 'clara@outlook.com'],
  ])('catches %s', (typo, expected) => {
    expect(suggestEmailFix(typo)).toBe(expected);
  });

  // False positives are worse than misses here: Pochron's customers are
  // photographers using their own domains, and nagging them is unacceptable.
  it.each([
    'clara@gmail.com',
    'ana@ana-ruiz-photography.com',
    'julie@pochronstudios.com',
    'someone@protonmail.com',
    'a@icloud.com',
  ])('leaves %s alone', (good) => {
    expect(suggestEmailFix(good)).toBeNull();
  });
});

describe('typo detection (checkout)', () => {
  it('stops checkout with a suggestion, and lets the customer override', async () => {
    const f = await app.uploadImage('em.png', 3000, 2400);
    const typo = await app.api('/api/orders', { method: 'POST',
      body: app.orderBody(f.fileId, { contact: { name: 'C', email: 'clara@gmial.com' } }) });
    expect(typo.status).toBe(422);
    expect(typo.json.code).toBe('EMAIL_TYPO_SUSPECTED');
    expect(typo.json.suggestion).toBe('clara@gmail.com');

    const confirmed = await app.api('/api/orders', { method: 'POST',
      body: app.orderBody(f.fileId, { contact: { name: 'C', email: 'clara@gmial.com' }, emailConfirmed: true }) });
    expect(confirmed.status).toBe(201);
  });

  it('a correct address passes with no extra friction', async () => {
    app.resetCookie();
    const f = await app.uploadImage('em2.png', 3000, 2400);
    const res = await app.api('/api/orders', { method: 'POST',
      body: app.orderBody(f.fileId, { contact: { name: 'C', email: 'clara@gmail.com' } }) });
    expect(res.status).toBe(201);
  });
});
