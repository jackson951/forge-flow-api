import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * AC-08.8: the execution engine and the definition/validation core are framework-free.
 * They may use zod and Prisma *types/enums*, but never Nest, the database client service,
 * HTTP/controllers, feature modules, queues or provider SDKs. Nest wrappers live outside
 * these folders (engine.module.ts, executor/, conditions/, src/execution/).
 */
const PURE_DIRS = ['execution', 'definition', 'validation', 'catalog'];
const PURE_FILES = ['errors.ts'];
const FORBIDDEN = [
  /from '@nestjs\//,
  /from 'bullmq'/,
  /from 'express'/,
  /infrastructure\/prisma/,
  /\/modules\//,
  /\.controller'/,
  /from '(@octokit|@slack|@azure|@anthropic-ai|openai|axios)/,
];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('engine architecture', () => {
  const files = [
    ...PURE_DIRS.flatMap((d) => tsFiles(join(__dirname, d))),
    ...PURE_FILES.map((f) => join(__dirname, f)),
  ];

  it('finds the engine sources', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files.map((f) => [relative(__dirname, f), f]))(
    '%s has no forbidden imports',
    (_name, file) => {
      const imports = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /^\s*import .* from /.test(line));
      const violations = imports.filter((line) => FORBIDDEN.some((re) => re.test(line)));
      expect(violations).toEqual([]);
    },
  );
});
