/**
 * [Backend Engineer + Ops] Phase 2 reconciliation classifier (REC-02/05). PURE: no I/O.
 *
 * Three balances are compared as MOVEMENTS since an approved baseline:
 *   bank (partner bank statement balance) = Fineract cash GL = platform records
 * The headline differences are explained item by item:
 *   bank vs platform     : statement lines matched to platform movements by bank reference
 *   fineract vs platform : platform movements whose ledger posting is pending / failed, unmatched receipts
 * Classification:
 *   timing      - expected to clear: credit on the as-of day not yet ingested, payout released within the
 *                 timing window (business days) not yet on the statement, ledger posting pending/retrying,
 *                 unmatched receipt within the window
 *   explained   - known non-platform items (bank charges/interest) or an item carried forward by an
 *                 approved resolution for the SAME amount
 *   unexplained - everything else, including any residual the items do not account for
 * Sign: a break's amount is its contribution to (bank - platform) or (fineract - platform).
 * Business days skip weekends AND Kenyan public holidays (Public Holidays Act, Cap. 110 + gazetted days) when
 * the API passes its calendar (go-live D-66, closes Q-G); without one, weekends only (pure unit tests).
 */
import { BusinessCalendar } from '@mapema/pricing';

export interface StatementLineIn { bankRef: string; valueDate: string; amountCents: bigint; type: 'credit' | 'debit' | 'return' | 'charge' | 'interest'; narrative?: string }
export interface PlatformItem { ref: string; date: string; amountCents: bigint; source: 'bank_transaction' | 'funding' | 'payout' | 'payout_return' }
export interface PendingPosting { ref: string; amountCents: bigint; state: 'pending' | 'retrying' | 'dead' | 'unmatched'; date?: string }
export interface CarryForward { itemKey: string; approvalId: string; amountCents: bigint }

export interface ReconInput {
  asOf: string;
  bankBalanceCents: bigint; fineractBalanceCents: bigint; platformBalanceCents: bigint;
  baseline: { bankCents: bigint; fineractCents: bigint; platformCents: bigint };
  statement: StatementLineIn[]; platformItems: PlatformItem[]; pendingPostings: PendingPosting[]; carryForward: CarryForward[];
  timingWindowBusinessDays: number;
  /** business-day calendar for the timing window (weekends + Kenyan public holidays in the API) */
  calendar?: BusinessCalendar;
}

export type Classification = 'timing' | 'explained' | 'unexplained';
export interface ClassifiedBreak {
  itemKey: string; kind: 'bank_vs_platform' | 'fineract_vs_platform'; classification: Classification; category: string;
  amountCents: bigint; ref?: string; expectedClearBy?: string; approvalId?: string; detail: string;
}
export interface ReconResult {
  movements: { bankCents: bigint; fineractCents: bigint; platformCents: bigint };
  differences: { bankVsPlatformCents: bigint; fineractVsPlatformCents: bigint; bankVsFineractCents: bigint };
  breaks: ClassifiedBreak[]; unexplainedCount: number; status: 'balanced' | 'explained' | 'breaks';
}

const WEEKENDS_ONLY = BusinessCalendar.weekendsOnly();
/** Business-day step on the given calendar (go-live: Kenyan public holidays, D-66; default weekends only). */
export function addBusinessDays(d: string, n: number, cal: BusinessCalendar = WEEKENDS_ONLY): string {
  return cal.addBusinessDays(d, n);
}

