#!/usr/bin/env node
/**
 * [Technical Writer + Backend Engineer] Generates openapi/openapi.yaml for the API AS IMPLEMENTED by
 * reading the Nest controllers (routes, auth, roles, step-up, idempotency, request body fields from the
 * inline zod schemas). The zod schemas in code remain authoritative for exact validation rules; this file
 * keeps the published contract in step with the code. Run: node scripts/gen-openapi.mjs && npm run lint:openapi
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'apps/api/src/modules');
const ROLE_SETS = { STAFF_ROLES: ['credit', 'ops', 'compliance', 'admin', 'ceo'], BUYER_ROLES: ['buyer_admin', 'buyer_maker', 'buyer_checker'], SUPPLIER_ROLES: ['supplier_admin', 'supplier_user'] };
const TAGS = {
  public: ['Public', 'Unauthenticated marketing-site endpoints: health, fee calculator, leads, CBK licence statement.'],
  onboarding: ['Onboarding', 'Organisations, people, KYC/KYB, CRB, bank accounts with call-back verification, agreements, invitations, consents.'],
  invoices: ['Invoices', 'Invoice capture (form/CSV), eTIMS validation, buyer maker-checker, ILU confirmations, payment calendar.'],
  advances: ['Advances', 'Quote with full disclosure, acceptance, credit decision, release (limits re-checked at release).'],
  payments: ['Payments', 'Bank webhooks/statements, matching, CBK-order allocation (principal, fees, interest), supplier balance payouts.'],
  approvals: ['Approvals', 'Maker-checker approval requests (a different person approves).'],
  admin: ['Admin', 'Settings, adapters, lending switch, pricing versions with CBK approval reference, float, limits.'],
  ops: ['Operations', 'Late ladder, recourse, collections, disputes, complaints, data-subject requests, AML review, reconciliation, funding.'],
  reports: ['Reports and audit', 'Current user, dashboard, portfolio, hash-chained audit log, export, Fineract trial balance.'],
  dev: ['Development only', 'Mounted only when DEV_IDP_ENABLED=true and APP_ENV is development or test. Never in staging or production.'],
};
const SUMMARIES = {
  'POST /v1/invoices/{id}/quote': 'Quote an advance with full disclosure (stored; must be accepted before it expires)',
  'POST /v1/advances': 'Accept one or more disclosures (Idempotency-Key required)',
  'POST /v1/advances/{id}/decision': 'Credit decision (approve/decline); re-runs limit checks under a lock',
  'POST /v1/advances/{id}/release': 'Release the advance payout (ops, step-up, different person from the approver)',
  'POST /v1/webhooks/bank': 'Bank credit notification (HMAC signature over the raw body)',
  'POST /v1/payouts/{id}/release': 'Release a proposed supplier balance payout (ops, step-up)',
  'POST /v1/admin/pricing-versions/{id}/activate': 'Propose activating a pricing version; needs a CBK approval reference and a second approver',
  'POST /v1/admin/lending/enable': 'Propose switching lending on with the CBK licence number (second-person approval)',
  'POST /v1/admin/lending/disable': 'Switch lending off immediately',
  'GET /v1/audit/verify': 'Verify the audit log hash chain',
};

const ops = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
  const mod = f.replace('.ts', '');
  const src = readFileSync(join(dir, f), 'utf8');
  const lines = src.split('\n');
  let prefix = null, classPublic = false, classRoles = null, pending = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].trim();
    const ctl = L.match(/^@Controller\((?:'([^']*)')?\)/);
    if (ctl) { prefix = ctl[1] ?? ''; classPublic = pending.includes('@Public') ; classRoles = null; pending = []; 
      for (let j = i + 1; j < i + 3; j++) if (/^@Public\(\)/.test(lines[j].trim())) classPublic = true;
      continue; }
    if (prefix === null) continue;
    const decs = [...L.matchAll(/@(Get|Post|Put|Patch|Delete|Roles|Public|StepUp|Throttle)\(([^)]*)\)/g)];
    if (decs.length) pending.push(...decs.map((d) => ({ k: d[1], a: d[2] })));
    const sig = L.replace(/@\w+\([^)]*\)\s*/g, '').match(/^(?:async\s+)?(\w+)\(/);
    const http = pending.find((d) => ['Get', 'Post', 'Put', 'Patch', 'Delete'].includes(d.k));
    if (sig && http && !['if', 'for', 'return'].includes(sig[1])) {
      const sub = (http.a.match(/'([^']*)'/) ?? [, ''])[1];
      const path = '/v1/' + [prefix, sub].filter(Boolean).join('/').replace(/:(\w+)/g, '{$1}');
      const body = lines.slice(i, i + 8).join(' ');
      const roles = pending.filter((d) => d.k === 'Roles').flatMap((d) => d.a.split(',').map((s) => s.trim())).flatMap((r) => r.startsWith('...') ? ROLE_SETS[r.slice(3)] ?? [] : [r.replace(/'/g, '')]).filter(Boolean);
      const isPublic = classPublic || pending.some((d) => d.k === 'Public');
      const stepUp = pending.some((d) => d.k === 'StepUp');
      const idem = /@Headers\('idempotency-key'\)/.test(body);
      const hasBody = /@Body\(\)/.test(body);
      const queries = [...body.matchAll(/@Query\('(\w+)'\)/g)].map((m) => m[1]);
      const qObj = body.match(/z\.object\(\{([^}]*)\}\)\.parse\(q\)/);
      if (qObj) queries.push(...[...qObj[1].matchAll(/(\w+):\s*z/g)].map((m) => m[1]));
      let fields = [];
      const zo = body.match(/z\.object\(\{(.*?)\}\)\s*(?:\.refine\(.*?\))?\s*\.parse\(b/);
      if (hasBody && zo) {
        let depth = 0, cur = '', parts = [];
        for (const ch of zo[1]) { if ('({['.includes(ch)) depth++; if (')}]'.includes(ch)) depth--; if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch; }
        parts.push(cur);
        fields = parts.map((p) => p.trim()).filter(Boolean).map((p) => { const m = p.match(/^(\w+):\s*(.*)$/); return m && { name: m[1], optional: /\.optional\(\)|\.default\(|\.nullable\(\)/.test(m[2]), def: m[2] }; }).filter(Boolean);
      }
      ops.push({ mod, method: http.k.toLowerCase(), path, name: sig[1], roles, isPublic, stepUp, idem, hasBody, queries, fields });
      pending = [];
    } else if (sig && !http) pending = [];
  }
}

const typeOf = (def) => {
  if (/zPositiveCents|Cents|amountCents/.test(def)) return { type: 'string', pattern: '^[0-9]+$', description: 'KES integer cents as a decimal string' };
  if (/z\.boolean|z\.literal\(true/.test(def)) return { type: 'boolean' };
  if (/z\.number|z\.coerce\.number/.test(def)) return { type: 'integer' };
  if (/z\.array/.test(def)) return { type: 'array', items: { type: 'string' } };
  if (/z\.record|z\.object/.test(def)) return { type: 'object' };
  const en = def.match(/z\.enum\(\[([^\]]*)\]/); if (en) return { type: 'string', enum: en[1].split(',').map((s) => s.trim().replace(/'/g, '')) };
  if (/zDate/.test(def)) return { type: 'string', format: 'date' };
  if (/zUuid|zOrgId/.test(def)) return { type: 'string', format: 'uuid' };
  if (/email\(\)/.test(def)) return { type: 'string', format: 'email' };
  return { type: 'string' };
};

const y = (v, ind = 0) => {
  const pad = ' '.repeat(ind);
  if (Array.isArray(v)) return v.length ? v.map((x) => typeof x === 'object' ? `${pad}- ${y(x, ind + 2).trimStart()}` : `${pad}- ${JSON.stringify(x)}`).join('\n') : `${pad}[]`;
  return Object.entries(v).map(([k, x]) => {
    const key = /^[A-Za-z_][\w-]*$/.test(k) ? k : JSON.stringify(k);
    if (x !== null && typeof x === 'object') return (Array.isArray(x) && !x.length) || (!Array.isArray(x) && !Object.keys(x).length) ? `${pad}${key}: ${Array.isArray(x) ? '[]' : '{}'}` : `${pad}${key}:\n${y(x, ind + 2)}`;
    return `${pad}${key}: ${JSON.stringify(x)}`;
  }).join('\n');
};

const paths = {};
const usedIds = new Set();
for (const o of ops.sort((a, b) => a.path.localeCompare(b.path))) {
  let id = `${o.mod}_${o.name}`; while (usedIds.has(id)) id += '_'; usedIds.add(id);
  const key = `${o.method.toUpperCase()} ${o.path}`;
  const desc = [o.isPublic ? 'Public (no token).' : `Roles: ${o.roles.length ? o.roles.join(', ') : 'any signed-in user with MFA'} (MFA required for all users).`,
    o.stepUp ? 'Requires a fresh step-up sign-in (STEP_UP_MAX_AGE_SEC).' : null, o.idem ? 'Requires an Idempotency-Key header (8-128 chars); a replay returns the first response.' : null,
    'Exact validation rules live in the zod schema in the controller.'].filter(Boolean).join(' ');
  const params = [...o.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
  for (const q of [...new Set(o.queries)]) params.push({ name: q, in: 'query', required: false, schema: { type: 'string' } });
  if (o.idem) params.push({ $ref: '#/components/parameters/IdempotencyKey' });
  const op = { tags: [TAGS[o.mod]?.[0] ?? o.mod], operationId: id, summary: SUMMARIES[key] ?? `${o.method.toUpperCase()} ${o.path.replace('/v1/', '')}`, description: desc };
  if (o.isPublic) op.security = [];
  if (params.length) op.parameters = params;
  if (o.hasBody || o.method === 'post') {
    const props = Object.fromEntries(o.fields.map((f) => [f.name, typeOf(f.def)]));
    const schema = { type: 'object' };
    if (o.fields.length) { schema.properties = props; const req = o.fields.filter((f) => !f.optional).map((f) => f.name); if (req.length) schema.required = req; }
    op.requestBody = { required: o.hasBody, content: { 'application/json': { schema } } };
  }
  const ok = o.method === 'post' ? '201' : '200';
  op.responses = { [ok]: { description: 'Success. Money values are KES integer cents serialised as decimal strings.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AnyJson' } } } },
    '400': { $ref: '#/components/responses/Problem' }, ...(o.isPublic ? {} : { '401': { $ref: '#/components/responses/Problem' }, '403': { $ref: '#/components/responses/Problem' } }), '429': { $ref: '#/components/responses/Problem' } };
  (paths[o.path] ??= {})[o.method] = op;
}

const used = [...new Set(ops.map((o) => o.mod))].filter((m) => TAGS[m]);
const doc = {
  openapi: '3.1.0',
  info: { title: 'Mapema Platform API (as implemented, Phase 1)', version: '1.0.0-phase1',
    description: 'Generated from the NestJS controllers by scripts/gen-openapi.mjs. Money: KES integer cents (strings in JSON). Errors: RFC 9457 problem+json; `title` is a stable error code. All users need MFA; money movements need step-up and maker-checker. Phase 0 design contract: openapi/phase-0-design.yaml (differences are listed in docs/phase-1/README).',
    contact: { name: 'Mapema engineering' }, license: { name: 'Proprietary - Mapema Limited, all rights reserved', identifier: 'LicenseRef-Mapema-Proprietary' } },
  servers: [{ url: 'https://api.staging.mapema.example', description: 'Staging placeholder (not deployed in Phase 1); locally http://localhost:4000' }],
  security: [{ bearer: [] }],
  tags: used.map((m) => ({ name: TAGS[m][0], description: TAGS[m][1] })),
  paths,
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'OIDC access token (Keycloak in staging/production; dev IdP locally). amr must include an MFA factor.' } },
    parameters: { IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } } },
    responses: { Problem: { description: 'Error (problem+json)', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } } },
    schemas: {
      AnyJson: { description: 'Response body; see the service code for the exact shape.' },
      Problem: { type: 'object', required: ['type', 'title', 'status'], properties: { type: { type: 'string', format: 'uri' }, title: { type: 'string', description: 'Stable machine-readable error code, e.g. FOUR_EYES, LIMIT_EXCEEDED, STEP_UP_REQUIRED' }, status: { type: 'integer' }, detail: { type: 'string' }, instance: { type: 'string' }, requestId: { type: 'string' }, failedChecks: { type: 'array', items: { type: 'object' } } } },
    },
  },
};
writeFileSync(join(root, 'openapi/openapi.yaml'), `# GENERATED by scripts/gen-openapi.mjs - do not edit by hand.\n${y(doc)}\n`);
console.log(`openapi/openapi.yaml: ${ops.length} operations, ${Object.keys(paths).length} paths`);
