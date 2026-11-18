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
import { ArtifactCrypto, FieldCrypto } from './common/crypto';
import { Db } from './common/db';
import { ProblemFilter } from './common/errors';
import { Idempotency } from './common/idempotency';
import { Notifier } from './common/notify';
import { Outbox } from './common/outbox';
import { AuthGuard, Identity, TokenVerifier } from './auth/auth';
import { Sessions } from './auth/session';
import { AuthSessionController } from './auth/session.controller';
import { OidcBff, OidcBffController } from './auth/oidc-bff';
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
import { CreditReviewController, CreditReviewService } from './modules/credit-reviews';
import { SelfService, SelfServiceController } from './modules/self-service';
import { PublicController, PublicService } from './modules/public';
import { ReportsController, ReportsService } from './modules/reports';
import { CollectionsController, CollectionsService } from './modules/collections';
import { ReconciliationController, ReconciliationService } from './modules/reconciliation';
import { HolidaysController, HolidaysService } from './modules/holidays';
import { RegulatoryController, RegulatoryService } from './modules/regulatory';
import { DashboardsController, DashboardsService } from './modules/dashboards';
import { IntegrationsController, IntegrationsService } from './modules/integrations';
import { FundingController, FundingService } from './modules/funding';
import { MpesaController, MpesaService } from './modules/mpesa';
import { ErpController, ErpService } from './modules/erp';
import { BulkController, BulkService } from './modules/bulk';
import { RegistryController, RegistryService } from './modules/registry';

export const CONTROLLERS = [AuthSessionController, OidcBffController, PublicController, OnboardingController, InvoicesController, AdvancesController, PaymentsController, CreditReviewController, SelfServiceController, OpsController, ApprovalsController, AdminController, ReportsController,
  CollectionsController, ReconciliationController, HolidaysController, RegulatoryController, DashboardsController, IntegrationsController,
  FundingController, MpesaController, ErpController, BulkController, RegistryController];

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
        Db, Clock, Audit, FieldCrypto, ArtifactCrypto, Outbox, Notifier, Idempotency, DevIdp, TokenVerifier, Identity, Sessions, OidcBff,
        ApprovalsService, SettingsService, DocumentsService, OnboardingService, InvoicesService, AdvancesService, PaymentsService, OpsService, ReportsService, PublicService, CreditReviewService, SelfService,
        CollectionsService, ReconciliationService, HolidaysService, RegulatoryService, DashboardsService, IntegrationsService,
        FundingService, MpesaService, ErpService, BulkService, RegistryService,
        ...(cfg.RATE_LIMIT_STORE === 'postgres' ? [{ provide: ThrottlerStorage, useClass: PgThrottlerStorage }] : []),
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
      exports: [Db, Clock, Outbox, HolidaysService, PaymentsService, OpsService, AdvancesService, CreditReviewService, CollectionsService, ReconciliationService, RegulatoryService, IntegrationsService, FundingService, MpesaService, ErpService, RegistryService, ADAPTERS],
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