export function classifyRecon(i: ReconInput): ReconResult {
  const movements = {
    bankCents: i.bankBalanceCents - i.baseline.bankCents,
    fineractCents: i.fineractBalanceCents - i.baseline.fineractCents,
    platformCents: i.platformBalanceCents - i.baseline.platformCents,
  };
  const differences = {
    bankVsPlatformCents: movements.bankCents - movements.platformCents,
    fineractVsPlatformCents: movements.fineractCents - movements.platformCents,
    bankVsFineractCents: movements.bankCents - movements.fineractCents,
  };
  const cal = i.calendar ?? WEEKENDS_ONLY;
  const windowStart = addBusinessDays(i.asOf, -i.timingWindowBusinessDays, cal);
  const nextBiz = addBusinessDays(i.asOf, 1, cal);
  const cf = new Map(i.carryForward.map((c) => [c.itemKey, c]));
  const breaks: ClassifiedBreak[] = [];
  const add = (b: ClassifiedBreak) => {
    if (b.classification === 'unexplained') {
      const c = cf.get(b.itemKey);
      if (c && c.amountCents === b.amountCents) { b.classification = 'explained'; b.category = 'carried_forward'; b.approvalId = c.approvalId; b.detail = `${b.detail} (carried forward by approval)`; }
    }
    breaks.push(b);
  };

  // ---- bank vs platform: itemised by reference
  const plat = new Map<string, PlatformItem>();
  for (const p of i.platformItems) plat.set(p.ref, p);
  const seen = new Set<string>();
  for (const l of i.statement) {
    const p = plat.get(l.bankRef);
    if (p) {
      seen.add(l.bankRef);
      if (p.amountCents !== l.amountCents) add({ itemKey: `match:${l.bankRef}`, kind: 'bank_vs_platform', classification: 'unexplained', category: 'amount_mismatch', amountCents: l.amountCents - p.amountCents, ref: l.bankRef, detail: `bank ${l.amountCents} vs platform ${p.amountCents}` });
      continue;
    }
    const key = `bank:${l.bankRef}`;
    if (l.type === 'charge' || l.type === 'interest') add({ itemKey: key, kind: 'bank_vs_platform', classification: 'explained', category: l.type === 'charge' ? 'bank_charge' : 'bank_interest', amountCents: l.amountCents, ref: l.bankRef, detail: l.narrative ?? l.type });
    else if (l.amountCents > 0n && l.valueDate >= i.asOf) add({ itemKey: key, kind: 'bank_vs_platform', classification: 'timing', category: 'credit_not_yet_ingested', amountCents: l.amountCents, ref: l.bankRef, expectedClearBy: nextBiz, detail: `credit value ${l.valueDate} arrived after ingestion` });
    else add({ itemKey: key, kind: 'bank_vs_platform', classification: 'unexplained', category: 'unknown_bank_item', amountCents: l.amountCents, ref: l.bankRef, detail: `${l.type} ${l.valueDate} not in platform records` });
  }
  for (const p of i.platformItems) {
    if (seen.has(p.ref)) continue;
    const key = `platform:${p.ref}`;
    const inTransit = (p.source === 'payout') && p.date >= windowStart && p.date <= i.asOf;
    if (inTransit) add({ itemKey: key, kind: 'bank_vs_platform', classification: 'timing', category: 'payout_in_transit', amountCents: -p.amountCents, ref: p.ref, expectedClearBy: nextBiz, detail: `payout ${p.date} not yet on statement` });
    else add({ itemKey: key, kind: 'bank_vs_platform', classification: 'unexplained', category: 'missing_on_statement', amountCents: -p.amountCents, ref: p.ref, detail: `${p.source} ${p.date} not on bank statement` });
  }
  const bankItems = breaks.filter((b) => b.kind === 'bank_vs_platform').reduce((s, b) => s + b.amountCents, 0n);
  if (bankItems !== differences.bankVsPlatformCents) {
    add({ itemKey: 'residual:bank_vs_platform', kind: 'bank_vs_platform', classification: 'unexplained', category: 'unexplained_residual', amountCents: differences.bankVsPlatformCents - bankItems, detail: 'difference not accounted for by statement items' });
  }

  // ---- fineract vs platform
  for (const pp of i.pendingPostings) {
    const key = `ledger:${pp.ref}`;
    const amt = -pp.amountCents; // Fineract lacks it
    if (pp.state === 'dead') add({ itemKey: key, kind: 'fineract_vs_platform', classification: 'unexplained', category: 'ledger_posting_failed', amountCents: amt, ref: pp.ref, detail: 'ledger posting dead in outbox' });
    else if (pp.state === 'unmatched') {
      if ((pp.date ?? '') >= windowStart) add({ itemKey: key, kind: 'fineract_vs_platform', classification: 'timing', category: 'unmatched_receipt', amountCents: amt, ref: pp.ref, expectedClearBy: nextBiz, detail: 'receipt awaiting match; not yet in the ledger' });
      else add({ itemKey: key, kind: 'fineract_vs_platform', classification: 'unexplained', category: 'unmatched_receipt_aged', amountCents: amt, ref: pp.ref, detail: `receipt ${pp.date} unmatched beyond the timing window` });
    } else add({ itemKey: key, kind: 'fineract_vs_platform', classification: 'timing', category: 'ledger_posting_pending', amountCents: amt, ref: pp.ref, expectedClearBy: nextBiz, detail: `ledger posting ${pp.state}` });
  }
  const ledgerItems = breaks.filter((b) => b.kind === 'fineract_vs_platform').reduce((s, b) => s + b.amountCents, 0n);
  if (ledgerItems !== differences.fineractVsPlatformCents) {
    add({ itemKey: 'residual:fineract_vs_platform', kind: 'fineract_vs_platform', classification: 'unexplained', category: 'unexplained_residual', amountCents: differences.fineractVsPlatformCents - ledgerItems, detail: 'Fineract cash GL differs from platform records with no pending posting to explain it' });
  }

  const unexplainedCount = breaks.filter((b) => b.classification === 'unexplained').length;
  return { movements, differences, breaks, unexplainedCount, status: breaks.length === 0 ? 'balanced' : unexplainedCount === 0 ? 'explained' : 'breaks' };
}
