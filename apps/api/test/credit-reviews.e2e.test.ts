/**
 * [QA Engineer + Credit] CRD-07 review-date reminders (Phase 1b).
 * AC: 30 and 7 days before any buyer/supplier review date or KYC expiry, a task is created for credit.
 * On expiry the party is automatically excluded from new advances (checks PROGRAMME_IN_REVIEW_DATE / KYC_CURRENT).
 * PROGRAMME_IN_REVIEW_DATE covers the buyer programme review date and any buyer/supplier limit review date.
 *  TC-CRD-07a programme review: nothing at D-31, 30-day task at D-30 (once), 7-day task at D-7, notification to credit
 *  TC-CRD-07b supplier limit review date and supplier KYC expiry also produce tasks
 *  TC-CRD-07c credit closes a task with a note (audited); other roles can't see the task list
 *  TC-CRD-07d after the programme review date, approval is refused with PROGRAMME_IN_REVIEW_DATE
 *  TC-CRD-07e after the supplier's KYC expiry, approval is refused with KYC_CURRENT
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@mapema/pricing';
import { Harness, startHarness } from './harness';
import { AT, buildWorld, eligibleInvoice, seedFunding, World, WORKED } from './world';

let h: Harness; let w: World;
const D0 = WORKED.quoteDate;
const R = addDays(D0, 100); // programme review date used in this file
beforeAll(async () => {
  h = await startHarness(); w = await buildWorld(h); await seedFunding(h, w, 1_000_000_000n);
  await h.admin.query(`UPDATE mapema.buyer_programme SET review_date = $1 WHERE buyer_id = $2 AND status = 'live'`, [R, w.buyerId]);
});
afterAll(async () => { await h?.close(); });

async function runOn(date: string) {
  h.clock.set(AT(date));
  return w.credit.post('/credit/review-reminders/run', {});
}
const tasks = async () => (await w.credit.get('/credit/tasks?status=open')) as any[];

describe('CRD-07 review-date reminders', () => {
  it('TC-CRD-07a programme review: D-31 nothing, D-30 one task (idempotent), D-7 a second, credit notified', async () => {
    await runOn(addDays(R, -31));
    expect((await tasks()).filter((t) => t.kind === 'programme_review')).toHaveLength(0);
    await runOn(addDays(R, -30));
    await runOn(addDays(R, -30));
    let t = (await tasks()).filter((x) => x.kind === 'programme_review');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ threshold_days: 30, due_date: R, org_id: w.buyerId, org_name: 'Acme Supermarkets Ltd' });
    await runOn(addDays(R, -7));
    t = (await tasks()).filter((x) => x.kind === 'programme_review');
    expect(t.map((x) => x.threshold_days).sort()).toEqual([30, 7].sort());
    const n = await h.admin.query(`SELECT count(*)::int AS n FROM mapema.notification n JOIN mapema.user_account u ON u.id = n.user_id WHERE n.template_key = 'credit.review_due' AND u.email = 'credit@mapema.test'`);
    expect(n.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('TC-CRD-07b supplier limit review date and supplier KYC expiry produce tasks too', async () => {
    const lr = addDays(D0, 60);
    await h.admin.query(`INSERT INTO mapema.limit_config (subject, subject_org_id, absolute_cap_cents, review_date) VALUES ('supplier', $1, 50000000000, $2)`, [w.supplierId, lr]);
    const kx = addDays(D0, 70);
    await h.admin.query(`UPDATE mapema.kyc_check SET expires_at = $2 WHERE subject_org_id = $1 OR subject_person_id IN (SELECT id FROM mapema.person WHERE org_id = $1)`, [w.supplierId, `${kx}T21:00:00Z`]);
    await runOn(addDays(D0, 41));
    const t = await tasks();
    expect(t.find((x) => x.kind === 'limit_review' && x.org_id === w.supplierId)).toMatchObject({ threshold_days: 30, due_date: lr });
    expect(t.find((x) => x.kind === 'kyc_expiry' && x.org_id === w.supplierId)).toMatchObject({ threshold_days: 30, due_date: kx });
  });

  it('TC-CRD-07c credit completes a task with a note; buyers/suppliers/ops cannot list tasks', async () => {
    const t = (await tasks()).find((x) => x.kind === 'limit_review');
    await w.credit.post(`/credit/tasks/${t.id}/done`, {}, 400);
    const d = await w.credit.post(`/credit/tasks/${t.id}/done`, { note: 'Limit reviewed with updated management accounts' });
    expect(d.status).toBe('done');
    expect((await tasks()).some((x) => x.id === t.id)).toBe(false);
    await w.supplier.get('/credit/tasks', undefined, 403);
    await w.buyerAdmin.get('/credit/tasks', undefined, 403);
    await w.ops.get('/credit/tasks', undefined, 403);
    const ev = (await w.auditor.get('/audit/events?limit=100')).find((e: any) => e.action === 'credit_task.done' && e.entity_id === t.id);
    expect(ev).toBeTruthy();
  });

  it('TC-CRD-07d after the programme review date new advances are refused (PROGRAMME_IN_REVIEW_DATE)', async () => {
    // KYC is current again for this test
    await h.admin.query(`UPDATE mapema.kyc_check SET expires_at = $2 WHERE subject_org_id = $1 OR subject_person_id IN (SELECT id FROM mapema.person WHERE org_id = $1)`, [w.supplierId, `${addDays(D0, 900)}T00:00:00Z`]);
    h.clock.set(AT(R));
    const inv = await eligibleInvoice(h, w, { number: 'INV-RV-01', amountCents: 10_000_000n, issueDate: addDays(R, -1), dueDate: addDays(R, 40) });
    const q = await w.supplier.post(`/invoices/${inv}/quote`);
    const acc = await w.supplier.post('/advances', { disclosureIds: [q.disclosureId], acceptTerms: true }, undefined, { 'Idempotency-Key': 'rv-01' });
    const r = await w.credit.post(`/advances/${acc.advances[0].advanceId}/decision`, { decision: 'approve', reason: 'x' }, 422);
    expect(r.failedChecks.map((c: any) => c.code)).toContain('PROGRAMME_IN_REVIEW_DATE');
    expect(r.failedChecks.map((c: any) => c.code)).not.toContain('KYC_CURRENT');
    const run = await runOn(R);
    expect(run.created).toBeGreaterThanOrEqual(1); // expired: a 0-day (overdue) task
    expect((await tasks()).some((x) => x.kind === 'programme_review' && x.threshold_days === 0)).toBe(true);
  });

  it('TC-CRD-07e after the supplier KYC expiry new advances are refused (KYC_CURRENT)', async () => {
    await h.admin.query(`UPDATE mapema.buyer_programme SET review_date = $1 WHERE buyer_id = $2 AND status = 'live'`, [addDays(D0, 900), w.buyerId]);
    await h.admin.query(`UPDATE mapema.limit_config SET review_date = $1 WHERE subject_org_id = $2`, [addDays(D0, 900), w.supplierId]);
    const kx = addDays(R, 5);
    await h.admin.query(`UPDATE mapema.kyc_check SET expires_at = $2 WHERE subject_person_id IN (SELECT id FROM mapema.person WHERE org_id = $1) AND check_type = 'id_verification'`, [w.supplierId, `${kx}T00:00:00Z`]);
    h.clock.set(AT(addDays(kx, 1)));
    const inv = await eligibleInvoice(h, w, { number: 'INV-RV-02', amountCents: 10_000_000n, issueDate: kx, dueDate: addDays(kx, 40) });
    const q = await w.supplier.post(`/invoices/${inv}/quote`);
    const acc = await w.supplier.post('/advances', { disclosureIds: [q.disclosureId], acceptTerms: true }, undefined, { 'Idempotency-Key': 'rv-02' });
    const r = await w.credit.post(`/advances/${acc.advances[0].advanceId}/decision`, { decision: 'approve', reason: 'x' }, 422);
    expect(r.failedChecks.map((c: any) => c.code)).toEqual(['KYC_CURRENT']);
  });
});
