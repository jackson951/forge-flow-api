import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { WorkflowRunProcessor } from './processors';
import { WorkerHeartbeat } from './worker-heartbeat.service';

const logger = { setContext: jest.fn(), warn: jest.fn() } as never;
const heartbeat = (file: string | undefined, running: boolean) =>
  new WorkerHeartbeat(
    { get: () => file } as unknown as AppConfigService,
    { worker: { isRunning: () => running } } as unknown as WorkflowRunProcessor,
    logger,
  );
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('WorkerHeartbeat', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ff-hb-')), 'worker.heartbeat');

  it('writes the file while the consumer runs and removes it on shutdown', async () => {
    const hb = heartbeat(file, true);
    hb.onApplicationBootstrap();
    await settle();
    expect(Date.now() - Date.parse(readFileSync(file, 'utf8'))).toBeLessThan(5_000);
    await hb.onApplicationShutdown();
    expect(existsSync(file)).toBe(false);
  });

  it('writes nothing when the consumer is not running, or when disabled', async () => {
    const stopped = heartbeat(file, false);
    stopped.onApplicationBootstrap();
    await settle();
    expect(existsSync(file)).toBe(false);
    await stopped.onApplicationShutdown();

    const disabled = heartbeat(undefined, true);
    disabled.onApplicationBootstrap();
    await disabled.onApplicationShutdown();
    expect(existsSync(file)).toBe(false);
  });
});
