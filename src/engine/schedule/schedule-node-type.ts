import { NodeTypeDefinition } from '../catalog/node-type-catalog';
import { NodeHandler } from '../execution/node-handler';
import { scheduleConfigSchema, ScheduleTriggerConfig } from './schedule';

export const SCHEDULE_TRIGGER = 'schedule.trigger';

/** The minimum gap between occurrences is an operator setting, so the type is built from it. */
export function scheduleNodeType(minIntervalMinutes: number): NodeTypeDefinition {
  return {
    type: SCHEDULE_TRIGGER,
    kind: 'TRIGGER',
    displayName: 'Schedule',
    configSchema: scheduleConfigSchema(minIntervalMinutes),
    schedule: (config) => (config as ScheduleTriggerConfig).schedule,
  };
}

/**
 * Like the manual trigger, its output is the run's trigger input — for scheduled runs the
 * system-built `{ triggerType: 'SCHEDULE', scheduledFor, … }`, never user input (FR-23.9).
 */
export const scheduleTriggerHandler: NodeHandler = {
  type: SCHEDULE_TRIGGER,
  kind: 'TRIGGER',
  sideEffect: 'none',
  execute: async ({ triggerInput }) => ({ output: triggerInput ?? {} }),
};
