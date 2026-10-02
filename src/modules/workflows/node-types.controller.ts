import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { NodeTypeCatalog } from '../../engine/catalog/node-type-catalog';

/** Node types the builder can offer. Static and identical for every workspace. */
@ApiTags('Workflows')
@ApiBearerAuth()
@Controller('node-types')
export class NodeTypesController {
  constructor(private readonly catalog: NodeTypeCatalog) {}

  @Get()
  @ApiOperation({ summary: 'Node types that can be used in workflows, with config schemas' })
  list() {
    return this.catalog.list().map(({ type, kind, displayName, unavailableReason }) => ({
      type,
      kind,
      displayName,
      available: !unavailableReason,
    }));
  }
}
