import { Controller, Get, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators';
import { HookIntakeService } from './hook-intake.service';

type HookRequest = Request & { id?: string };

const SUMMARY =
  'Generic inbound webhook: verifies, deduplicates, filters and queues a run (if this method is enabled on the hook)';

/**
 * Public generic webhook endpoint (Part 24). Authenticated by the hook's verification mode,
 * not a bearer token. The body arrives as raw bytes (see app.setup.ts). Exactly the methods a
 * hook may enable are routed; the hook's own config narrows them further (405).
 */
@ApiTags('Webhooks')
@Public()
@Controller('webhooks/hooks')
export class HooksController {
  constructor(private readonly intake: HookIntakeService) {}

  @Post(':hookId')
  @ApiOperation({ summary: SUMMARY })
  post(@Param('hookId') hookId: string, @Req() req: HookRequest, @Res() res: Response) {
    return this.receive(hookId, req, res);
  }

  @Put(':hookId')
  @ApiOperation({ summary: SUMMARY })
  put(@Param('hookId') hookId: string, @Req() req: HookRequest, @Res() res: Response) {
    return this.receive(hookId, req, res);
  }

  @Patch(':hookId')
  @ApiOperation({ summary: SUMMARY })
  patch(@Param('hookId') hookId: string, @Req() req: HookRequest, @Res() res: Response) {
    return this.receive(hookId, req, res);
  }

  @Get(':hookId')
  @ApiOperation({ summary: `${SUMMARY}; also answers challenge-echo validation` })
  get(@Param('hookId') hookId: string, @Req() req: HookRequest, @Res() res: Response) {
    return this.receive(hookId, req, res);
  }

  private async receive(hookId: string, req: HookRequest, res: Response): Promise<void> {
    const reply = await this.intake.receive(
      hookId,
      {
        method: req.method.toUpperCase(),
        headers: req.headers,
        query: req.query as Record<string, unknown>,
        rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        sourceIp: req.ip ?? '',
      },
      req.id,
    );
    if (reply.retryAfterSeconds) res.setHeader('Retry-After', String(reply.retryAfterSeconds));
    res.status(reply.status);
    if (reply.text !== undefined) res.type('text/plain').send(reply.text);
    else if (reply.body !== undefined) res.json(reply.body);
    else res.end();
  }
}
