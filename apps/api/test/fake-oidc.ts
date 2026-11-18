/**
 * [QA Engineer] A tiny local OpenID Connect provider for the D-32 BFF tests (stands in for Keycloak;
 * never a real host). Implements just enough of authorization-code + PKCE:
 *   GET  /auth   - "the user signs in": immediately 302s to redirect_uri with a one-time code
 *   POST /token  - checks client id/secret (Basic), code, redirect_uri and the PKCE S256 verifier;
 *                  returns an access token (aud mapema-api) and an ID token (aud client id, nonce)
 *   GET  /certs  - JWKS
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface FakeUser { sub: string; email: string; amr: string[] }
export class FakeOidc {
  issuer = '';
  user: FakeUser = { sub: 'x', email: 'x@x', amr: ['pwd', 'otp'] };
  tamper: 'none' | 'nonce' | 'audience' = 'none';
  readonly tokenCalls: Record<string, string>[] = [];
  authAgeSec = 0;
  private codes = new Map<string, { challenge: string; redirectUri: string; nonce: string; clientId: string }>();
  private server?: Server;
  private key?: { privateKey: any; jwk: any };
  constructor(private readonly client: { id: string; secret: string }) {}

  async start() {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    this.key = { privateKey, jwk: { ...(await exportJWK(publicKey)), kid: 'fake-1', alg: 'RS256', use: 'sig' } };
    this.server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', this.issuer);
      if (req.method === 'GET' && u.pathname === '/auth') {
        const q = u.searchParams;
        if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state') || !q.get('nonce')) { res.writeHead(400).end('bad request'); return; }
        const code = randomBytes(16).toString('hex');
        this.codes.set(code, { challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')!, nonce: q.get('nonce')!, clientId: q.get('client_id')! });
        res.writeHead(302, { Location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state')!)}` }).end();
        return;
      }
      if (req.method === 'GET' && u.pathname === '/certs') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [this.key!.jwk] })); return; }
      if (req.method === 'POST' && u.pathname === '/token') {
        let body = ''; req.on('data', (c) => { body += c; });
        req.on('end', async () => {
          const p = Object.fromEntries(new URLSearchParams(body));
          this.tokenCalls.push({ ...p, authorization: String(req.headers.authorization ?? '') });
          const basic = Buffer.from(`${this.client.id}:${this.client.secret}`).toString('base64');
          const c = this.codes.get(p.code ?? '');
          this.codes.delete(p.code ?? '');
          const pkceOk = c && createHash('sha256').update(p.code_verifier ?? '').digest('base64url') === c.challenge;
          if (req.headers.authorization !== `Basic ${basic}` || !c || !pkceOk || c.redirectUri !== p.redirect_uri || p.grant_type !== 'authorization_code') {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' })); return;
          }
          const now = Math.floor(Date.now() / 1000);
          const sign = (claims: Record<string, unknown>, aud: string) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'fake-1' })
            .setIssuer(this.issuer).setAudience(aud).setSubject(this.user.sub).setIssuedAt(now).setExpirationTime(now + 300).sign(this.key!.privateKey);
          const access = await sign({ email: this.user.email, amr: this.user.amr, auth_time: now - this.authAgeSec }, this.tamper === 'audience' ? 'someone-else' : 'mapema-api');
          const id = await sign({ email: this.user.email, nonce: this.tamper === 'nonce' ? 'wrong' : c.nonce, auth_time: now - this.authAgeSec }, c.clientId);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: access, id_token: id, token_type: 'Bearer', expires_in: 300 }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.issuer = `http://127.0.0.1:${(this.server!.address() as any).port}`;
    return this;
  }
  close() { return new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r())); }
}
