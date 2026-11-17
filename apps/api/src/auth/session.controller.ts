/** [Security Engineer] Sign-in (token -> cookie), session info + CSRF token, logout. */
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthUser, CurrentUser, Identity, identityFromToken, Public, TokenVerifier } from './auth';
import { parseCookies, Sessions, SID_COOKIE } from './session';

@Controller('auth')
export class AuthSessionController {
  constructor(private readonly verifier: TokenVerifier, private readonly identity: Identity, private readonly sessions: Sessions) {}

  /** Exchange a freshly issued IdP access token for a session cookie. The token is not stored. */
  @Public()
  @Post('session')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async create(@Req() req: any, @Res({ passthrough: true }) res: any, @Body() b: unknown) {
    const { accessToken } = z.object({ accessToken: z.string().min(1).max(8000) }).parse(b);
    const id = identityFromToken(await this.verifier.verify(accessToken));
    const user = await this.identity.build(id, req);
    const previous = parseCookies(req.headers.cookie)[SID_COOKIE];
    const s = await this.sessions.create(user, id, req, previous);
    res.setHeader('Set-Cookie', this.sessions.cookie(s.sid, s.maxAgeSec));
    res.setHeader('Cache-Control', 'no-store');
    return { csrfToken: s.csrfToken, expiresAt: s.expiresAt.toISOString(), user: summary(user) };
  }

  /** Current session: who am I + the CSRF token (the page keeps it in memory, so it asks again after a reload). */
  @Get('session')
  info(@CurrentUser() u: AuthUser, @Req() req: any, @Res({ passthrough: true }) res: any) {
    res.setHeader('Cache-Control', 'no-store');
    return { csrfToken: req.sessionSid ? this.sessions.csrfFor(req.sessionSid) : null, user: summary(u) };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() u: AuthUser, @Req() req: any, @Res({ passthrough: true }) res: any) {
    if (req.sessionSid) await this.sessions.revoke(req.sessionSid, u.actor);
    res.setHeader('Set-Cookie', this.sessions.clearCookie());
  }
}

function summary(u: AuthUser) {
  return { id: u.id, email: u.email, displayName: u.displayName, roles: u.roles };
}
