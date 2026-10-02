import { StepStatus } from '@prisma/client';
import { OwnershipLostError } from '../../errors';
import { PlannedStep, RunSnapshot, RunStore, StepFailure, StepSnapshot } from '../run-store';
import { canTransitionStep, IllegalTransitionError } from '../transitions';

export interface MemoryStep extends StepSnapshot {
  nodeType: string;
  sequence: number;
  input?: unknown;
  errorCategory?: string;
  errorMessage?: string;
  externalRef?: string;
}

/** RunStore for unit tests. Enforces the same transition rules as PrismaRunStore. */
export class InMemoryRunStore implements RunStore {
  readonly steps = new Map<string, MemoryStep>();
  cancelRequested = false;
  /** Current run claim; fenced writes with another claim throw OwnershipLostError. */
  owner?: string;

  constructor(private readonly run: Omit<RunSnapshot, 'cancelRequested'>) {}

  async loadRun(runId: string): Promise<RunSnapshot | null> {
    return runId === this.run.id ? { ...this.run, cancelRequested: this.cancelRequested } : null;
  }

  async isCancelRequested(): Promise<boolean> {
    return this.cancelRequested;
  }

  async planSteps(_runId: string, planned: PlannedStep[]): Promise<void> {
    for (const s of planned) {
      if (!this.steps.has(s.nodeKey)) {
        this.steps.set(s.nodeKey, {
          nodeKey: s.nodeKey,
          nodeType: s.nodeType,
          sequence: s.sequence,
          status: 'PENDING',
          attemptCount: 0,
          output: null,
        });
      }
    }
  }

  async loadSteps(): Promise<Map<string, StepSnapshot>> {
    return new Map([...this.steps].map(([k, v]) => [k, { ...v }]));
  }

  async startStep(
    _runId: string,
    nodeKey: string,
    input: unknown,
    claim?: string,
  ): Promise<number> {
    this.fence(claim);
    const step = this.transition(nodeKey, 'RUNNING');
    step.attemptCount += 1;
    step.input = input;
    return step.attemptCount;
  }

  async completeStep(
    _runId: string,
    nodeKey: string,
    result: { sanitizedOutput: unknown; externalRef?: string },
  ): Promise<void> {
    const step = this.transition(nodeKey, 'SUCCEEDED');
    step.output = result.sanitizedOutput;
    step.externalRef = result.externalRef;
  }

  async failStep(
    _runId: string,
    nodeKey: string,
    failure: StepFailure,
    claim?: string,
  ): Promise<void> {
    this.fence(claim);
    const step = this.transition(nodeKey, failure.status);
    step.errorCategory = failure.category;
    step.errorMessage = failure.message;
  }

  async skipRemaining(_runId?: string, claim?: string): Promise<void> {
    this.fence(claim);
    for (const step of this.steps.values()) {
      if (step.status === 'PENDING' || step.status === 'RETRYING') step.status = 'SKIPPED';
    }
  }

  private fence(claim?: string): void {
    if (claim !== undefined && this.owner !== undefined && claim !== this.owner) {
      throw new OwnershipLostError(this.run.id);
    }
  }

  /** Test helper: the state as seen by the database, keyed by node. */
  states(): Record<string, StepStatus> {
    return Object.fromEntries([...this.steps].map(([k, v]) => [k, v.status]));
  }

  private transition(nodeKey: string, to: StepStatus): MemoryStep {
    const step = this.steps.get(nodeKey);
    if (!step) throw new IllegalTransitionError('step', 'missing', to);
    if (!canTransitionStep(step.status, to)) {
      throw new IllegalTransitionError('step', step.status, to);
    }
    step.status = to;
    return step;
  }
}
