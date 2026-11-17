import { Body } from '@/components/page';
export default function Page() {
  return (
    <Body narrow><article className="prose-legal space-y-4">
      <p className="rounded-lg border border-brass/40 bg-ivory p-4 text-sm text-body">DRAFT summary of terms (MA-2026-11-v1). The signed Master Receivables Purchase Agreement and Deed of Assignment govern. Wording subject to Kenyan counsel review before launch.</p>
      <h1 className="h1 text-navy">Terms in plain language</h1>
      <ul className="list-disc space-y-2 pl-6">
        <li>When you accept an offer, you assign the whole invoice to Mapema.</li>
        <li>Mapema pays you the advance shown in the offer. When your buyer pays, Mapema pays you the balance of the price within 1 business day.</li>
        <li>The discount fee is interest on the advance for the days it is outstanding. The quoted fee is the maximum. If your buyer pays early, you pay less.</li>
        <li>The verification fee is fixed per invoice.</li>
        <li>Payments are applied in this order: the advance, then fees, then interest.</li>
        <li>If your buyer has not paid 30 days after the due date, Mapema may ask you to repay the advance (recourse).</li>
        <li>Mapema charges no late fees in this version of the service.</li>
      </ul>
    </article></Body>
  );
}
