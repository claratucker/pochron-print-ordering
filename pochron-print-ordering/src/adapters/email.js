import { config } from '../config.js';

// Transactional email across the lifecycle (§11), all from info@pochronstudios.com.
// The confirmation email is also the definitive check on the address the
// customer entered — a bounce flags the order before it prints (§8/§11).

const money = (n) => '$' + Number(n || 0).toFixed(2);

// ── CONSOLE driver (dev) — prints to the server log ──
const consoleDriver = {
  name: 'console',
  async send({ to, subject, text }) {
    console.log(`\n── EMAIL ─────────────────────────────────\nfrom: ${config.email.from}\nto:   ${to}\nsubj: ${subject}\n${text}\n──────────────────────────────────────────\n`);
    return { delivered: true, driver: 'console' };
  },
};

// ── SMTP driver (production) — e.g. SES SMTP ──
// Requires: npm i nodemailer
const smtpDriver = {
  name: 'smtp',
  async send({ to, subject, text, html }) {
    let nodemailer;
    try { ({ default: nodemailer } = await import('nodemailer')); }
    catch { throw new Error('EMAIL_DRIVER=smtp requires nodemailer: npm i nodemailer'); }
    const t = nodemailer.createTransport({
      host: config.email.smtp.host, port: config.email.smtp.port,
      secure: config.email.smtp.port === 465,
      auth: { user: config.email.smtp.user, pass: config.email.smtp.pass },
    });
    const info = await t.sendMail({ from: config.email.from, to, subject, text, html });
    return { delivered: true, messageId: info.messageId, driver: 'smtp' };
  },
};

const driver = config.email.driver === 'smtp' ? smtpDriver : consoleDriver;

// ── Templates ──────────────────────────────────────────────────────
function itemLines(order) {
  return order.items.map((i) => {
    const cc = i.color_path === 'studio' ? ' · hand color correction' : '';
    return `  • ${i.original_name} — ${i.paper} · ${i.size} in × ${i.qty}${cc} — ${money(i.line_total)}`;
  }).join('\n');
}

export const emails = {
  // order received — includes a copy of the submission (§11)
  async confirmation(order) {
    const text =
`Thank you — your order is in.

Order reference: ${order.ref}

${itemLines(order)}

Subtotal:  ${money(order.subtotal)}${order.discount_amount ? `\nDiscount:  −${money(order.discount_amount)}` : ''}
Shipping:  ${money(order.shipping_cost)}
Tax:       ${money(order.tax)}
Total:     ${money(order.total)}

Pochron Studios reviews every order before printing and will reach out with any
questions. Your card is authorized now and charged only after we approve your
order for printing.

Questions? ${config.email.studioContactUrl}
Pochron Studios · info@pochronstudios.com · 718-237-1332`;
    return driver.send({ to: order.email, subject: `Order received — ${order.ref}`, text });
  },

  // proof on hold — studio → customer message thread (§6)
  async hold(order, message) {
    const text =
`About your order ${order.ref}:

${message}

Reply to this email and we'll pick it up with your order. Nothing prints until
we hear back and approve it.

Pochron Studios · info@pochronstudios.com`;
    return driver.send({ to: order.email, subject: `A question about your order — ${order.ref}`, text });
  },

  // approved / charged
  async approved(order, capturedAmount) {
    const text =
`Good news — your order ${order.ref} is approved and moving to print.

Charged: ${money(capturedAmount)}

We'll email tracking as soon as it ships.

Pochron Studios · info@pochronstudios.com`;
    return driver.send({ to: order.email, subject: `Approved & printing — ${order.ref}`, text });
  },

  // shipped
  async shipped(order, tracking) {
    const text =
`Your order ${order.ref} has shipped.${tracking ? `\n\nTracking: ${tracking}` : ''}

Pochron Studios · info@pochronstudios.com`;
    return driver.send({ to: order.email, subject: `Shipped — ${order.ref}`, text });
  },
};

export const email = driver;
