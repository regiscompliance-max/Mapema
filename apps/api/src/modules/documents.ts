/**
 * [Backend Engineer + Security Engineer] Documents: type/size allow-list, malware scan hook,
 * SHA-256, encrypted storage; signed documents are written once (WORM).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { StorageAdapter } from '@mapema/adapters';
import { STORAGE } from '../common/config';
import { FieldCrypto } from '../common/crypto';
import { Q } from '../common/db';
import { unprocessable } from '../common/errors';

const MIME_ALLOW = new Set(['application/pdf', 'image/jpeg', 'image/png', 'text/csv', 'text/plain']);
const MAX_BYTES = 10 * 1024 * 1024;
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const WORM_TYPES = new Set(['programme_agreement', 'master_agreement', 'deed_of_assignment', 'ilu', 'notice_of_assignment', 'receipt', 'cbk_approval_letter', 'credit_report', 'registry_search_certificate', 'registry_filing_evidence']);

/** Magic-byte sniffing so the declared MIME type can't lie. */
function sniff(body: Buffer): string | null {
  if (body.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if (body[0] === 0xff && body[1] === 0xd8) return 'image/jpeg';
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (!body.subarray(0, 512).some((b) => b === 0)) return 'text/plain';
  return null;
}

@Injectable()
export class DocumentsService {
  constructor(@Inject(STORAGE) private readonly storage: StorageAdapter) {}

  async store(q: Q, d: { ownerOrgId?: string | null; ownerPersonId?: string | null; type: string; fileName: string; mimeType: string; body: Buffer; uploadedBy?: string | null; signedAt?: string | null; envelopeId?: string | null; containsPii?: boolean }) {
    if (!MIME_ALLOW.has(d.mimeType)) throw unprocessable('FILE_TYPE', 'Only PDF, JPEG, PNG or CSV files are accepted');
    if (d.body.length === 0 || d.body.length > MAX_BYTES) throw unprocessable('FILE_SIZE', 'Files must be between 1 byte and 10 MB');
    const sniffed = sniff(d.body);
    const textual = d.mimeType === 'text/csv' || d.mimeType === 'text/plain';
    if (!(sniffed === d.mimeType || (textual && sniffed === 'text/plain'))) throw unprocessable('FILE_TYPE_MISMATCH', 'File content does not match its type');
    // Malware scan hook: Phase 1 detects the EICAR test signature only; ClamAV/provider scan is a go-live item.
    if (d.body.includes(Buffer.from(EICAR))) throw unprocessable('FILE_INFECTED', 'The file failed the security scan');
    const sha = FieldCrypto.sha256(d.body);
    const bucket = WORM_TYPES.has(d.type) ? 'mapema-signed' : 'mapema-docs';
    const key = `${d.ownerOrgId ?? 'platform'}/${d.type}/${sha.slice(0, 16)}-${Date.now()}`;
    await this.storage.put(bucket, key, d.body, { worm: bucket === 'mapema-signed' });
    const r = await q.query(
      `INSERT INTO document (owner_org_id, owner_person_id, type, file_name, mime_type, size_bytes, file_sha256, storage_bucket, storage_key, scan_status, contains_pii, signed_at, esign_envelope_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'clean',$10,$11,$12,$13) RETURNING id, type, file_name, file_sha256, created_at`,
      [d.ownerOrgId ?? null, d.ownerPersonId ?? null, d.type, d.fileName.slice(0, 200), d.mimeType, d.body.length, sha, bucket, key, d.containsPii ?? true, d.signedAt ?? null, d.envelopeId ?? null, d.uploadedBy ?? null],
    );
    return r.rows[0] as { id: string; file_sha256: string };
  }

  async read(q: Q, id: string): Promise<{ meta: any; body: Buffer }> {
    const meta = (await q.query(`SELECT * FROM document WHERE id = $1`, [id])).rows[0];
    if (!meta) throw unprocessable('NOT_FOUND', 'document not found');
    return { meta, body: await this.storage.get(meta.storage_bucket, meta.storage_key) };
  }
}

/** Minimal valid one-page PDF with text lines (agreements, ILUs, notices, receipts). */
export function simplePdf(title: string, lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (m) => `\\${m}`).replace(/[^\x20-\x7e]/g, '?');
  const text = [title, '', ...lines].map((l, i) => `BT /F1 ${i === 0 ? 14 : 10} Tf 50 ${780 - i * 16} Td (${esc(l)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
