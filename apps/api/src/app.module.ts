/** [Backend Engineer + DevOps] Composition root. */
import { DynamicModule, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { PgThrottlerStorage } from './common/rate-limit';
import { randomUUID } from 'node:crypto';
import { Adapters, createAdapters, LocalEncryptedStorage, MemoryStorage, StorageAdapter } from '@mapema/adapters';
import { Audit } from './common/audit';
import { Clock } from './common/clock';
import { ADAPTERS, AppConfig, CONFIG, STORAGE } from './common/config';
import { FieldCrypto } from './common/crypto';
import { Db } from './common/db';
import { ProblemFilter } from './common/errors';
import { Idempotency } from './common/idempotency';
import { Notifier } from './common/notify';
import { Outbox } from './common/outbox';
import { AuthGuard, Identity, TokenVerifier } from './auth/auth';
import { Sessions } from './auth/session';
import { AuthSessionController } from './auth/session.controller';
import { DevIdp } from './auth/dev-idp';
import { AdminController, SettingsService } from './modules/admin';
import { AdvancesController, AdvancesService } from './modules/advances';
import { ApprovalsController, ApprovalsService } from './modules/approvals';
import { DevController } from './modules/dev';
import { DocumentsService } from './modules/documents';
import { InvoicesController, InvoicesService } from './modules/invoices';
import { OnboardingController, OnboardingService } from './modules/onboarding';
import { OpsController, OpsService } from './modules/ops';
import { PaymentsController, PaymentsService } from './modules/payments';
import { PublicController, PublicService } from './modules/public';
import { ReportsController, ReportsService } from './modules/reports';

export const CONTROLLERS = [AuthSessionController, PublicController, OnboardingController, InvoicesController, AdvancesController, PaymentsController, OpsController, ApprovalsController, AdminController, ReportsController];

export interface AppOverrides { adapters?: Adapters; storage?: StorageAdapter }

@Module({})
export class AppModule implements NestModule {
  static forRoot(cfg: AppConfig, o: AppOverrides = {}): DynamicModule {
    const devRoutes = cfg.DEV_IDP_ENABLED === 'true' && (cfg.APP_ENV === 'development' || cfg.APP_ENV === 'test');
    return {
      module: AppModule,
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: cfg.APP_ENV === 'test' ? 100_000 : 300 }])],
      controllers: [...CONTROLLERS, ...(devRoutes ? [DevController] : [])],
      providers: [
        { provide: CONFIG, useValue: cfg },
        { provide: ADAPTERS, useValue: o.adapters ?? createAdapters(cfg.raw) },
        { provide: STORAGE, useValue: o.storage ?? (cfg.APP_ENV === 'test' ? new MemoryStorage() : new LocalEncryptedStorage(cfg.STORAGE_DIR, cfg.STORAGE_ENCRYPTION_KEY)) },
        Db, Clock, Audit, FieldCrypto, Outbox, Notifier, Idempotency, DevIdp, TokenVerifier, Identity, Sessions,
        ApprovalsService, SettingsService, DocumentsService, OnboardingService, InvoicesService, AdvancesService, PaymentsService, OpsService, ReportsService, PublicService,
        ...(cfg.RATE_LIMIT_STORE === 'postgres' ? [{ provide: ThrottlerStorage, useClass: PgThrottlerStorage }] : []),
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
      exports: [Db, Clock, Outbox, PaymentsService, OpsService, AdvancesService, ADAPTERS],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply((req: any, res: any, next: () => void) => {
      const incoming = req.headers['x-request-id'];
      req.requestId = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
      res.setHeader('X-Request-Id', req.requestId);
      next();
    }).forRoutes('*path');
  }
}
