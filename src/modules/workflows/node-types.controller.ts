import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NodeTypeCatalog } from '../../engine/catalog/node-type-catalog';

/** Node types the builder can offer. Static and identical for every workspace. */
@ApiTags('Workflows')
@ApiBearerAuth()
@Controller('node-types')
export class NodeTypesController {
  constructor(private readonly catalog: NodeTypeCatalog) {}

  @Get()
  list() {
    return this.catalog.list().map(({ type, kind, displayName }) => ({ type, kind, displayName }));
  }
}
