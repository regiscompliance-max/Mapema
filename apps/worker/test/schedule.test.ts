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
});
