import { Body } from '@/components/page';
export default function Page() {
  return (
    <Body narrow><article className="prose-legal space-y-4">
      <p className="rounded-lg border border-sun/40 bg-sun-soft p-4 text-sm text-ink">DRAFT summary of terms (MA-2026-11-v1). The signed Master Receivables Purchase Agreement and Deed of Assignment govern. Wording subject to Kenyan counsel review before launch.</p>
      <h1 className="h1">Terms in plain language</h1>
      <ul className="list-disc space-y-2 pl-6">
        <li>When you accept an offer, you assign the whole invoice to a partner bank, which is the lender. Mapema is the technology provider and is not yet licensed.</li>
        <li>A partner bank pays you the advance shown in the offer. When your buyer pays, you receive the balance of the price within 1 business day.</li>
        <li>The discount fee is interest on the advance for the days it is outstanding, charged by a partner bank. The quoted fee is the maximum. If your buyer pays early, you pay less.</li>
        <li>The processing fee is 0.5% of the invoice, at least KES 1,500 and at most KES 5,000, taken at funding and charged by a partner bank. On some programmes the buyer pays this fee instead of the supplier.</li>
        <li>Payments are applied in this order: the advance, then fees, then interest.</li>
        <li>If your buyer has not paid 30 days after the due date, a partner bank may ask you to repay the advance (recourse).</li>
        <li>There are no late fees in this version of the service.</li>
      </ul>
    </article></Body>
  );
}
