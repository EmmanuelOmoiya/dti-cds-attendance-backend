import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import { randomToken, sha256 } from '../common/security/crypto';
import { AppConfig } from '../config/config.module';
import { User, UserStatus } from '../generated/prisma/client';
import { auditActor, UserActor } from './actor';
import { TokenPairDto } from './auth.dto';
import { PasswordService } from './password.service';

export interface UserTokenClaims {
  sub: string;
  role: string;
  typ: 'user';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  async login(emailRaw: string, password: string): Promise<TokenPairDto> {
    const email = emailRaw.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = await this.passwords.verify(user?.passwordHash, password);

    if (!user || !ok) {
      await this.audit.record(this.prisma, {
        actor: user ? { type: 'USER', id: user.id } : { type: 'ANONYMOUS' },
        action: 'auth.login.failed',
        entityType: 'User',
        entityId: user?.id,
        metadata: { email, reason: user ? 'BAD_PASSWORD' : 'UNKNOWN_EMAIL' },
      });
      throw AppError.unauthenticated('Invalid email or password', ErrorCode.INVALID_CREDENTIALS);
    }
    if (user.status !== UserStatus.ACTIVE) {
      await this.audit.record(this.prisma, {
        actor: { type: 'USER', id: user.id },
        action: 'auth.login.failed',
        entityType: 'User',
        entityId: user.id,
        metadata: { email, reason: 'USER_DISABLED' },
      });
      throw new AppError(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, 'This account is disabled');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      const tokens = await this.issueTokens(tx, user, randomUUID());
      await this.audit.record(tx, {
        actor: { type: 'USER', id: user.id },
        action: 'auth.login.succeeded',
        entityType: 'User',
        entityId: user.id,
      });
      return tokens;
    });
  }

  /**
   * Refresh-token rotation with reuse detection: every refresh token is single-use. Presenting
   * an already-rotated token means it was stolen (or replayed), so the whole token family is revoked.
   */
  async refresh(refreshToken: string): Promise<TokenPairDto> {
    const tokenHash = sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });
    const invalid = () => AppError.unauthenticated('Invalid or expired refresh token', ErrorCode.INVALID_REFRESH_TOKEN);
    if (!stored) throw invalid();

    if (stored.revokedAt && !stored.replacedAt) throw invalid(); // logged out / revoked family
    if (stored.replacedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(this.prisma, {
        actor: { type: 'USER', id: stored.userId },
        action: 'auth.refresh.reuse_detected',
        entityType: 'User',
        entityId: stored.userId,
        metadata: { familyId: stored.familyId },
      });
      throw invalid();
    }
    if (stored.expiresAt <= new Date() || stored.user.status !== UserStatus.ACTIVE) throw invalid();

    return this.prisma.$transaction(async (tx) => {
      // Conditional update guards against two concurrent refreshes of the same token.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: stored.id, replacedAt: null, revokedAt: null },
        data: { replacedAt: new Date() },
      });
      if (count !== 1) throw invalid();
      return this.issueTokens(tx, stored.user, stored.familyId);
    });
  }

  async logout(refreshToken: string, user: UserActor): Promise<void> {
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (stored && stored.userId === user.id) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await this.audit.record(this.prisma, {
      actor: auditActor(user),
      action: 'auth.logout',
      entityType: 'User',
      entityId: user.id,
    });
  }

  async me(user: UserActor) {
    const row = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { groupScopes: { include: { group: { select: { id: true, name: true, status: true } } } } },
    });
    return {
      id: row.id,
      email: row.email,
      fullName: row.fullName,
      role: row.role,
      status: row.status,
      lastLoginAt: row.lastLoginAt,
      groups: row.groupScopes.map((s) => s.group),
    };
  }

  async changePassword(user: UserActor, currentPassword: string, newPassword: string): Promise<void> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await this.passwords.verify(row.passwordHash, currentPassword))) {
      throw AppError.unauthenticated('Current password is incorrect', ErrorCode.INVALID_CREDENTIALS);
    }
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, {
        actor: auditActor(user),
        action: 'auth.password_changed',
        entityType: 'User',
        entityId: user.id,
      });
    });
  }

  verifyAccessToken(token: string): UserTokenClaims {
    const claims = this.jwt.verify<UserTokenClaims>(token, {
      secret: this.config.JWT_ACCESS_SECRET,
      algorithms: ['HS256'],
    });
    if (claims.typ !== 'user' || typeof claims.sub !== 'string') throw new Error('wrong token type');
    return claims;
  }

  private async issueTokens(tx: Tx, user: User, familyId: string): Promise<TokenPairDto> {
    const accessToken = this.jwt.sign(
      { sub: user.id, role: user.role, typ: 'user' } satisfies UserTokenClaims,
      { secret: this.config.JWT_ACCESS_SECRET, expiresIn: this.config.JWT_ACCESS_TTL_SECONDS, algorithm: 'HS256' },
    );
    const refreshToken = randomToken(32, 'rt_');
    const refreshTokenExpiresAt = new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await tx.refreshToken.create({
      data: { userId: user.id, tokenHash: sha256(refreshToken), familyId, expiresAt: refreshTokenExpiresAt },
    });
    return {
      accessToken,
      accessTokenExpiresIn: this.config.JWT_ACCESS_TTL_SECONDS,
      refreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
      tokenType: 'Bearer',
    };
  }
}
