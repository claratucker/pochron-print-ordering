# Deploy & publish

Two things happen here: publishing the code to GitHub (portfolio), and standing
up a running instance (a live demo, and eventually production on the subdomain).

## Publish to GitHub

The repo is already safe to make public — no secrets are committed (`.env` and
`data/` are gitignored; `.env.example` holds only placeholders). From the project
folder:

```bash
git init
git add -A
git commit -m "Pochron Studios print-ordering backend — Phase 1"
git branch -M main
git remote add origin https://github.com/claratucker/pochron-print-ordering.git
git push -u origin main
```

Create the empty `pochron-print-ordering` repo on GitHub first (no README/license —
this repo already has them), then run the push. If you use SSH, swap the remote
for `git@github.com:claratucker/pochron-print-ordering.git`.

A short note is already in the README crediting Pochron Studios and stating the
work was done with their permission — worth keeping on a public client project.

## Stand up a live demo (recommended for the portfolio)

A reviewer clicking a working URL is worth far more than a repo they have to run.
This runs on the mock adapters (local storage, mock payment, console email) so it
needs no cloud accounts — the whole order → proof → capture loop works as-is.

Any Node host works. On **Render** (has a free tier):

1. New → Web Service → connect the GitHub repo.
2. Build command `npm install`, start command `npm start`.
3. Add a persistent disk mounted at `/opt/render/project/src/data` (SQLite lives
   in `data/`), or accept that the demo DB resets on redeploy — fine for a demo.
4. Add a one-off job or shell run of `npm run seed` after first deploy.
5. Set env: leave the drivers on their mock defaults; set a real `APP_SECRET`,
   `STUDIO_PASSWORD`, `ADMIN_PASSWORD`, and `CORS_ORIGINS` to the Render URL.

Once live, link three things from the README so reviewers can walk the whole app:
the order/self-edit demo at `/order/edit-demo.html`, the studio queue at `/studio`,
and the pricing admin at `/admin` (share the demo passwords in the README since
it's a throwaway demo, or note them privately).

**Railway / Fly.io / a small VPS** work the same way — it's a standard Node +
SQLite service. For real production, move the drivers to S3 + Stripe + SMTP per
the README's production checklist and switch SQLite to Postgres.

## Wire it into Squarespace (production)

Deploy this app (plus the order front end) to `order.pochronstudios.com`, point
`CORS_ORIGINS` at that origin, then in Squarespace go to **Pages → Navigation**
and add a link labeled "Order Prints" pointing at the subdomain. The marketing
site stays on Squarespace; the tool lives on the subdomain and links back.

## The pages, once deployed

- `/order/edit-demo.html` — the customer self-edit step (Filerobot).
- `/studio` — Julie's proofing queue: review, approve & capture, hold & message, ship.
- `/admin` — Julie's pricing page: prices, shipping, discount tiers, fees.

`/studio` and `/admin` are password-gated; put them behind real auth or SSO for
production rather than the shared dev passwords.
