/**
 * [Backend Engineer] Deterministic renderers (RPT-02..04): pure functions of (snapshot data, template).
 * No clocks, no randomness, no locale-dependent formatting -> byte-identical output for the same input.
 */
import { createHash } from 'node:crypto';
import { FileMapping, Fmt, PackMapping, ReturnMapping } from './templates';

export const DRAFT_BANNER = 'DRAFT - ASSUMED LAYOUT - NOT AN OFFICIAL CBK FORMAT - DO NOT SUBMIT';
export const CRB_DRAFT_BANNER = 'DRAFT - ASSUMED LAYOUT - NOT AN OFFICIAL CRB SUBMISSION FORMAT - DO NOT SUBMIT';

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Canonical JSON: recursively sorted keys (jsonb reorders keys, so hashes use this form). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export function get(obj: any, path: string): unknown {
  return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

export function kesDecimal(cents: string | bigint): string {
  const c = BigInt(cents);
  const neg = c < 0n; const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

export function fmt(v: unknown, f: Fmt): string {
  if (v === undefined || v === null || v === '') return f === 'kes' ? '0.00' : f === 'int' ? '0' : '';
  switch (f) {
    case 'kes': return kesDecimal(String(v));
    case 'int': return String(BigInt(String(v)));
    case 'pct_bps': { const b = BigInt(String(v)); return `${b / 100n}.${String(b % 100n).padStart(2, '0')}`; }
    default: return String(v);
  }
}

export function csvCell(s: string): string {
  const t = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s; // CSV injection guard (formula prefix)
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
const row = (cells: string[]) => cells.map(csvCell).join(',');

export interface TemplateMeta { kind: string; version: string; status: 'assumed_draft' | 'official'; sourceRef: string }
const meta = (m: TemplateMeta, snap: { period: string; version: number; sha256: string }) =>
  `# template=${m.kind} ${m.version} status=${m.status} source="${m.sourceRef}"; snapshot=${snap.period} v${snap.version} sha256=${snap.sha256}`;

export function renderReturnCsv(data: any, mapping: ReturnMapping, m: TemplateMeta, snap: { period: string; version: number; sha256: string }, banner = DRAFT_BANNER): string {
  const lines: string[] = [];
  if (m.status === 'assumed_draft') lines.push(`# ${banner}`);
  lines.push(meta(m, snap));
  lines.push(row(['section', 'code', 'label', 'value']));
  for (const f of mapping.fields) lines.push(row([f.section, f.code, f.label, fmt(get(data, f.path), f.format)]));
  return `${lines.join('\n')}\n`;
}

export function renderFileCsv(data: any, records: any[], mapping: FileMapping, m: TemplateMeta, snap: { period: string; version: number; sha256: string }): string {
  const lines: string[] = [];
  if (m.status === 'assumed_draft') lines.push(`# ${CRB_DRAFT_BANNER}`);
  lines.push(meta(m, snap));
  lines.push(row(mapping.columns.map((c) => c.name)));
  for (const r of records) lines.push(row(mapping.columns.map((c) => c.const ?? fmt(c.path?.startsWith('$.') ? get(data, c.path.slice(2)) : get(r, c.path ?? ''), c.format))));
  return `${lines.join('\n')}\n`;
}

export function renderTapeCsv(data: any, mapping: PackMapping, snap: { period: string; version: number; sha256: string }): string {
  const lines = [`# Mapema lender pack loan tape ${snap.period} (snapshot v${snap.version} sha256=${snap.sha256}); amounts KES`, row(mapping.tapeColumns.map((c) => c.name))];
  for (const l of data.loans) lines.push(row(mapping.tapeColumns.map((c) => fmt(get(l, c.path ?? ''), c.format))));
  return `${lines.join('\n')}\n`;
}

/** Multi-page PDF 1.4, Helvetica, uncompressed text. Deterministic (no CreationDate / ID). */
export function pdfDocument(title: string, lines: string[], perPage = 46): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (x) => `\\${x}`).replace(/[^\x20-\x7e]/g, '?');
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += perPage) pages.push(lines.slice(i, i + perPage));
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids: number[] = [];
  pages.forEach((pl, pi) => {
    const text = [`BT /F1 13 Tf 50 800 Td (${esc(title)}) Tj ET`, `BT /F1 8 Tf 450 20 Td (Page ${pi + 1} of ${pages.length}) Tj ET`,
      ...pl.map((l, i) => `BT /F1 9 Tf 50 ${775 - i * 16} Td (${esc(l)}) Tj ET`)].join('\n');
    objs.push(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
    const contentNo = objs.length;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentNo} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(objs.length);
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function lenderPackLines(data: any, mapping: PackMapping, snap: { period: string; version: number; sha256: string }): string[] {
  const L: string[] = [];
  L.push(`Period ${data.period} - month end ${data.asOfDate} - snapshot v${snap.version}`);
  L.push(`Snapshot SHA-256 ${snap.sha256}`);
  L.push(`Lender: ${data.lender.name} (${data.lender.licence}). All amounts KES. Generated from system data only; no manual edits.`);
  let section = '';
  for (const f of mapping.summary) {
    if (f.section !== section) { section = f.section; L.push(''); L.push(section.toUpperCase()); }
    L.push(`  ${f.label}: ${fmt(get(data, f.path), f.format)}${f.format === 'pct_bps' ? '%' : ''}`);
  }
  L.push(''); L.push('CONCENTRATION AT MONTH END (exposure / cap)');
  for (const k of ['buyers', 'suppliers', 'sectors'] as const) {
    for (const c of data.aggregates.concentration[k]) L.push(`  ${k.slice(0, -1)} ${c.name}: ${kesDecimal(c.exposureCents)} of ${kesDecimal(c.capCents)} (${fmt(c.usedBps, 'pct_bps')}% of cap)`);
  }
  L.push(''); L.push('LOANS (invoice | due | principal | outstanding | DPD | status)');
  for (const l of data.loans) L.push(`  ${l.invoiceNumber} | ${l.dueDate} | ${kesDecimal(l.principalCents)} | ${kesDecimal(l.outstandingPrincipalCents)} | ${l.dpd} | ${l.statusAtMonthEnd}`);
  return L;
}
