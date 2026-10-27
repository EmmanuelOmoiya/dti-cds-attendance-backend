import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { perMinute } from '../common/http/throttle';
import type { UserActor } from './actor';
import { ChangePasswordDto, LoginDto, RefreshDto } from './auth.dto';
import { AuthService } from './auth.service';
import { CurrentUser, Public } from './decorators';

@ApiTags('Auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Exchange email + password for an access token (15 min) and a single-use refresh token. */
  @Public()
  @Throttle({ default: perMinute('THROTTLE_LOGIN_PER_MINUTE', 10) })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /** Rotate a refresh token. Re-using an old refresh token revokes the whole session family. */
  @Public()
  @Throttle({ default: perMinute('THROTTLE_LOGIN_PER_MINUTE', 10) })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: RefreshDto, @CurrentUser() user: UserActor) {
    await this.auth.logout(dto.refreshToken, user);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: UserActor) {
    return this.auth.me(user);
  }

  /** Changes the password and signs out every other session of this user. */
  @ApiBearerAuth()
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() user: UserActor) {
    await this.auth.changePassword(user, dto.currentPassword, dto.newPassword);
  }
}
