import { describe, expect, it } from 'vitest';
import { dueJobs, eatClock, Job } from '../src/main';

const noop = async () => undefined;
const jobs: Job[] = [{ name: 'outbox', everyMs: 5000, run: noop }, { name: 'ladder', at: '06:00', run: noop }];

describe('worker schedule (EAT)', () => {
  it('converts UTC to East Africa Time', () => {
    expect(eatClock(new Date('2027-01-04T03:30:00Z'))).toEqual({ date: '2027-01-04', hhmm: '06:30' });
    expect(eatClock(new Date('2027-01-04T22:00:00Z'))).toEqual({ date: '2027-01-05', hhmm: '01:00' });
  });
  it('daily jobs run once per EAT day after their time; interval jobs by elapsed time', () => {
    const last = new Map<string, string | number>();
    expect(dueJobs(jobs, new Date('2027-01-04T02:59:00Z'), last).map((j) => j.name)).toEqual(['outbox']);
    expect(dueJobs(jobs, new Date('2027-01-04T03:00:00Z'), last).map((j) => j.name)).toEqual(['outbox', 'ladder']);
    last.set('ladder', '2027-01-04'); last.set('outbox', new Date('2027-01-04T03:00:00Z').getTime());
    expect(dueJobs(jobs, new Date('2027-01-04T03:00:03Z'), last)).toEqual([]);
    expect(dueJobs(jobs, new Date('2027-01-05T03:00:05Z'), last).map((j) => j.name)).toEqual(['outbox', 'ladder']);
  });
  it('TC-P2-WRK-01 month-end job runs only on the 1st (EAT) at 02:00', () => {
    const me: Job[] = [{ name: 'month-end-reports', at: '02:00', dayOfMonth: 1, run: noop }];
    const last = new Map<string, string | number>();
    expect(dueJobs(me, new Date('2027-02-27T23:30:00Z'), last)).toEqual([]); // 28 Feb 02:30 EAT: not the 1st
    expect(dueJobs(me, new Date('2027-02-28T22:59:00Z'), last)).toEqual([]); // 1 Mar 01:59 EAT: too early
    expect(dueJobs(me, new Date('2027-02-28T23:00:00Z'), last).map((j) => j.name)).toEqual(['month-end-reports']); // 1 Mar 02:00 EAT
    last.set('month-end-reports', '2027-03-01');
    expect(dueJobs(me, new Date('2027-03-01T08:00:00Z'), last)).toEqual([]);
    expect(dueJobs(me, new Date('2027-03-02T05:00:00Z'), last)).toEqual([]);
  });
});

describe('TC-P3-WRK-01 Phase 3 jobs', () => {
  it('ERP import every 15 minutes and the M-Pesa pending check every 5 minutes are scheduled next to the Phase 2 jobs', async () => {
    const { buildJobs } = await import('../src/main');
    const calls: string[] = [];
    // (a spread of a Proxy copies no keys, so the clock is served by the same proxy)
    const clock = { today: () => '2027-01-04' };
    const svc = new Proxy({}, { get: (_t, svcName) => (svcName === 'clock' ? clock : new Proxy({}, { get: (_t2, m) => async () => { calls.push(`${String(svcName)}.${String(m)}`); } })) }) as any;
    const jobs = buildJobs(svc);
    const byName = new Map(jobs.map((j) => [j.name, j]));
    expect(byName.get('erp-import')?.everyMs).toBe(900_000);
    expect(byName.get('mpesa-pending')?.everyMs).toBe(300_000);
    for (const n of ['outbox', 'payout-status', 'reconciliation', 'month-end-reports', 'crm-import']) expect(byName.has(n)).toBe(true);
    await byName.get('erp-import')!.run();
    await byName.get('mpesa-pending')!.run();
    expect(calls).toEqual(['erp.runDue', 'mpesa.checkPending']);
  });
});
