/**
 * [Backend Engineer] RFC 9457 problem+json errors. Internal details never leak to clients.
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { MoneyError } from '@mapema/pricing';
import { AdapterError } from '@mapema/adapters';
import { ZodError } from 'zod';
import { redactUrl } from './redact';

export class DomainError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly extra?: Record<string, unknown>) {
    super(message);
  }
}
export const badRequest = (code: string, msg: string, extra?: Record<string, unknown>) => new DomainError(400, code, msg, extra);
export const forbidden = (code: string, msg: string) => new DomainError(403, code, msg);
export const notFound = (what: string) => new DomainError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, msg: string, extra?: Record<string, unknown>) => new DomainError(409, code, msg, extra);
export const unprocessable = (code: string, msg: string, extra?: Record<string, unknown>) => new DomainError(422, code, msg, extra);

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('Problem');
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const req = host.switchToHttp().getRequest();
    let status = 500;
    let code = 'INTERNAL';
    let detail = 'Something went wrong. The incident has been logged.';
    let extra: Record<string, unknown> | undefined;
    if (e instanceof DomainError) {
      status = e.status; code = e.code; detail = e.message; extra = e.extra;
    } else if (e instanceof ZodError) {
      status = 400; code = 'VALIDATION'; detail = e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    } else if (e instanceof MoneyError) {
      status = e.code === 'CURRENCY_NOT_SUPPORTED' ? 400 : 422; code = e.code; detail = e.message;
    } else if (e instanceof AdapterError) {
      status = e.retryable ? 503 : 502; code = `PROVIDER_${e.code}`; detail = `${e.provider} is unavailable or rejected the request`;
      this.log.warn(e.message);
    } else if (e instanceof HttpException) {
      status = e.getStatus();
      code = HttpStatus[status] ?? 'HTTP_ERROR';
      const r = e.getResponse();
      detail = typeof r === 'string' ? r : (r as any)?.message?.toString?.() ?? e.message;
    } else if ((e as any)?.code === '23505') {
      const constraint = String((e as any)?.constraint ?? '');
      if (constraint.includes('etims_cu')) {
        status = 409; code = 'DUPLICATE_ETIMS_CU'; detail = 'This eTIMS control-unit number is already on another invoice';
      } else {
        status = 409; code = 'CONFLICT'; detail = 'A record with these details already exists';
      }
    } else if ((e as any)?.code === '23514' || (e as any)?.code === '23502') {
      status = 422; code = 'CONSTRAINT'; detail = 'The request breaks a data rule';
      this.log.warn(`constraint: ${(e as any)?.constraint ?? (e as any)?.message}`);
    } else {
      this.log.error(`${req?.method ?? ''} ${redactUrl(req?.url) ?? ''} ${(e as Error)?.stack ?? String(e)}`);
    }
    res.status(status).type('application/problem+json').json({
      type: `https://docs.mapema.co.ke/problems/${code.toLowerCase()}`,
      title: code, status, detail, instance: redactUrl(req?.url), requestId: req?.requestId, ...extra,
    });
  }
}
