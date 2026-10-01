import { PrismaClient, WorkspaceRole } from '@prisma/client';
import * as argon2 from 'argon2';

/** Development-only demo data. Idempotent: safe to run repeatedly. */

export const DEMO_EMAIL = 'demo@flowforge.local';

/**
 * Not a valid argon2 hash: without SEED_DEMO_PASSWORD the demo account cannot log in.
 * The `!` prefix follows the /etc/shadow "locked" convention. No password is committed.
 */
export const UNUSABLE_PASSWORD_HASH = '!seed-account-login-disabled';

export function assertSeedAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv === 'production') {
    throw new Error('Refusing to seed: NODE_ENV=production (seed data is for development only)');
  }
}

const demoDefinition = {
  schemaVersion: 1,
  nodes: [
    { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} },
    { key: 'log', kind: 'ACTION', type: 'util.log', config: { message: 'Hello from FlowForge' } },
  ],
  edges: [{ from: 'trigger', to: 'log' }],
};

/** Uses SEED_DEMO_PASSWORD (min 12 chars) if provided, otherwise a locked account. */
export async function demoPasswordHash(password: string | undefined): Promise<string> {
  if (!password) return UNUSABLE_PASSWORD_HASH;
  if (password.length < 12) throw new Error('SEED_DEMO_PASSWORD must be at least 12 characters');
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function seed(prisma: PrismaClient, demoPassword?: string): Promise<void> {
  const passwordHash = await demoPasswordHash(demoPassword);
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email: DEMO_EMAIL },
      update: demoPassword ? { passwordHash } : {},
      create: { email: DEMO_EMAIL, name: 'Demo User', passwordHash },
    });

    const owned = await tx.workspaceMember.findFirst({
      where: { userId: user.id, role: WorkspaceRole.OWNER },
    });
    if (owned) return;

    const workspace = await tx.workspace.create({
      data: {
        name: 'Demo Workspace',
        members: { create: { userId: user.id, role: WorkspaceRole.OWNER } },
      },
    });
    await tx.workflow.create({
      data: {
        workspaceId: workspace.id,
        name: 'Demo: manual trigger → log',
        createdById: user.id,
        draftDefinition: demoDefinition,
      },
    });
  });
}

async function main(): Promise<void> {
  assertSeedAllowed(process.env.NODE_ENV);
  const prisma = new PrismaClient();
  try {
    await seed(prisma, process.env.SEED_DEMO_PASSWORD);
    console.log(`Seeded demo workspace for ${DEMO_EMAIL}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
