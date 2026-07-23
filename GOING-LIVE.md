# Going live: domain, nginx, HTTPS

Right now the app answers on `http://<elastic-ip>:4000`. To be a real site it
needs a domain, HTTPS, and a proper web server in front. Do these in order —
each step depends on the one before.

HTTPS isn't cosmetic here. Stripe Elements **refuses to load over plain http**,
so the card field simply won't appear until this is done. Passwords for `/studio`
and `/admin` also travel in the clear without it.

## 1. DNS (do this first — it takes the longest)

In whatever manages `pochronstudios.com` DNS (likely Squarespace, or a registrar
like GoDaddy/Cloudflare), add one record:

| Type | Host / Name | Value |
|---|---|---|
| A | `order` | your Elastic IP |

That creates `order.pochronstudios.com`. Squarespace keeps the main site; only
this subdomain points at the EC2 box.

Propagation is usually minutes but can take a few hours. Check from your Mac:

```bash
dig +short order.pochronstudios.com
```

When that prints your Elastic IP, move on. **Don't attempt step 3 before it
does** — Let's Encrypt verifies by connecting to the domain, and it will fail.

## 2. Install nginx

```bash
sudo apt-get update
sudo apt-get install -y nginx
```

Create the site config:

```bash
sudo nano /etc/nginx/sites-available/pochron
```

Paste this (it proxies the domain to the app on port 4000, and raises the upload
limit so multi-GB scans aren't rejected by nginx before they reach the app):

```nginx
server {
    listen 80;
    server_name order.pochronstudios.com;

    # Large originals: don't let nginx cap the body or time out mid-transfer.
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable it and reload:

```bash
sudo ln -s /etc/nginx/sites-available/pochron /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t          # must say "syntax is ok" / "test is successful"
sudo systemctl reload nginx
```

Now `http://order.pochronstudios.com` should load the app — no `:4000`.

## 3. HTTPS with Let's Encrypt (free)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d order.pochronstudios.com
```

Answer the prompts: an email for expiry warnings, agree to terms, and **choose
the redirect option** so http traffic is forwarded to https. Certbot edits the
nginx config and reloads it for you.

Renewal is automatic (a systemd timer). Confirm with:

```bash
sudo certbot renew --dry-run
```

## 4. Lock things down

Now that traffic arrives via 80/443, port 4000 shouldn't be reachable from the
internet:

- **EC2 Security Group** → delete the `Custom TCP 4000` rule.
- Optionally bind the app to localhost only by setting `HOST=127.0.0.1` in `.env`.

Then update `.env` for the real origin and restart:

```
CORS_ORIGINS=https://order.pochronstudios.com
APP_SECRET=<a long random string — change it>
STUDIO_PASSWORD=<a real password>
ADMIN_PASSWORD=<a different real password>
```

```bash
pm2 restart pochron
```

The `-dev` passwords must not survive this step: `/studio` can capture payments
and `/admin` sets prices.

## 5. Link it from Squarespace

**Pages → Navigation → add a link** labelled "Order Prints" pointing at
`https://order.pochronstudios.com`. The marketing site stays where it is; the
ordering tool lives on the subdomain and links back.

## Verify

- `https://order.pochronstudios.com/api/health` → `{"ok":true,...}` with a padlock
- `https://order.pochronstudios.com/order/mockupV4.html` → the ordering app,
  **with the Stripe card field visible** (this is the proof HTTPS is working)
- `/studio` and `/admin` → prompt for the new passwords
- `http://…` (no s) → redirects to https
