#!/usr/bin/env node
// [Security Engineer + DevOps] Idempotent Keycloak realm hardening for SYS-05 (go-live). Run after the
// realm import, against local, staging or production Keycloak:
//   KEYCLOAK_URL=... KEYCLOAK_ADMIN_USER=... KEYCLOAK_ADMIN_PASSWORD=... node scripts/keycloak-configure.mjs
// What it does (all found necessary in the live test against Keycloak 26.8, docs/go-live/keycloak-local.md):
//  1. amr: the AMR mapper only emits values configured on the browser-flow executions, and only within
//     default.reference.maxAge (default 0 = same second, Keycloak issue #54497). Sets pwd / otp with
//     maxAge = SSO max lifespan.
//  2. MFA for everyone: the OTP step of the browser flow is REQUIRED (not "only if configured"), so a
//     user without TOTP is made to enrol during the same login and that login carries amr otp.
export async function configureKeycloak({ url, realm = 'mapema', user, password, log = console.log }) {
  const t = await fetch(`${url}/realms/master/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', username: user, password }) });
  if (!t.ok) throw new Error(`admin login failed: ${t.status}`);
  const tok = (await t.json()).access_token;
  const api = async (path, init = {}) => {
    const r = await fetch(`${url}/admin/realms/${realm}${path}`, { ...init, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${r.status} ${await r.text()}`);
    return r.status === 204 || r.status === 201 ? null : r.json();
  };
  const maxAge = String((await api('')).ssoSessionMaxLifespan ?? 28800);
  const ex = await api('/authentication/flows/browser/executions');
  const refs = { 'auth-username-password-form': 'pwd', 'auth-otp-form': 'otp' };
  for (const e of ex.filter((x) => refs[x.providerId])) {
    const config = { 'default.reference.value': refs[e.providerId], 'default.reference.maxAge': maxAge };
    if (e.authenticationConfig) {
      const c = await api(`/authentication/config/${e.authenticationConfig}`);
      await api(`/authentication/config/${e.authenticationConfig}`, { method: 'PUT', body: JSON.stringify({ ...c, config: { ...c.config, ...config } }) });
    } else {
      await api(`/authentication/executions/${e.id}/config`, { method: 'POST', body: JSON.stringify({ alias: `mapema-amr-${refs[e.providerId]}`, config }) });
    }
    log(`amr reference ${refs[e.providerId]} on ${e.displayName}`);
  }
  // OTP mandatory: the conditional 2FA sub-flow becomes REQUIRED and the OTP form inside it REQUIRED
  for (const e of ex) {
    const want = (e.displayName === 'Browser - Conditional 2FA' || e.displayName === 'Browser - Conditional OTP') ? 'REQUIRED'
      : e.providerId === 'auth-otp-form' ? 'REQUIRED'
      : (e.providerId === 'conditional-user-configured' || e.providerId === 'conditional-credential') && e.level === 2 && ex.some((p) => p.level === 1 && /Conditional (2FA|OTP)/.test(p.displayName) && ex.indexOf(p) < ex.indexOf(e)) ? 'DISABLED'
      : null;
    if (want && e.requirement !== want && (e.requirementChoices ?? []).includes(want)) {
      await api('/authentication/flows/browser/executions', { method: 'PUT', body: JSON.stringify({ ...e, requirement: want }) });
      log(`${e.displayName}: ${e.requirement} -> ${want}`);
    }
  }
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  configureKeycloak({ url: process.env.KEYCLOAK_URL, realm: process.env.KEYCLOAK_REALM ?? 'mapema', user: process.env.KEYCLOAK_ADMIN_USER, password: process.env.KEYCLOAK_ADMIN_PASSWORD })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
