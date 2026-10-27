import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * argon2id with OWASP-recommended parameters (19 MiB memory, 2 iterations, 1 lane).
 * A fixed dummy hash is verified when the user does not exist so response timing does not
 * reveal which emails are registered.
 */
@Injectable()
export class PasswordService {
  private static readonly OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, PasswordService.OPTIONS);
  }

  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    if (!hash) {
      this.dummyHash ??= argon2.hash('dummy-password-for-timing', PasswordService.OPTIONS);
      await argon2.verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}
