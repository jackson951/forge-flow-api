import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { aiNodeTypes } from '../modules/ai/ai.node-types';
import { GITHUB_NODE_TYPES } from '../modules/integrations/github/github.node-types';
import { BUILT_IN_NODE_TYPES, NodeTypeCatalog } from './catalog/node-type-catalog';
import { DefinitionValidatorService } from './executor/definition-validator.service';

/**
 * Definition-level engine services used by both API (validation) and worker. Execution
 * itself lives in the worker-only ExecutionModule.
 */
@Module({
  providers: [
    // One catalog per application (a factory, not a shared instance), so registrations in
    // one app or test never leak into another.
    {
      provide: NodeTypeCatalog,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new NodeTypeCatalog([
          ...BUILT_IN_NODE_TYPES,
          ...GITHUB_NODE_TYPES,
          ...aiNodeTypes(Boolean(config.ai.provider)),
        ]),
    },
    DefinitionValidatorService,
  ],
  exports: [NodeTypeCatalog, DefinitionValidatorService],
})
export class EngineModule {}
