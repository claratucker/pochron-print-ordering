import { db } from '../db/index.js';

export function getOrder(id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return null;
  return hydrate(order);
}
export function getOrderByRef(ref) {
  const order = db.prepare('SELECT * FROM orders WHERE ref = ?').get(ref);
  return order ? hydrate(order) : null;
}

function hydrate(order) {
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  order.messages = db.prepare('SELECT * FROM order_messages WHERE order_id = ? ORDER BY id').all(order.id);
  order.events = db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id').all(order.id);
  order.white_label = !!order.white_label;
  order.low_res_ack = !!order.low_res_ack;
  return order;
}

export function transition(orderId, toStatus, note) {
  const cur = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
  db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(toStatus, orderId);
  db.prepare(
    `INSERT INTO order_events (order_id, from_status, to_status, note) VALUES (?,?,?,?)`
  ).run(orderId, cur?.status || null, toStatus, note || null);
}

export function addMessage(orderId, direction, body) {
  db.prepare(
    `INSERT INTO order_messages (order_id, direction, body) VALUES (?,?,?)`
  ).run(orderId, direction, body);
}

// PS-###### reference. Loops on the tiny chance of collision.
export function newRef() {
  for (let i = 0; i < 5; i++) {
    const ref = 'PS-' + String(Date.now()).slice(-6);
    if (!db.prepare('SELECT 1 FROM orders WHERE ref = ?').get(ref)) return ref;
  }
  return 'PS-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}
