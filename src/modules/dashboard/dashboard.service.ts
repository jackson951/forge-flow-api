import { Injectable } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { describeError } from '../../engine/error-categories';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const HOUR = 60 * 60_000;
const TOP_FAILING = 5;
const RECENT_FAILURES = 10;

type StatusCounts = Record<RunStatus, number> & { total: number };

/** Workspace summary (Part 16). Aggregates in the database; uses the run indexes. */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(workspaceId: string, now = new Date()) {
    const since24h = new Date(now.getTime() - 24 * HOUR);
    const since7d = new Date(now.getTime() - 7 * 24 * HOUR);

    const [last24h, last7d, failingGroups, recent] = await Promise.all([
      this.countByStatus(workspaceId, since24h),
      this.countByStatus(workspaceId, since7d),
      this.prisma.workflowRun.groupBy({
        by: ['workflowId'],
        where: { workspaceId, status: RunStatus.FAILED, createdAt: { gte: since7d } },
        _count: { _all: true },
        orderBy: { _count: { workflowId: 'desc' } },
        take: TOP_FAILING,
      }),
      this.prisma.workflowRun.findMany({
        where: { workspaceId, status: RunStatus.FAILED },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: RECENT_FAILURES,
        select: {
          id: true,
          workflowId: true,
          workflow: { select: { name: true } },
          lastErrorCategory: true,
          errorMessage: true,
          createdAt: true,
          completedAt: true,
        },
      }),
    ]);

    const names = new Map(
      (
        await this.prisma.workflow.findMany({
          where: { workspaceId, id: { in: failingGroups.map((g) => g.workflowId) } },
          select: { id: true, name: true },
        })
      ).map((w) => [w.id, w.name]),
    );

    return {
      generatedAt: now,
      runs: { last24h, last7d },
      topFailingWorkflows: failingGroups.map((g) => ({
        workflowId: g.workflowId,
        workflowName: names.get(g.workflowId) ?? null,
        failedRuns: g._count._all,
      })),
      recentFailures: recent.map((r) => ({
        runId: r.id,
        workflowId: r.workflowId,
        workflowName: r.workflow.name,
        error: describeError(r.lastErrorCategory, r.errorMessage),
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      })),
    };
  }

  private async countByStatus(workspaceId: string, since: Date): Promise<StatusCounts> {
    const groups = await this.prisma.workflowRun.groupBy({
      by: ['status'],
      where: { workspaceId, createdAt: { gte: since } },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(Object.values(RunStatus).map((s) => [s, 0])) as StatusCounts;
    counts.total = 0;
    for (const g of groups) {
      counts[g.status] = g._count._all;
      counts.total += g._count._all;
    }
    return counts;
  }
}
