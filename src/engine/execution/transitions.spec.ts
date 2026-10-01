import { RunStatus, StepStatus } from '@prisma/client';
import {
  canTransitionRun,
  canTransitionStep,
  isTerminalRun,
  runStatusesLeadingTo,
  stepStatusesLeadingTo,
} from './transitions';

describe('run transitions', () => {
  it.each([
    ['QUEUED', 'RUNNING', true],
    ['RUNNING', 'SUCCEEDED', true],
    ['RUNNING', 'QUEUED', true],
    ['RUNNING', 'RUNNING', true],
    ['QUEUED', 'CANCELLED', true],
    ['QUEUED', 'SUCCEEDED', false],
    ['SUCCEEDED', 'RUNNING', false],
    ['FAILED', 'QUEUED', false],
    ['CANCELLED', 'RUNNING', false],
  ] as [RunStatus, RunStatus, boolean][])('%s → %s allowed: %s', (from, to, allowed) => {
    expect(canTransitionRun(from, to)).toBe(allowed);
  });

  it('terminal states are SUCCEEDED, FAILED, CANCELLED', () => {
    expect(Object.values(RunStatus).filter(isTerminalRun).sort()).toEqual([
      'CANCELLED',
      'FAILED',
      'SUCCEEDED',
    ]);
  });

  it('only QUEUED and RUNNING lead to RUNNING (claim)', () => {
    expect(runStatusesLeadingTo('RUNNING').sort()).toEqual(['QUEUED', 'RUNNING']);
  });
});

describe('step transitions', () => {
  it.each([
    ['PENDING', 'RUNNING', true],
    ['RUNNING', 'SUCCEEDED', true],
    ['RUNNING', 'RETRYING', true],
    ['RETRYING', 'RUNNING', true],
    ['PENDING', 'SKIPPED', true],
    ['PENDING', 'SUCCEEDED', false],
    ['SUCCEEDED', 'RUNNING', false],
    ['SKIPPED', 'RUNNING', false],
    ['FAILED', 'RETRYING', false],
  ] as [StepStatus, StepStatus, boolean][])('%s → %s allowed: %s', (from, to, allowed) => {
    expect(canTransitionStep(from, to)).toBe(allowed);
  });

  it('a succeeded step can never be started again', () => {
    expect(stepStatusesLeadingTo('RUNNING')).not.toContain('SUCCEEDED');
  });
});
