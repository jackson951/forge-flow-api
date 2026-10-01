import { PrismaClient, WorkspaceRole } from '@prisma/client';

/** Development-only demo data. Idempotent: safe to run repeatedly. */

export const DEMO_EMAIL = 'demo@flowforge.local';

/**
 * Not a valid argon2 hash, so the demo account cannot log in until Part 03 (authentication)
 * provides real password hashing. The `!` prefix follows the /etc/shadow "locked" convention.
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

export async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email: DEMO_EMAIL },
      update: {},
      create: { email: DEMO_EMAIL, name: 'Demo User', passwordHash: UNUSABLE_PASSWORD_HASH },
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
    await seed(prisma);
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
