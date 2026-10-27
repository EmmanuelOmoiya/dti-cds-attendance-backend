import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { AppConfig } from './config/config.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = app.get(AppConfig);
  configureApp(app, config);
  await app.listen(config.PORT, '0.0.0.0');
  app.get(Logger).log(`API listening on :${config.PORT} (docs: ${config.SWAGGER_ENABLED ? '/api/docs' : 'disabled'})`);
}

void bootstrap();
