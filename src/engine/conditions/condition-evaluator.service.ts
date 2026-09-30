import { Injectable, NotImplementedException } from '@nestjs/common';

export type ConditionOperator = 'equals' | 'notEquals' | 'contains' | 'gt' | 'lt' | 'exists';

export interface ConditionConfig {
  field: string;
  operator: ConditionOperator;
  value?: unknown;
}

@Injectable()
export class ConditionEvaluatorService {
  evaluate(_config: ConditionConfig, _input: unknown): boolean {
    throw new NotImplementedException();
  }
}
