/**
 * [Backend Engineer] Notifications (SMS + email, English first, Swahili-ready). Rows are written
 * in the business transaction; sending happens via the outbox `notify.send` topic.
 */
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Adapters } from '@mapema/adapters';
import en from '../i18n/en.json';
import sw from '../i18n/sw.json';
import { ADAPTERS } from './config';
import { FieldCrypto, mask } from './crypto';
import { Db, Q } from './db';
import { Outbox } from './outbox';

const STRINGS: Record<string, Record<string, string>> = { en, sw };

export function render(key: string, params: Record<string, string>, locale: 'en' | 'sw' = 'en'): string {
  const tpl = STRINGS[locale]?.[key] ?? STRINGS.en[key];
  if (!tpl) throw new Error(`missing string ${key}`);
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => params[k] ?? `{${k}}`);
}

@Injectable()
export class Notifier implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly outbox: Outbox,
    private readonly crypto: FieldCrypto,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
  ) {}

  onModuleInit() {
    this.outbox.on('notify.send', async (p) => {
      // recipient resolved at send time so no contact details sit in the outbox (data minimisation)
      const row = await this.db.one(
        `SELECT n.id, n.status, n.channel, u.email, p.phone_enc FROM notification n JOIN user_account u ON u.id = n.user_id
         LEFT JOIN person p ON p.id = u.person_id WHERE n.id = $1`, [p.notificationId]);
      if (!row || row.status === 'sent') return;
      const ctx = { requestId: `notify-${p.notificationId}` };
      const to = row.channel === 'sms' ? this.crypto.decrypt(row.phone_enc) : row.email;
      if (!to) return;
      const r = row.channel === 'sms'
        ? await this.adapters.sms.send(ctx, { to, text: p.text, reference: p.notificationId })
        : await this.adapters.email.send(ctx, { to, subject: p.subject, text: p.text, reference: p.notificationId });
      await this.db.query(`UPDATE notification SET status = $2, provider_ref = $3, sent_at = now() WHERE id = $1`, [p.notificationId, r.status, r.providerRef]);
    });
  }

  /** Notify every active user of an organisation (or one user) on SMS and email. */
  async toOrg(q: Q, orgId: string, key: string, params: Record<string, string>, entity?: { type: string; id: string }) {
    const users = (await q.query(
      `SELECT DISTINCT u.id, u.email, p.phone_enc FROM user_role_assignment r JOIN user_account u ON u.id = r.user_id
       LEFT JOIN person p ON p.id = u.person_id WHERE r.org_id = $1 AND r.revoked_at IS NULL AND u.active`,
      [orgId],
    )).rows;
    for (const u of users) await this.toUser(q, u, key, params, entity);
  }

  async toRole(q: Q, role: string, key: string, params: Record<string, string>, entity?: { type: string; id: string }) {
    const users = (await q.query(
      `SELECT DISTINCT u.id, u.email, NULL::bytea AS phone_enc FROM user_role_assignment r JOIN user_account u ON u.id = r.user_id
       WHERE r.role = $1 AND r.revoked_at IS NULL AND u.active`, [role])).rows;
    for (const u of users) await this.toUser(q, u, key, params, entity, ['email']);
  }

  private async toUser(q: Q, u: { id: string; email: string; phone_enc: Buffer | null }, key: string, params: Record<string, string>,
    entity?: { type: string; id: string }, channels: ('sms' | 'email')[] = ['sms', 'email']) {
    const text = render(key, params, 'en');
    const phone = this.crypto.decrypt(u.phone_enc);
    for (const channel of channels) {
      const to = channel === 'sms' ? phone : u.email;
      if (!to) continue;
      const n = (await q.query(
        `INSERT INTO notification (user_id, channel, template_key, locale, entity_type, entity_id, recipient_hint) VALUES ($1,$2,$3,'en',$4,$5,$6) RETURNING id`,
        [u.id, channel, key, entity?.type ?? null, entity?.id ?? null, channel === 'sms' ? mask(to, 3) : to.replace(/^(.).*(@.*)$/, '$1***$2')],
      )).rows[0];
      await this.outbox.enqueue(q, 'notify.send', n.id, `notify-${n.id}`, { notificationId: n.id, text, subject: `Mapema: ${key.split('.')[0]}` });
    }
  }
}
