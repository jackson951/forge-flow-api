import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface AuditEntry {
  action: string;
  workspaceId?: string | null;
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string;
  /** Must never contain secrets, passwords or tokens. */
  metadata?: Prisma.InputJsonObject;
}

/** Append-only record of security-relevant actions. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass a transaction client to record atomically with the audited change. */
  async record(entry: AuditEntry, tx: Prisma.TransactionClient = this.prisma): Promise<void> {
    await tx.auditEvent.create({ data: entry });
  }
}
