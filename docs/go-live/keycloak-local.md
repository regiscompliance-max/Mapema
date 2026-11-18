# SYS-05 MFA end to end with a real Keycloak (local)

**[Security Engineer + QA Engineer]** 18 Nov 2026. Keycloak 26.8.2 (Quarkus distribution, sha1 verified) on JDK 25,
run natively because Docker is not available on the build box. Local-only bootstrap admin; nothing is exposed.

## Run it

```bash
export JAVA_HOME=/home/box/mapema-tools/jdk-25.0.5+8
export KC_BOOTSTRAP_ADMIN_USERNAME=kcadmin KC_BOOTSTRAP_ADMIN_PASSWORD=<local-only>
export MAPEMA_BFF_CLIENT_SECRET=<local test secret, >= 16 chars>
cp infra/keycloak/mapema-realm.json <keycloak>/data/import/
<keycloak>/bin/kc.sh start-dev --http-port 8180 --import-realm
KEYCLOAK_URL=http://localhost:8180 KEYCLOAK_ADMIN_USER=kcadmin KEYCLOAK_ADMIN_PASSWORD=<local-only> node scripts/keycloak-configure.mjs
cd apps/api && KEYCLOAK_URL=http://localhost:8180 KEYCLOAK_ADMIN_PASSWORD=<local-only> npx vitest run test/keycloak.live.test.ts
```

The test is skipped (not failed) when `KEYCLOAK_URL` is unset, so CI stays green without Keycloak.

## What the test proves (4/4 pass)

| Test | Flow |
| --- | --- |
| TC-GL-KC-01 | New user: password, then the CONFIGURE_TOTP required action (enrol with a real TOTP code computed in the test). Keycloak's token says `amr: ["pwd"]`, so the API sends the browser back once with `prompt=login`; password + TOTP; the API accepts, creates the HttpOnly session, and the stored session `amr` includes `otp`. |
| TC-GL-KC-02 | Later sign-in asks for the code; a wrong code is refused by Keycloak; the right code signs in. |
| TC-GL-KC-03 | Step-up (`prompt=login`, `max_age=0`) forces password + TOTP again and the new session's `auth_time` is fresh. |
| TC-GL-KC-04 | A Keycloak user whose Mapema account is inactive completes MFA but is refused (`NO_ACCOUNT`), no session. |

## Findings (now fixed and codified)

1. **amr was empty.** Keycloak's AMR mapper only emits a value configured on each browser-flow execution
   (`default.reference.value`), and with the default `default.reference.maxAge` of 0 only when the token is minted in
   the same second as the step (Keycloak issue #54497, checked 18 Nov 2026). `scripts/keycloak-configure.mjs` sets
   `pwd` and `otp` with max age = the realm's SSO max lifespan.
2. **OTP was conditional** ("only if the user has OTP"). The script makes the 2FA sub-flow and the OTP form REQUIRED.
3. **Enrolment login lacks `otp`.** Handled in the API (one automatic re-prompt, audited as `session.oidc_mfa_reprompt`).

## Staging / production

Run the same script in the deploy pipeline after every realm import. Keep the admin console off the public internet
(VPN or IP allow-list), give the API its own confidential client secret from the secret manager, and set
`OIDC_ISSUER`, `OIDC_REDIRECT_URI` (https) and `OIDC_CLIENT_SECRET` in the API.
