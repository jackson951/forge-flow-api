import { Injectable, NotImplementedException } from '@nestjs/common';

export interface ClassificationResult {
  category: string;
  confidence: number;
}

/**
 * Server-side AI provider adapter. Used as a workflow step, never exposed directly.
 * Outputs must be schema-validated before downstream steps consume them.
 */
@Injectable()
export class AiService {
  summarize(_text: string): Promise<string> {
    throw new NotImplementedException();
  }

  classify(_text: string, _categories: string[]): Promise<ClassificationResult> {
    throw new NotImplementedException();
  }

  extract<T>(_text: string, _jsonSchema: Record<string, unknown>): Promise<T> {
    throw new NotImplementedException();
  }
}
