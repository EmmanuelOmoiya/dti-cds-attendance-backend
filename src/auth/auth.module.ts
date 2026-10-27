import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard, PermissionsGuard } from './guards';
import { PasswordService } from './password.service';

@Module({
  // Secrets are passed per call (user and device tokens use different secrets).
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, JwtAuthGuard, PermissionsGuard],
  exports: [AuthService, PasswordService, JwtAuthGuard, PermissionsGuard, JwtModule],
})
export class AuthModule {}
