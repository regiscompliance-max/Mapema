-- [Backend Engineer] Phase 4 security (D-73..D-80): MPSRA registry evidence, eTIMS CU uniqueness,
-- similar-invoice review flag, goods-received attestation, government-payer credit-file flag.
SET search_path = mapema, public;

ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'registry_search';
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'registry_filing';
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'etims_override';

ALTER TYPE mapema.doc_type ADD VALUE IF NOT EXISTS 'registry_search_certificate';
ALTER TYPE mapema.doc_type ADD VALUE IF NOT EXISTS 'registry_filing_evidence';

-- Official e-invoice identifier is unique when present (D-74).
CREATE UNIQUE INDEX IF NOT EXISTS invoice_etims_cu_uidx
  ON invoice (upper(btrim(etims_cu_invoice_no)))
  WHERE etims_cu_invoice_no IS NOT NULL AND btrim(etims_cu_invoice_no) <> '';

ALTER TABLE invoice
  ADD COLUMN IF NOT EXISTS similar_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS similar_invoice_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS goods_received boolean,
  ADD COLUMN IF NOT EXISTS goods_received_note text;

ALTER TABLE invoice_decision
  ADD COLUMN IF NOT EXISTS goods_received boolean,
  ADD COLUMN IF NOT EXISTS goods_received_note text,
  ADD COLUMN IF NOT EXISTS po_reference text;

ALTER TABLE organisation
  ADD COLUMN IF NOT EXISTS government_payer_dependent boolean,
  ADD COLUMN IF NOT EXISTS government_payer_note text,
  ADD COLUMN IF NOT EXISTS government_payer_set_by uuid REFERENCES user_account(id),
  ADD COLUMN IF NOT EXISTS government_payer_set_at timestamptz;

ALTER TABLE advance
  ADD COLUMN IF NOT EXISTS registry_registration_no text,
  ADD COLUMN IF NOT EXISTS registry_filing_id uuid;

CREATE TABLE registry_search (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id              uuid NOT NULL REFERENCES invoice(id),
  supplier_id             uuid NOT NULL REFERENCES organisation(id),
  buyer_id                uuid NOT NULL REFERENCES organisation(id),
  result                  text NOT NULL CHECK (result IN ('clear', 'conflict', 'conflict_waived')),
  evidence_document_id    uuid NOT NULL REFERENCES document(id),
  notes                   text,
  searched_on             date NOT NULL,
  adapter_result          jsonb,
  status                  text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  proposed_via            uuid REFERENCES approval_request(id),
  approved_via            uuid REFERENCES approval_request(id),
  created_by              uuid NOT NULL REFERENCES user_account(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (result <> 'conflict_waived' OR (notes IS NOT NULL AND length(btrim(notes)) >= 3))
);
CREATE UNIQUE INDEX registry_search_one_approved ON registry_search (invoice_id) WHERE status = 'approved';
CREATE INDEX registry_search_invoice_idx ON registry_search (invoice_id, status);

CREATE TABLE registry_filing (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id              uuid NOT NULL REFERENCES advance(id),
  invoice_id              uuid NOT NULL REFERENCES invoice(id),
  registration_no         text NOT NULL CHECK (length(btrim(registration_no)) BETWEEN 3 AND 80),
  evidence_document_id    uuid NOT NULL REFERENCES document(id),
  notes                   text,
  filed_on                date NOT NULL,
  status                  text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  proposed_via            uuid REFERENCES approval_request(id),
  approved_via            uuid REFERENCES approval_request(id),
  created_by              uuid NOT NULL REFERENCES user_account(id),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX registry_filing_one_approved ON registry_filing (advance_id) WHERE status = 'approved';
ALTER TABLE advance ADD CONSTRAINT advance_registry_filing_fk FOREIGN KEY (registry_filing_id) REFERENCES registry_filing(id);

CREATE TABLE ops_task (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('registry_filing_due')),
  advance_id   uuid NOT NULL REFERENCES advance(id),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  due_date     date,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  done_by      uuid REFERENCES user_account(id),
  done_at      timestamptz,
  UNIQUE (kind, advance_id),
  CHECK ((status = 'done') = (done_at IS NOT NULL))
);
CREATE INDEX ops_task_open ON ops_task (status, kind);

GRANT SELECT, INSERT, UPDATE ON registry_search, registry_filing, ops_task TO mapema_app;
GRANT SELECT ON registry_search, registry_filing, ops_task TO mapema_readonly;
