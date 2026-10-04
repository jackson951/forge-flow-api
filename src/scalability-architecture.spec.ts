import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Part 21, FR-21.6: lists use keyset pagination. OFFSET pagination gets slower with every
 * page (the database reads and discards all skipped rows) and shifts when rows are inserted.
 */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

const files = tsFiles(__dirname).map((path) => ({
  path: relative(__dirname, path).split(sep).join('/'),
  source: readFileSync(path, 'utf8'),
}));

describe('scalability architecture', () => {
  it('no query uses OFFSET pagination (Prisma `skip` or SQL OFFSET)', () => {
    const offenders = files
      .filter((f) => /\bskip:\s/.test(f.source) || /\bOFFSET\b/.test(f.source))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('every list endpoint pages with a cursor and a bounded take', () => {
    const lists = files.filter((f) => /findMany\(\{[\s\S]*?take: limit \+ 1/.test(f.source));
    expect(lists.map((f) => f.path).sort()).toEqual([
      'modules/hooks/hook-admin.service.ts', // webhook deliveries (receivedAt, id)
      'modules/runs/runs.service.ts',
      'modules/workflows/publishing.service.ts', // versions
      'modules/workflows/workflows.service.ts',
    ]);
    // Keyset cursors: (createdAt, id) for runs and workflows, the version number for versions.
    for (const f of lists) expect(f.source).toMatch(/nextCursor/);
  });
});
