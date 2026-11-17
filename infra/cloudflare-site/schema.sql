-- D1 database "mapema-site": submissions from the public website forms.
CREATE TABLE IF NOT EXISTS call_requests (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, contact_name TEXT NOT NULL, company TEXT NOT NULL, email TEXT NOT NULL,
  phone TEXT, role TEXT NOT NULL CHECK (role IN ('buyer','supplier')), privacy_notice_version TEXT NOT NULL, lang TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS data_requests (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, email TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('access','correction','deletion','objection','portability','restriction')),
  details TEXT, privacy_notice_version TEXT NOT NULL, lang TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new');
