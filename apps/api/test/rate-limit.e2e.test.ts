/**
 * [Security Engineer + DevOps] Phase 1b: the rate limiter is shared through Postgres, so limits hold
 * across API instances (previously each instance counted on its own, multiplying the limit).
 *  TC-RL-01 two API instances on one database share the public leads limit (5/min)
 *  TC-RL-02 a different client IP has its own budget
 *  TC-RL-03 RATE_LIMIT_STORE=memory keeps the old per-instance behaviour (local fallback)
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/common/config';
import { Harness, startHarness } from './harness';

let h: Harness; let second: INestApplication; let memA: INestApplication; let memB: INestApplication;
const lead = (i: number) => ({ contactName: `Ann ${i}`, company: 'Delta', email: `ann${i}@delta.test`, phone: '+254722000111', role: 'buyer', privacyNoticeAccepted: true });
beforeAll(async () => {
  h = await startHarness();
  second = await createApp(loadConfig(h.env), { adapters: h.adapters }, { logger: false });
  memA = await createApp(loadConfig({ ...h.env, RATE_LIMIT_STORE: 'memory' }), { adapters: h.adapters }, { logger: false });
  memB = await createApp(loadConfig({ ...h.env, RATE_LIMIT_STORE: 'memory' }), { adapters: h.adapters }, { logger: false });
});
afterAll(async () => { await second?.close(); await memA?.close(); await memB?.close(); await h?.close(); });

describe('shared rate limiter', () => {
  it('TC-RL-01 instances A and B share one budget: the 6th lead within a minute is refused, whichever instance gets it', async () => {
    const b = request(second.getHttpServer());
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await h.http.post('/v1/public/leads').send(lead(i))).status);
    for (let i = 3; i < 5; i++) codes.push((await b.post('/v1/public/leads').send(lead(i))).status);
    expect(codes).toEqual([201, 201, 201, 201, 201]);
    const sixth = await b.post('/v1/public/leads').send(lead(6));
    expect(sixth.status).toBe(429);
    expect((await h.http.post('/v1/public/leads').send(lead(7))).status).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();
  });

  it('TC-RL-02 another client IP is unaffected', async () => {
    // trust proxy = 1, so X-Forwarded-For from the (trusted) load balancer sets req.ip
    const r = await h.http.post('/v1/public/leads').set('X-Forwarded-For', '203.0.113.9').send(lead(8));
    expect(r.status).toBe(201);
  });

  it('TC-RL-03 memory store: each instance counts alone (documents why Postgres is the default)', async () => {
    const a = request(memA.getHttpServer()); const b = request(memB.getHttpServer());
    const ip = '198.51.100.7';
    for (let i = 0; i < 5; i++) expect((await a.post('/v1/public/leads').set('X-Forwarded-For', ip).send(lead(20 + i))).status).toBe(201);
    expect((await a.post('/v1/public/leads').set('X-Forwarded-For', ip).send(lead(30))).status).toBe(429);
    expect((await b.post('/v1/public/leads').set('X-Forwarded-For', ip).send(lead(31))).status).toBe(201);
  });
});
