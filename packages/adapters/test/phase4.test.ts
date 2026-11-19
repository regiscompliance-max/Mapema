import { describe, expect, it } from 'vitest';
import { createAdapters, ManualRegistry, MockRegistry } from '../src';

const ctx = { requestId: 't' };
const req = { supplierKraPin: 'P051111111B', buyerKraPin: 'P051234567A', invoiceNumber: 'INV-1', amountCents: 100n, issueDate: '2027-01-01' };

describe('P4-1 registry adapter is portal-only (no invented API)', () => {
  it('mock: clear for ordinary PINs, conflict for P099*', async () => {
    const r = new MockRegistry();
    expect((await r.health()).ok).toBe(true);
    expect((await r.health()).detail).toMatch(/no invented API/);
    expect(await r.search(ctx, req)).toEqual({ result: 'clear', reasons: [] });
    expect(await r.search(ctx, { ...req, supplierKraPin: 'P099000001Z' })).toEqual({ result: 'conflict', reasons: ['MOCK_PRIOR_FILING'] });
  });
  it('sandbox and live are a manual stub that never calls a network', async () => {
    for (const mode of ['sandbox', 'live'] as const) {
      const r = new ManualRegistry(mode);
      const h = await r.health();
      expect(h.ok).toBe(true);
      expect(h.detail).toMatch(/portal-only/);
      expect(await r.search()).toEqual({ result: 'unavailable', reasons: ['PORTAL_ONLY'] });
    }
  });
  it('createAdapters wires mock by default and ManualRegistry otherwise', () => {
    expect(createAdapters({ APP_ENV: 'test' }).registry).toBeInstanceOf(MockRegistry);
    expect(createAdapters({ APP_ENV: 'test', ADAPTER_MODE_REGISTRY: 'sandbox' }).registry).toBeInstanceOf(ManualRegistry);
    expect(() => createAdapters({ APP_ENV: 'production', ADAPTER_MODE_REGISTRY: 'mock' })).toThrow(/not allowed in production/);
  });
});
