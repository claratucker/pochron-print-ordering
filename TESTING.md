# Testing

```bash
npm test           # unit + integration (fast, offline)     — 57 tests
npm run smoke      # full end-to-end, incl. large uploads   — 44 assertions
npm run test:all   # both
npm run test:watch # re-run on save while developing
```

Stripe is separate, because it's the only part that needs network access and a
key. Without one the file is skipped rather than failed, so CI on a fork stays
green:

```bash
PAYMENT_DRIVER=stripe STRIPE_SECRET_KEY=sk_test_... npm run test:stripe
```

## Why the tests are shaped this way

The rule here is that **money and irreversible actions get the most coverage**.
An order that prints when it shouldn't costs materials; an order accepted with
no funds costs a customer relationship. Cosmetic bugs don't.

Tests never read the machine's `.env`. `config.js` calls dotenv, so without
`DOTENV_CONFIG_PATH=/dev/null` in `tests/setup.js` the suite would inherit
whatever happens to be deployed — and a test could pass on a laptop with no
credentials while failing on the server that has them. That actually happened
with the Lightroom connector tests. Everything the tests depend on is set
explicitly in the setup file.

Each test file boots its **own server on its own port with its own throwaway
database** (`tests/helpers/app.js`). That means tests never see each other's
orders, can run in any order, and leave nothing behind. Environment setup lives
in `tests/setup.js` rather than the harness, because `config.js` reads
`process.env` at import time and static imports are hoisted above `beforeAll` —
a subtlety that cost an afternoon before it was written down.

## What's covered

| File | Protects |
|---|---|
| `pricing.test.js` | Prices match the published sheet to the penny; the colour-correction fee is charged once per image, not per copy; volume tiers; 100+ routes to a manual quote; a client-supplied total is ignored |
| `uploads.test.js` | Real pixel dimensions and DPI; low-res detection; type and size rejection; the 12-file limit, and that one visitor's files don't count against another's |
| `orders.test.js` | Required fields; the low-res acknowledgment gate; the white-label sender name; order lookup guarded by email |
| `studio.test.js` | Password protection on every action; approve captures and moves to production; hold records a message and notifies; the studio works from the original file |
| `admin.test.js` | Julie can change prices, fees, shipping and tiers; changes take effect immediately and are what the customer is actually charged; nobody unauthenticated can edit |
| `email-validation.test.js` | Typo detection catches the common domain misses **and leaves real business domains alone** — false positives matter more here than misses, because the customers are photographers on their own domains |
| `payments-stripe.test.js` | Submit *holds* funds; only approval *captures*; declines create no order; an order with no card is refused |
| `regressions.test.js` | Every bug that actually reached a running system |

## The regression file

`regressions.test.js` is the most valuable file here, and each test names the
bug it prevents:

- **Malformed studio input crashed the whole server.** An empty hold message
  threw an unhandled validation error and killed the process. pm2 restarted it,
  so the site looked healthy while the action silently did nothing — it was only
  visible as a restart counter ticking up.
- **A password containing `#` was silently truncated**, because dotenv treats
  the rest of an unquoted value as a comment. The fix is config, not code, so
  the test asserts that auth is exact-match.
- **A new column wasn't added to the queue's SELECT**, so the white-label
  business name came back undefined and parcels fell back to a generic sender.
- **A new column was added to an INSERT without a matching placeholder**,
  producing "23 values for 24 columns" at runtime.
- **The ordering page wasn't actually wired to the backend** — orders went into
  an in-page array, so nothing reached the studio queue.
- **Image metadata came back null for larger files** because the write hadn't
  flushed before it was read back.

And in `payments-stripe.test.js`, the one that prompted this suite:

- **An order was accepted with no card attached.** The card field failed to
  load, the browser submitted anyway, the server created an unconfirmed
  PaymentIntent and accepted the order — showing the customer a confirmation and
  putting an unfunded job in the studio queue. It surfaced days later as a
  misleading "authorization may have expired" when the studio tried to approve.
  Now the order is refused outright.

## What is *not* covered

Worth being explicit, so nobody trusts this more than they should:

- **Browser behaviour.** The Filerobot editor, the Stripe Elements field, drag
  and drop, and the responsive layout are all untested — every failure in this
  project that reached a user was in the browser. Playwright would close this
  gap and is the highest-value thing to add next.
- **Deliverability.** Whether email actually arrives is a DNS and reputation
  question that no unit test can answer.
- **Real S3/R2.** The multipart flow is tested against the local driver, which
  implements the same contract, but a live bucket has its own CORS and
  permission behaviour.
- **Load.** Nothing here says how it behaves with fifty simultaneous multi-GB
  uploads.

## Adding a test

When you fix a bug, add the failing case to `regressions.test.js` **first** and
watch it fail, then fix the code. A regression test that never failed hasn't
proven it tests anything.
