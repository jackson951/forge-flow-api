import { Module, OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { NodeTypeCatalog } from '../engine/catalog/node-type-catalog';
import { EngineModule } from '../engine/engine.module';
import { BUILT_IN_HANDLERS } from '../engine/execution/built-in-handlers';
import { ExecutionEngine } from '../engine/execution/execution-engine';
import { createExpressionResolver } from '../engine/expressions/expression-resolver';
import { NodeHandlerRegistry } from '../engine/execution/handler-registry';
import { NODE_HANDLERS, NodeHandler } from '../engine/execution/node-handler';
import { AI_PROVIDER, AiProvider } from '../modules/ai/ai-provider';
import { AiModule } from '../modules/ai/ai.module';
import { createAiHandlers } from '../modules/ai/ai.node-types';
import { CredentialStore } from '../modules/integrations/credentials/credential-store';
import { GITHUB_HANDLERS } from '../modules/integrations/github/github.node-types';
import { MicrosoftClient } from '../modules/integrations/microsoft/microsoft-client';
import { MicrosoftTokenManager } from '../modules/integrations/microsoft/microsoft-token-manager';
import { createMicrosoftHandlers } from '../modules/integrations/microsoft/microsoft.node-types';
import { SlackClient } from '../modules/integrations/slack/slack-client';
import { createSlackHandlers } from '../modules/integrations/slack/slack.node-types';
import { PrismaRunStore } from './prisma-run-store';
import { MaintenanceProcessor, RunSweeper, WorkflowRunProcessor } from './processors';
import { RunWorkerService } from './run-worker.service';
import { WorkerConnections } from './worker-connections';

/** Worker-only: the engine, its handlers and the queue processors. */
@Module({
  imports: [EngineModule, AiModule],
  providers: [
    PrismaRunStore,
    CredentialStore,
    SlackClient,
    WorkerConnections,
    MicrosoftClient,
    MicrosoftTokenManager,
    {
      provide: NODE_HANDLERS,
      inject: [
        AI_PROVIDER,
        AppConfigService,
        SlackClient,
        WorkerConnections,
        MicrosoftClient,
        MicrosoftTokenManager,
      ],
      useFactory: (
        ai: AiProvider | null,
        config: AppConfigService,
        slack: SlackClient,
        connections: WorkerConnections,
        microsoft: MicrosoftClient,
        microsoftTokens: MicrosoftTokenManager,
      ): NodeHandler[] => [
        ...BUILT_IN_HANDLERS,
        ...GITHUB_HANDLERS,
        ...createSlackHandlers(slack, connections),
        ...createMicrosoftHandlers(microsoft, microsoftTokens),
        ...createAiHandlers(ai, config.ai),
      ],
    },
    {
      provide: NodeHandlerRegistry,
      inject: [NODE_HANDLERS],
      useFactory: (handlers: NodeHandler[]) => new NodeHandlerRegistry(handlers),
    },
    {
      provide: ExecutionEngine,
      inject: [PrismaRunStore, NodeHandlerRegistry, AppConfigService, PinoLogger],
      useFactory: (
        store: PrismaRunStore,
        registry: NodeHandlerRegistry,
        config: AppConfigService,
        logger: PinoLogger,
      ) => {
        logger.setContext(ExecutionEngine.name);
        const resolver = createExpressionResolver((nodeKey, references) =>
          logger.warn({ nodeKey, references }, 'References resolved to nothing; rendered as empty'),
        );
        return new ExecutionEngine(store, registry, resolver, {
          nodeTimeoutMs: config.queue.nodeTimeoutMs,
          log: (level, message, fields) => logger[level](fields, message),
        });
      },
    },
    RunWorkerService,
    RunSweeper,
    WorkflowRunProcessor,
    MaintenanceProcessor,
  ],
  exports: [NodeHandlerRegistry, RunSweeper, RunWorkerService],
})
export class ExecutionModule implements OnModuleInit {
  constructor(
    private readonly registry: NodeHandlerRegistry,
    private readonly catalog: NodeTypeCatalog,
  ) {}

  /** Refuse to start a worker that could not execute some publishable node type. */
  onModuleInit(): void {
    const problems = this.registry.verifyAgainst(this.catalog);
    if (problems.length) throw new Error(`Worker misconfigured:\n  ${problems.join('\n  ')}`);
  }
}
