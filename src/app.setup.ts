import { VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { requestContextMiddleware } from './common/context/request-context';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/http/response.interceptor';
import { createValidationPipe } from './common/http/validation';
import { AppConfig } from './config/config.module';

/** HTTP pipeline shared by main.ts and the e2e tests, so tests exercise the real configuration. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.use(requestContextMiddleware);
  app.use(helmet());
  app.useBodyParser('json', { limit: '512kb' });

  const origins = (config.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors(origins.length ? { origin: origins, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], exposedHeaders: ['X-Request-Id', 'ETag', 'Content-Disposition'] } : { origin: false });

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.enableShutdownHooks();

  if (config.SWAGGER_ENABLED) {
    const doc = new DocumentBuilder()
      .setTitle('DTI CDS Attendance API')
      .setDescription(
        'Offline-first NFC attendance backend. Dashboard routes use a user Bearer token from /auth/login; ' +
          '/sync routes use a device Bearer token from /sync/token. See docs/ for the full protocol.',
      )
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, doc), { jsonDocumentUrl: 'api/docs-json' });
  }
}
