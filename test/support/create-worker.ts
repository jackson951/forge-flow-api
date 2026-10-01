import { Test, TestingModule } from '@nestjs/testing';
import { NodeTypeCatalog } from '../../src/engine/catalog/node-type-catalog';
import { NodeHandlerRegistry } from '../../src/engine/execution/handler-registry';
import { WorkerModule } from '../../src/worker.module';
import { registerTestHandlers, registerTestTypes, TestNodeControl } from './test-node-types';

/**
 * Boots the real WorkerModule in-process (BullMQ processors start on init), with the
 * test node types registered before the handler/catalog consistency check runs.
 */
export async function createTestWorker(control: TestNodeControl): Promise<TestingModule> {
  const worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  registerTestTypes(worker.get(NodeTypeCatalog));
  registerTestHandlers(worker.get(NodeHandlerRegistry), control);
  await worker.init();
  return worker;
}

/** Polls until `check` returns a value (not undefined) or the timeout passes. */
export async function waitFor<T>(
  check: () => Promise<T | undefined>,
  { timeoutMs = 15_000, intervalMs = 50, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
