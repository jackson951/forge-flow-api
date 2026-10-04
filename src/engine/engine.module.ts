import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { aiNodeTypes } from '../modules/ai/ai.node-types';
import { GITHUB_NODE_TYPES } from '../modules/integrations/github/github.node-types';
import { MICROSOFT_NODE_TYPES } from '../modules/integrations/microsoft/microsoft.node-types';
import { WEBHOOK_NODE_TYPES } from '../modules/hooks/hook.node-types';
import { JIRA_NODE_TYPES } from '../modules/integrations/jira/jira.node-types';
import { gmailNodeTypes } from '../modules/integrations/gmail/gmail.node-types';
import { httpNodeTypes } from '../modules/integrations/http/http.node-types';
import { SLACK_NODE_TYPES } from '../modules/integrations/slack/slack.node-types';
import { BUILT_IN_NODE_TYPES, NodeTypeCatalog } from './catalog/node-type-catalog';
import { DefinitionValidatorService } from './executor/definition-validator.service';
import { scheduleNodeType } from './schedule/schedule-node-type';

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
          scheduleNodeType(config.schedule.minIntervalMinutes),
          ...GITHUB_NODE_TYPES,
          ...SLACK_NODE_TYPES,
          ...MICROSOFT_NODE_TYPES,
          ...httpNodeTypes(
            config.http.policy,
            config.http.enabled,
            config.schedule.minIntervalMinutes,
          ),
          ...WEBHOOK_NODE_TYPES,
          ...JIRA_NODE_TYPES,
          ...gmailNodeTypes(
            Boolean(
              config.gmail.clientId &&
              config.gmail.topic &&
              config.gmail.pushAudience &&
              config.gmail.pushServiceAccount,
            ),
          ),
          ...aiNodeTypes(Boolean(config.ai.provider)),
        ]),
    },
    DefinitionValidatorService,
  ],
  exports: [NodeTypeCatalog, DefinitionValidatorService],
})
export class EngineModule {}
