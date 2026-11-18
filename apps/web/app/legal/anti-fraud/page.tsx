export default function Page() {
  return (
    <article className="prose max-w-none space-y-4">
      <p className="rounded bg-amber-50 p-3 text-sm">DRAFT anti-fraud notice (version AFN-2026-11-v1). Must be reviewed by Kenyan counsel before it is published. This page is in the application so the wording can be checked; it is not a live marketing publication and does not change Mapema&apos;s licensing status.</p>
      <h1 className="h1">How Mapema checks invoices and pays suppliers early</h1>
      <p>Mapema is a buyer-led early-payment service. A supplier is paid early only after the buyer has confirmed the invoice and signed an irrevocable undertaking to pay Mapema in full on the due date. Mapema is not yet licensed by the Central Bank of Kenya as a non-deposit-taking credit provider. We do not provide credit until we are licensed.</p>
      <h2 className="h2">What we check before money moves</h2>
      <ul className="list-disc pl-5">
        <li>The invoice is validated against KRA eTIMS (the official electronic tax invoice). If eTIMS is unavailable, the invoice cannot proceed to funding until a credit officer records a documented override, approved by a second person.</li>
        <li>The same supplier KRA PIN and invoice number cannot be submitted twice. Similar invoices (same supplier, amount and date, different number) are flagged for review.</li>
        <li>The buyer checker attests that the goods or services have been received, or records a reason for confirming without receipt (for example a contractual milestone), and may add a purchase-order or goods-received note reference.</li>
        <li>Before funding, credit officers search the Movable Property Security Rights registry (Office of the Registrar of Security Rights) and upload the search certificate. A second person must approve the search. After funding, the assignment is filed and the registration number is stored.</li>
        <li>Both the buyer and the supplier are notified when an invoice is submitted.</li>
      </ul>
      <h2 className="h2">If something looks wrong</h2>
      <p>If you did not authorise an invoice, or you suspect a duplicate or fraudulent invoice, contact us immediately through the complaints page or your Mapema relationship contact. Do not pay anyone other than the Mapema collection account named on the notice of assignment.</p>
      <p>This notice is a draft. It will be published on the public site only after counsel review. Until then, Mapema remains not yet licensed.</p>
    </article>
  );
}
