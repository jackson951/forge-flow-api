import { Injectable } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** The only user fields that may leave the backend. */
export const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof PUBLIC_USER_SELECT }>;

export function toPublicUser(user: User | PublicUser): PublicUser {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findPublicById(id: string): Promise<PublicUser | null> {
    return this.prisma.user.findUnique({ where: { id }, select: PUBLIC_USER_SELECT });
  }

  /** Includes the password hash — for credential checks only, never for responses. */
  findByEmailWithCredentials(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }
}
