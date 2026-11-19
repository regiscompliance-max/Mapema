// [Backend Engineer] Movable Property Security Rights registry — portal-only (D-73).
// There is no invented search or filing API. Mock mode returns deterministic results for tests.
// Sandbox and live are a manual stub: staff upload a certificate from the official portal.

import { AdapterContext, AdapterMode, HealthCheck } from './common';

export interface RegistrySearchRequest {
  supplierKraPin: string;
  buyerKraPin: string;
  invoiceNumber: string;
  amountCents: bigint;
  issueDate: string;
}

export interface RegistrySearchResult {
  result: 'clear' | 'conflict' | 'unavailable';
  reasons: string[];
}

export interface Registry {
  readonly name: string;
  health(ctx?: AdapterContext): Promise<HealthCheck>;
  /** Informational only. Funding always requires a staff-uploaded certificate. */
  search(ctx: AdapterContext, req: RegistrySearchRequest): Promise<RegistrySearchResult>;
}

/** Mock: PIN starting P099 is a conflict so tests can exercise the waiver path. Everything else is clear. */
export class MockRegistry implements Registry {
  readonly name = 'mock-registry';
  async health(): Promise<HealthCheck> {
    return { provider: 'registry-mock', mode: 'mock', ok: true, detail: 'portal-only mock; no invented API' };
  }
  async search(_ctx: AdapterContext, req: RegistrySearchRequest): Promise<RegistrySearchResult> {
    if (req.supplierKraPin.toUpperCase().startsWith('P099')) {
      return { result: 'conflict', reasons: ['MOCK_PRIOR_FILING'] };
    }
    return { result: 'clear', reasons: [] };
  }
}

/** No network, no invented API. Used for sandbox and live until an official interface exists. */
export class ManualRegistry implements Registry {
  readonly name: string;
  constructor(private readonly mode: Exclude<AdapterMode, 'mock'>) {
    this.name = `manual-registry-${mode}`;
  }
  async health(): Promise<HealthCheck> {
    return { provider: 'registry-manual', mode: this.mode, ok: true, detail: 'portal-only: upload a search certificate; no registry API' };
  }
  async search(): Promise<RegistrySearchResult> {
    return { result: 'unavailable', reasons: ['PORTAL_ONLY'] };
  }
}
