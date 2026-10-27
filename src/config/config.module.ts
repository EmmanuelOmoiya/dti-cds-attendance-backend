import { Global, Module } from '@nestjs/common';
import { EnvironmentVariables, validateEnv } from './app-config';

/**
 * The validated environment, injectable by class (typed, no string keys).
 * Validation runs once when the module is constructed, so a misconfigured app fails at boot.
 */
export abstract class AppConfig extends EnvironmentVariables {}

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => validateEnv(process.env) }],
  exports: [AppConfig],
})
export class AppConfigModule {}
