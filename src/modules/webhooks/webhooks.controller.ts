import { Body, Controller, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators';
import { byProviderAndIp, MINUTE, RATE_LIMITS } from '../../common/throttling/rate-limits';
import { IntakeResult, WebhookIntakeService } from './webhook-intake.service';

type RawRequest = Request & { rawBody?: Buffer; id?: string };

@ApiTags('Webhooks')
@Public() // authenticated by provider signature, not a bearer token
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly intake: WebhookIntakeService) {}

  @Throttle({
    default: {
      limit: RATE_LIMITS.webhookPerProviderAndIp,
      ttl: MINUTE,
      getTracker: byProviderAndIp,
    },
  })
  @ApiAcceptedResponse({ description: '{ accepted, duplicate: false, deliveryId, runs }' })
  @ApiOkResponse({ description: 'Duplicate delivery: { accepted, duplicate: true, deliveryId }' })
  @ApiUnauthorizedResponse({ description: 'Invalid signature or outside the replay window' })
  @ApiNotFoundResponse({ description: 'Unknown or disabled provider' })
  @ApiPayloadTooLargeResponse()
  @Post(':provider')
  @ApiOperation({
    summary: 'Inbound provider webhook: verifies the signature, deduplicates, queues runs',
  })
  async receive(
    @Param('provider') provider: string,
    @Req() req: RawRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IntakeResult> {
    const result = await this.intake.receive(
      provider,
      {
        headers: req.headers,
        rawBody: req.rawBody ?? Buffer.alloc(0),
        body,
        query: req.query as Record<string, unknown>,
      },
      req.id,
    );
    res.status(result.duplicate ? HttpStatus.OK : HttpStatus.ACCEPTED);
    return result;
  }
}
