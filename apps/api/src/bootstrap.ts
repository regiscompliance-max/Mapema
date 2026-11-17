/** [Backend Engineer + Security Engineer] Build the HTTP app (shared by main.ts, the worker and tests). */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule, AppOverrides } from './app.module';
import { AppConfig } from './common/config';
import { jsonReplacer } from './common/http';
import { DevIdp } from './auth/dev-idp';

export async function createApp(cfg: AppConfig, o: AppOverrides = {}, opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg, o), {
    rawBody: true, // webhook signatures are computed over the raw body
    logger: opts.logger === false ? false : ['error', 'warn', 'log'],
  });
  app.set('json replacer', jsonReplacer);
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, hsts: { maxAge: 31536000, includeSubDomains: true } }));
  app.useBodyParser('json', { limit: '15mb' }); // documents arrive base64 (10 MB file limit enforced in DocumentsService)
  app.enableCors({ origin: cfg.WEB_ORIGIN.split(','), credentials: false, allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'] });
  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();
  if (cfg.DEV_IDP_ENABLED === 'true') await app.get(DevIdp).init();
  await app.init();
  return app;
}
