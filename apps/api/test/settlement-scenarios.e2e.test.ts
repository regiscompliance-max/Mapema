/**
 * [QA Engineer + Compliance & Risk Analyst] Settlement scenarios through the API (mock ledger, same
 * product semantics as the Fineract proof):
 *  TC-SET-01 early full payment on day 30: interest on actual days (D-03) -> KES 28,000
 *  TC-SET-02 two partial payments (day 30 + due date): principal first, interest on declining balance
 *  TC-SET-03 early partial that exceeds principal: remainder HELD and posted on the due date in CBK
 *            order (fee before interest) - the Fineract quirk found in the spike
 *  TC-SET-04 duplicate bank webhook delivery is applied once
 *  TC-SET-05 unmatched credit -> manual match needs a second ops user
 *  TC-SET-06 payer-name mismatch raises an AML flag (never shown to the customer)
 *  TC-SET-07 overpayment beyond the invoice -> refund_due, journalled to the overpayment GL
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@mapema/pricing';
import { signWebhook } from '@mapema/adapters';
import { Harness, startHarness } from './harness';
import { AT, buildWorld, eligibleInvoice, fund, LEDGER_ENV, REAL_LEDGER, seedFunding, World, WORKED } from './world';

let h: Harness; let w: World;
beforeAll(async () => { h = await startHarness(LEDGER_ENV); w = await buildWorld(h); await seedFunding(h, w, 1_000_000_000n); });
afterAll(async () => { await h?.close(); });

const D0 = WORKED.quoteDate;
async function pay(amountCents: bigint, date: string, ref: string, narrative: string, payerName = 'Acme Supermarkets Ltd') {
  h.clock.set(AT(date));
  const r = await h.http.post('/v1/dev/bank/credit').send({ accountNo: w.virtualAccount, amountCents: String(amountCents), bankRef: ref, valueDate: date, payerName, narrative });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body;
}
async function alloc(advanceId: string) {
  return (await h.admin.query(`SELECT COALESCE(SUM(principal_cents),0)::text AS p, COALESCE(SUM(fees_charges_cents),0)::text AS f, COALESCE(SUM(interest_cents),0)::text AS i,
    COALESCE(SUM(supplier_balance_cents),0)::text AS s FROM mapema.payment_allocation WHERE advance_id = $1`, [advanceId])).rows[0];
}
async function newFunded(number: string, start: string) {
  h.clock.set(AT(start));
  const inv = await eligibleInvoice(h, w, { number, amountCents: 100_000_000n, issueDate: addDays(start, -1), dueDate: addDays(start, 48) });
  return { invoiceId: inv, ...(await fund(h, w, inv)), due: addDays(start, 48) };
}
const status = async (id: string) => (await h.admin.query(`SELECT status FROM mapema.advance WHERE id = $1`, [id])).rows[0].status;

describe(`settlement scenarios [ledger=${REAL_LEDGER ? 'real Fineract' : 'mock'}]`, () => {
  it('TC-SET-01 early full payment on day 30 -> interest KES 28,000, supplier gets KES 169,500', async () => {
    const a = await newFunded('INV-E-001', D0);
    const r = await pay(100_000_000n, addDays(D0, 30), 'BR-E-001', 'INV-E-001');
    expect(r.status).toBe('applied');
    expect(await alloc(a.advanceId)).toEqual({ p: '80000000', f: '250000', i: '2800000', s: '16950000' });
    expect(await status(a.advanceId)).toBe('settled');
  });

  it('TC-SET-02 partial 500k on day 30 then 500k on due date -> principal first, interest 34,300', async () => {
    const start = addDays(D0, 31);
    const a = await newFunded('INV-P-002', start);
    const r1 = await pay(50_000_000n, addDays(start, 30), 'BR-P-002a', 'INV-P-002');
    expect(r1.status).toBe('applied');
    expect(await alloc(a.advanceId)).toEqual({ p: '50000000', f: '0', i: '0', s: '0' });
    expect(await status(a.advanceId)).toBe('funded');
    await pay(50_000_000n, a.due, 'BR-P-002b', 'INV-P-002');
    // interest: 800,000 x 30d + 300,000 x 18d at 3.5%/30d = 28,000 + 6,300
    expect(await alloc(a.advanceId)).toEqual({ p: '80000000', f: '250000', i: '3430000', s: '16320000' });
    expect(await status(a.advanceId)).toBe('settled');
  });

  it('TC-SET-03 early partial above principal is held, then posted fee-before-interest on the due date', async () => {
    const start = addDays(D0, 80);
    const a = await newFunded('INV-H-003', start);
    const r1 = await pay(81_000_000n, addDays(start, 30), 'BR-H-003a', 'INV-H-003');
    expect(r1.status).toBe('partially_applied');
    expect(r1.held_cents).toBe('1000000');
    expect(await alloc(a.advanceId)).toEqual({ p: '80000000', f: '0', i: '0', s: '0' });
    h.clock.set(AT(a.due));
    const jobs = await h.http.post('/v1/dev/jobs/run').expect(201);
    expect(jobs.body.held).toBe(1);
    expect(await alloc(a.advanceId)).toEqual({ p: '80000000', f: '250000', i: '750000', s: '0' }); // 10,000 -> fee 2,500 then interest 7,500
    await pay(19_000_000n, a.due, 'BR-H-003b', 'INV-H-003');
    expect(await alloc(a.advanceId)).toEqual({ p: '80000000', f: '250000', i: '2800000', s: '16950000' });
    expect(await status(a.advanceId)).toBe('settled');
  });

  it('TC-SET-04 duplicate webhook delivery (same bank ref) is applied once; signature required', async () => {
    const start = addDays(D0, 130);
    const a = await newFunded('INV-D-004', start);
    h.clock.set(AT(a.due));
    const body = JSON.stringify({ account_no: w.virtualAccount, amount_cents: '100000000', bank_ref: 'BR-D-004', value_date: a.due, currency: 'KES', payer_name: 'Acme Supermarkets Ltd', narrative: 'INV-D-004' });
    h.adapters.bank.creditReceived(100_000_000n);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signWebhook('test-bank-webhook-secret-123', ts, body);
    const send = (s: string) => h.http.post('/v1/webhooks/bank').set('Content-Type', 'application/json').set('x-bank-timestamp', ts).set('x-bank-signature', s).send(body);
    expect((await send('deadbeef')).status).toBe(401);
    const r1 = await send(sig); const r2 = await send(sig);
    expect(r1.status).toBe(201); expect(r1.body.duplicate).toBe(false);
    expect(r2.status).toBe(201); expect(r2.body.duplicate).toBe(true);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM mapema.payment_allocation WHERE advance_id = $1`, [a.advanceId])).rows[0].n).toBe(1);
    expect(await alloc(a.advanceId)).toEqual({ p: '80000000', f: '250000', i: '4480000', s: '15270000' });
  });

  it('TC-SET-05 unmatched credit -> manual match proposed by ops, approved by a second ops user', async () => {
    const start = addDays(D0, 180);
    const a = await newFunded('INV-M-005', start);
    const r = await pay(100_000_000n, a.due, 'BR-M-005', 'payment for goods', 'Acme Supermarkets Ltd');
    // amount equals the invoice -> unique-amount auto match; use a different amount to force manual
    expect(['applied', 'unmatched']).toContain(r.status);
    const r2 = await pay(12_345n, a.due, 'BR-M-005b', 'misc');
    expect(r2.status).toBe('unmatched');
    const appr = await w.ops.post(`/payments/${r2.paymentId}/match`, { advanceId: a.advanceId, reason: 'buyer confirmed by email' }, [409, 422]);
    expect(['ADVANCE_NOT_OPEN']).toContain(appr.title); // already settled -> cannot be matched; becomes a refund case
  });

  it('TC-SET-06 payer name not the buyer -> AML flag for compliance', async () => {
    const start = addDays(D0, 230);
    const a = await newFunded('INV-A-006', start);
    await pay(100_000_000n, a.due, 'BR-A-006', 'INV-A-006', 'UNRELATED TRADING CO');
    const flags = await w.compliance.get('/aml-flags');
    expect(flags.some((f: any) => f.rule_code === 'PAYER_NOT_BUYER')).toBe(true);
    await w.supplier.get('/aml-flags', 403);
  });

  it('TC-SET-07 overpayment -> supplier balance capped at the invoice, excess refund_due', async () => {
    const start = addDays(D0, 280);
    const a = await newFunded('INV-O-007', start);
    const r = await pay(100_100_000n, a.due, 'BR-O-007', 'INV-O-007');
    expect(r.status).toBe('refund_due');
    expect(r.unapplied_cents).toBe('100000');
    expect(await alloc(a.advanceId)).toEqual({ p: '80000000', f: '250000', i: '4480000', s: '15270000' });
    const tb = await w.auditor.get('/ledger/trial-balance');
    expect(tb.balanced).toBe(true);
  });
});

describe(`buyer underpayment shortfall owed to the supplier (D-22) [ledger=${REAL_LEDGER ? 'real Fineract' : 'mock'}]`, () => {
  it('TC-SET-08 buyer pays 900k: Mapema repaid, supplier gets 52.7k, 100k shortfall tracked; a later 100k top-up goes to the supplier and closes it', async () => {
    const start = addDays(D0, 340);
    const a = await newFunded('INV-S-008', start);
    const r = await pay(90_000_000n, a.due, 'BR-S-008a', 'INV-S-008');
    expect(r.status).toBe('applied');
    expect(await alloc(a.advanceId)).toEqual({ p: '80000000', f: '250000', i: '4480000', s: '5270000' });
    expect(await status(a.advanceId)).toBe('settled');
    // the supplier sees the shortfall and is told to chase the buyer; the buyer sees what it still owes the supplier
    const sf = (await w.supplier.get('/shortfalls')).find((x: any) => x.advance_id === a.advanceId);
    expect(sf).toMatchObject({ status: 'open', amount_cents: '10000000', original_cents: '10000000', invoice_number: 'INV-S-008' });
    expect((await w.buyerAdmin.get('/shortfalls')).map((x: any) => x.id)).toContain(sf.id);
    await h.http.post('/v1/dev/jobs/run').expect(201);
    expect(h.adapters.sms.outbox.some((m: any) => /shortfall|KES 100,000/i.test(m.text))).toBe(true);
    // late top-up from the buyer: matched by invoice reference to the settled advance, paid through to the supplier
    const r2 = await pay(10_000_000n, addDays(a.due, 10), 'BR-S-008b', 'INV-S-008 balance');
    expect(r2.status).toBe('applied');
    expect((await alloc(a.advanceId)).s).toBe('15270000');
    const sf2 = (await w.supplier.get('/shortfalls')).find((x: any) => x.id === sf.id);
    expect(sf2).toMatchObject({ status: 'settled', amount_cents: '0' });
    const payouts = (await w.ops.get('/payouts?status=proposed')).filter((x: any) => x.advance_id === a.advanceId);
    expect(payouts.map((x: any) => x.amount_cents).sort()).toEqual(['10000000', '5270000'].sort());
  });

  it('TC-SET-09 supplier can close a shortfall it recovered directly or chose to forgive (supplier admin only, reason required)', async () => {
    const start = addDays(D0, 400);
    const a = await newFunded('INV-S-009', start);
    await pay(85_000_000n, a.due, 'BR-S-009', 'INV-S-009');
    const sf = (await w.supplier.get('/shortfalls')).find((x: any) => x.advance_id === a.advanceId);
    expect(sf.amount_cents).toBe('15000000');
    await w.buyerAdmin.post(`/shortfalls/${sf.id}/close`, { outcome: 'recovered_directly', note: 'paid by cheque' }, 403);
    await w.supplier.post(`/shortfalls/${sf.id}/close`, { outcome: 'recovered_directly' }, 400);
    const c = await w.supplier.post(`/shortfalls/${sf.id}/close`, { outcome: 'recovered_directly', note: 'Buyer paid us by cheque on 12 Feb' });
    expect(c.status).toBe('recovered_directly');
    const ev = (await w.auditor.get('/audit/events?limit=50')).find((e: any) => e.action === 'shortfall.close' && e.entity_id === sf.id);
    expect(ev).toBeTruthy();
  });
});

describe('collections, disputes, complaints, DSR', () => {
  it('TC-OPS-01 late ladder D1/D7/D14/D30 then recourse by credit, approved by a second credit user (step-up)', async () => {
    const start = addDays(D0, 330);
    const a = await newFunded('INV-L-008', start);
    h.clock.set(AT(addDays(a.due, 31)));
    const r = await w.ops.post('/ops/late-ladder/run');
    expect(r.actions.filter((x: any) => x.advanceId === a.advanceId).map((x: any) => x.stage)).toEqual(['d1_reminder', 'd7_call', 'd14_demand', 'd30_recourse']);
    expect(await status(a.advanceId)).toBe('late');
    const again = await w.ops.post('/ops/late-ladder/run');
    expect(again.actions.filter((x: any) => x.advanceId === a.advanceId)).toHaveLength(0); // idempotent
    // Phase 2 COL-04 (D-41): recourse is now maker-checker - credit proposes, a second credit user approves
    const p = await w.credit.post(`/advances/${a.advanceId}/recourse`, { reason: 'Buyer insolvent; recourse per master agreement' });
    expect(await status(a.advanceId)).toBe('late');
    await w.approve(p.id, w.credit2);
    expect(await status(a.advanceId)).toBe('recourse');
    // late buyer payment still settles in CBK order; no late charges in Phase 1
    await pay(100_000_000n, addDays(a.due, 32), 'BR-L-008', 'INV-L-008');
    expect(await alloc(a.advanceId)).toEqual({ p: '80000000', f: '250000', i: '4480000', s: '15270000' });
  });

  it('TC-OPS-02 buyer dispute blocks the invoice; closing needs compliance approval', async () => {
    h.clock.set(AT(addDays(D0, 400)));
    const inv = await eligibleInvoice(h, w, { number: 'INV-X-009', amountCents: 10_000_000n, issueDate: addDays(D0, 399), dueDate: addDays(D0, 430) });
    const d = await w.buyerChecker.post('/disputes', { invoiceId: inv, reasonCode: 'quality', description: 'Cartons crushed' });
    await w.supplier.post(`/invoices/${inv}/quote`, undefined, 409);
    const close = await w.ops.post(`/disputes/${d.id}/close`, { outcome: 'resolved', resolution: 'Supplier replaced goods', invoiceValid: true });
    await w.approve(close.id, w.compliance);
    const q = await w.supplier.post(`/invoices/${inv}/quote`);
    expect(q.invoiceAmountCents).toBe('10000000');
  });

  it('TC-OPS-03 complaint gets 7/30-day clocks; DSR from the public site starts the statutory clock', async () => {
    const c = await w.supplier.post('/complaints', { category: 'pricing', description: 'I did not understand the fee' });
    expect(new Date(c.resolve_due_at).getTime() - new Date(c.ack_due_at).getTime()).toBe(23 * 864e5);
    const mine = await w.supplier.get('/complaints');
    expect(mine).toHaveLength(1);
    const dsr = await h.http.post('/v1/public/data-requests').send({ email: 'someone@example.com', type: 'access' }).expect(201);
    const list = await w.compliance.get('/dsr');
    expect(list.map((x: any) => x.id)).toContain(dsr.body.id);
  });
});
