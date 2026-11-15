var test = require('node:test');
var assert = require('node:assert/strict');

var pricing = require('../lib/pricing');
var coupons = require('../lib/coupons');
var inventory = require('../lib/inventory');
var orders = require('../lib/orders');
var ledger = require('../lib/ledger');
var invoice = require('../lib/invoice');
var reports = require('../lib/reports');

test('pricing applies HSN GST after proportionally allocating coupon discount', function () {
  var totals = pricing.computeTotals([
    { id: 1, name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { id: 2, name: 'Tea', hsn: '0902', price: 100, qty: 1 }
  ], 'SAVE10');

  assert.equal(totals.subtotal, 1100);
  assert.equal(totals.discount, 110);
  assert.equal(totals.lines[0].discount, 100);
  assert.equal(totals.lines[0].gstPercent, 5);
  assert.equal(totals.lines[1].discount, 10);
  assert.equal(totals.lines[1].gstPercent, 18);
  assert.equal(totals.cgst + totals.sgst, totals.tax);
  assert.equal(totals.total, totals.taxable + totals.tax);
});

test('coupon validation normalizes codes and enforces minimum and inactive status', function () {
  assert.equal(coupons.validate(' save10 ', 500).valid, true);
  assert.match(coupons.validate('SAVE10', 499).error, /minimum order/);
  assert.match(coupons.validate('DIWALI20', 2000).error, /expired/);
});

test('sellable stock excludes reservations and check preserves one unit as a buffer', function () {
  var products = [{ id: 1, name: 'Rice', stock: 10, reserved: 2 }];
  assert.equal(inventory.getSellableStock(products[0]), 8);
  assert.deepEqual(inventory.check(products, [{ id: 1, qty: 7 }]), { ok: true });
  assert.equal(inventory.check(products, [{ id: 1, qty: 8 }]).ok, false);
});

test('order listing filters by status, customer search, and date range', function () {
  var db = { orders: [
    { id: 1001, date: '01/11/2026', customer: 'Mira', status: 'completed' },
    { id: 1002, date: '03/11/2026', customer: 'Asha', status: 'pending' },
    { id: 1003, date: '04/11/2026', customer: 'Mira', status: 'cancelled' }
  ] };
  var found = orders.list(db, { status: 'completed', search: 'mira', from: '2026-11-01', to: '2026-11-02' });
  assert.deepEqual(found.map(function (order) { return order.id; }), [1001]);
});

test('khata charges respect credit limits and settlements reduce the balance', function () {
  var db = {
    customers: [{ id: 7, name: 'Mira', creditLimit: 500, openingBalance: 100, totalBilled: 0, totalSettled: 0 }],
    settlements: [],
    nextSettlementId: 501
  };

  assert.equal(ledger.chargeOrderToKhata(db, 7, 400).ok, true);
  assert.equal(ledger.chargeOrderToKhata(db, 7, 1).ok, false);
  var payment = ledger.recordSettlement(db, 7, 150, 'upi', 'part payment');
  assert.equal(payment.ok, true);
  assert.equal(payment.customer.balance, 350);
  assert.equal(db.settlements[0].id, 501);
});

test('invoice uses the same HSN GST rates and totals as checkout', function () {
  var items = [{ id: 1, name: 'Rice', sku: 'RICE', hsn: '1006', price: 500, qty: 2 }];
  var checkout = pricing.computeTotals(items, '');
  var order = {
    id: 1001,
    date: '15/11/2026',
    customer: 'Mira',
    items: items,
    coupon: '',
    subtotal: checkout.subtotal,
    discount: checkout.discount,
    tax: checkout.tax,
    total: checkout.total
  };
  var billed = invoice.computeInvoiceFigures(order);
  var reconciliation = reports.getGstReconciliation({ orders: [order] });

  assert.equal(checkout.tax, 50);
  assert.equal(checkout.total, 1050);
  assert.equal(billed.rows[0].gstPercent, 5);
  assert.equal(billed.rows[0].lineTax, checkout.lines[0].tax);
  assert.equal(billed.tax, checkout.tax);
  assert.equal(billed.total, checkout.total);
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(reconciliation.rows[0].delta, 0);
  assert.equal(reconciliation.rows[0].matched, true);
});

test('invoice applies coupon discount and GST the same way as checkout', function () {
  var items = [{ id: 1, name: 'Rice', sku: 'RICE', hsn: '1006', price: 500, qty: 2 }];
  var checkout = pricing.computeTotals(items, 'WELCOME');
  var order = {
    id: 1002,
    date: '15/11/2026',
    customer: 'Mira',
    items: items,
    coupon: 'WELCOME',
    subtotal: checkout.subtotal,
    discount: checkout.discount,
    tax: checkout.tax,
    total: checkout.total
  };
  var billed = invoice.computeInvoiceFigures(order);
  var html = invoice.render(order);
  var reconciliation = reports.getGstReconciliation({ orders: [order] });

  assert.equal(checkout.discount, 50);
  assert.equal(checkout.tax, 47.5);
  assert.equal(checkout.total, 997.5);
  assert.equal(billed.discount, checkout.discount);
  assert.equal(billed.rows[0].lineTax, checkout.lines[0].tax);
  assert.equal(billed.tax, checkout.tax);
  assert.equal(billed.total, checkout.total);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(reconciliation.rows[0].invoiceDiscount, checkout.discount);
  assert.equal(reconciliation.rows[0].invoiceTax, checkout.tax);
  assert.equal(reconciliation.rows[0].delta, 0);
});
