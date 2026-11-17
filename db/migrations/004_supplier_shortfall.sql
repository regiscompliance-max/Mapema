-- [Backend Engineer + Compliance & Risk Analyst] Phase 1b: buyer underpayment shortfall (D-22).
-- When the buyer pays less than the invoice, Mapema is repaid first (principal -> fees -> interest);
-- the gap between the invoice and everything the buyer paid is still owed by the BUYER to the SUPPLIER.
-- Mapema does not chase it (the receivable beyond the advance belongs to the supplier); it records it,
-- tells both sides, and passes any later buyer top-up straight through to the supplier.
SET search_path = mapema, public;
CREATE TABLE supplier_shortfall (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id      uuid NOT NULL UNIQUE REFERENCES advance(id),
  invoice_id      uuid NOT NULL REFERENCES invoice(id),
  buyer_id        uuid NOT NULL REFERENCES organisation(id),
  supplier_id     uuid NOT NULL REFERENCES organisation(id),
  original_cents  bigint NOT NULL CHECK (original_cents > 0),
  amount_cents    bigint NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= original_cents),
  currency        char(3) NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','recovered_directly','forgiven')),
  closed_by       uuid REFERENCES user_account(id),
  close_note      text,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'open' OR amount_cents > 0),
  CHECK (status <> 'settled' OR amount_cents = 0)
);
CREATE INDEX supplier_shortfall_supplier ON supplier_shortfall (supplier_id, status);
CREATE INDEX supplier_shortfall_buyer ON supplier_shortfall (buyer_id, status);
GRANT SELECT, INSERT, UPDATE ON supplier_shortfall TO mapema_app;
GRANT SELECT ON supplier_shortfall TO mapema_readonly;
