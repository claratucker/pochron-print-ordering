# Pochron Studios — Order Fulfillment & Admin Guide

**Confidential — for Julie and Clara only.** This contains passwords and account
logins. Do not share it with customers or beta testers.

---

## Your two links

| What | Address | Password |
|---|---|---|
| **Proofing queue** — review, approve, and ship orders | https://order.pochronstudios.com/studio | `__________` |
| **Pricing** — edit prices, shipping, fees | https://order.pochronstudios.com/admin | `__________` |

Customers place orders at the "Order Prints" button on the website — you don't
need that page. Keep these passwords private and don't post the links publicly.

---

## The one thing to know about payment

**Nobody's card is charged when they order — it's only authorized (held).** The
customer is charged the moment **you approve** their order for printing. If you
never approve, they're never charged.

**Card holds expire after about 7 days.** Review orders within a few days. If a
hold lapses before you approve, the queue tells you, and you send a quick
re-authorization request (below).

---

## Reviewing and fulfilling an order

New orders sit at the **top** of the queue. Open one and you'll see who ordered
it, their email, each photo (paper, size, quantity, price), the customer's
original file plus any edits, and any flags: **Hand color correction** (they paid
$15 for you to correct it), a **low-resolution** note (they were warned and chose
to proceed), a **tax-review** flag, or a **white-label** parcel (ships under the
customer's business name).

Review the image(s), do any hand color correction, then choose:

- **Approve & print** — charges the card and generates the print files. You can
  approve **all** photos or **select some**; a partial approval charges only for
  the photos you approved and holds the rest.
- **Hold & message** — write the customer a short note (e.g. "Could you send a
  higher-resolution file?"). Puts the order on hold and sends the message.
- **Mark shipped** — once the prints are on their way.
- **Cancel order** — on an order you *haven't* approved yet. Releases the card hold
  immediately (instead of waiting ~7 days for it to expire) and emails the
  customer. Nothing is charged.
- **Refund order** — on an order you've already approved/charged. Refunds the full
  charge through Stripe and emails the customer. Appears on approved, in-production,
  and shipped orders.
- **Re-authorize** — only if a card hold expired. Send the request; approve once
  the customer re-confirms their card.

## Pricing page

Edit print prices, shipping rates, volume discount tiers, and the $15
color-correction fee. Changes apply to **new** orders immediately; existing
orders keep the price they were placed at.

---

## FAQ & troubleshooting

**A customer ordered the wrong thing (wrong photo, size, or paper).**
If you haven't approved it yet, nothing's been charged. Use **Hold & message** to
sort it out with them, or **Cancel order** to release the hold and close it out. An
order you never approve simply never charges; the hold also releases on its own
within about 7 days.

**A customer needs a refund after you already approved (charged) them.**
Open the order in the queue and click **Refund order** — it refunds the full charge
through Stripe and emails the customer. You don't need to log into Stripe for a
full refund.

*Partial refunds* (returning just part of an order — say one photo out of three)
aren't built into the queue yet. For those, log into **Stripe → Payments**, find
the charge (search by the customer's email, amount, or date), and choose **Refund**
with the amount you want. Everything else — full refunds and cancellations — you do
right in the queue.

**A customer entered the wrong email or contact info.**
The order shows exactly what they typed. If the **email** is wrong, your
"Hold & message" note also goes to that wrong address — so reach them by **phone**
instead (if they provided one). You can still print and ship if the mailing
address is right.

**A customer entered the wrong shipping address.**
You ship to the address on the order. If it looks off, **Hold & message** (or
phone) to confirm the correct address before shipping.

**A customer says they ordered but it's not in the queue.**
Ask for their order reference (looks like `PS-123456`). If it's truly not there,
their payment likely didn't go through, so the order never completed — have them
try again. Every real order lands in the queue.

**The confirmation email didn't reach the customer.**
Check the email address on the order for a typo, and have them check their spam
folder. There's no "resend" button; if the address was wrong, use phone.

**An order has a tax-review flag.**
Automatic tax couldn't be calculated for that order (it shows $0 tax). Review it
before charging — you may need to add tax manually or check with Clara.

**A low-resolution flag.**
The customer was warned the file may print soft and chose to proceed. That's
expected — it's not an error.

**Where is customer information stored?**
- **Names, emails, phone numbers, and shipping addresses** — in the app's
  database on the server (not in a spreadsheet or third-party address book).
- **Uploaded photos** — in Cloudflare (see accounts below); the originals are
  always kept.
- **Card numbers** — **never stored by us.** All card data is handled by Stripe;
  our system only keeps a reference to the Stripe charge. That's why refunds
  happen in Stripe.

**A photo won't open or preview in the queue.**
A very large file may still be processing — refresh in a minute. If it persists,
note the order reference and tell Clara.

---

## Accounts & logins

**Confidential.** Two accounts run this system. Store the actual passwords in a
password manager rather than writing them here; fill in the login emails below.

| Account | What it does | Sign in at | Login email |
|---|---|---|---|
| **Stripe** | Payments and tax. Full refunds and cancellations are now in the queue; you'll only need Stripe directly for **partial** refunds or to review payments. | https://dashboard.stripe.com | `__________` |
| **Cloudflare** | Stores customers' uploaded photos (R2). Rarely needed day to day. | https://dash.cloudflare.com | `__________` |

The website, its subdomain, and the server the app runs on are managed by Clara.

---

## During beta

While the tool is in beta it runs in Stripe **test mode** — orders placed by
testers are **not real charges**, and only test cards work (see the tester
sheet). Real customer payments turn on when beta ends.
