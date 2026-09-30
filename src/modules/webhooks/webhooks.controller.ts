import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IntegrationProviderKey } from '@prisma/client';
import { Request } from 'express';
import { Public } from '../../common/decorators';
import { WebhooksService } from './webhooks.service';

@ApiTags('Webhooks')
@Public() // authenticated by provider signature, not bearer token
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post(':provider')
  receive(
    @Param('provider', new ParseEnumPipe(IntegrationProviderKey)) provider: IntegrationProviderKey,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
  ) {
    return this.webhooks.receive({ provider, headers, rawBody: req.rawBody, body });
  }
}
