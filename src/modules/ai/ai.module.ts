import { Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { AI_PROVIDER, AiProvider } from './ai-provider';
import { AnthropicProvider } from './anthropic.provider';
import { FakeAiProvider } from './fake-ai.provider';

export function createAiProvider(config: AppConfigService): AiProvider | null {
  const ai = config.ai;
  switch (ai.provider) {
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: ai.apiKey!,
        apiUrl: ai.apiUrl,
        model: ai.model,
        timeoutMs: ai.timeoutMs,
      });
    case 'fake':
      return new FakeAiProvider();
    default:
      return null;
  }
}

/** Worker-only: the API never calls the model (steps run in the worker). */
@Module({
  providers: [{ provide: AI_PROVIDER, inject: [AppConfigService], useFactory: createAiProvider }],
  exports: [AI_PROVIDER],
})
export class AiModule {}
