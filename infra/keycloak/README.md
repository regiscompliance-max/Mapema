# Keycloak realm `mapema`

Go-live status: **tested end to end against a real Keycloak 26.8.2** running locally (no Docker on the build box; native
distribution, sha1 verified). See `docs/go-live/keycloak-local.md` for the exact commands and the test (TC-GL-KC-01..04).

- Client `mapema-web` is **confidential** (D-32 BFF): the API does the code exchange with the client secret and PKCE;
  the browser never sees a token. The secret comes from `MAPEMA_BFF_CLIENT_SECRET` at import time and must match the
  API's `OIDC_CLIENT_SECRET` (secret manager in staging/production; never commit it).
- Redirect URI: `<API origin>/v1/auth/oidc/callback` only. Change it per environment. Web origins: none (no browser CORS).
- MFA (SYS-05): TOTP is a default required action, and after import you **must run**
  `KEYCLOAK_URL=... KEYCLOAK_ADMIN_USER=... KEYCLOAK_ADMIN_PASSWORD=... node scripts/keycloak-configure.mjs`.
  It (1) sets the authenticator references `pwd` / `otp` (with a max age) on the browser flow so the AMR mapper emits
  them, and (2) makes the OTP step REQUIRED for everyone. Without (1) Keycloak's `amr` claim is empty or partial
  (Keycloak issue #54497) and the API refuses every login with `MFA_REQUIRED`.
- The login in which a user first enrols TOTP carries only `amr: ["pwd"]` (enrolment is a required action, not a
  completed OTP step). The API then sends the browser back to Keycloak once with `prompt=login`, the user enters the
  password and the new code, and that login is accepted. A second password-only result fails closed.
- Supplier SMS OTP (D-12) still needs an SMS authenticator extension: open item (provider checklist).
