import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from './config/app.config';
import { validateEnvironment } from './config/environment-validation';
import { McpModule } from './mcp/mcp.module';
import { ProvidersModule } from './providers/providers.module';
import { SecurityModule } from './security/security.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      validate: validateEnvironment,
      envFilePath: ['.env.local', '.env'],
    }),
    SecurityModule,
    ProvidersModule,
    McpModule,
    HealthModule,
  ],
})
export class AppModule {}
