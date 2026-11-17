# Keycloak realm (Phase 1)

Phase 1: realm written but NOT imported or tested (Keycloak not run on the build box). MFA (TOTP) is a default required action for every user; supplier SMS OTP (D-12) needs an SMS authenticator extension - open item. The amr mapper requires a Keycloak version with ACR/AMR support; the API rejects tokens whose amr lacks an MFA factor.

Import: `docker compose up keycloak` (uses `--import-realm`). Redirect URIs and web origins must be changed per environment.
