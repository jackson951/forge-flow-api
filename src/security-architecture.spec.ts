import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * AC-17.3 / security boundaries: plaintext credentials are reachable only from code that
 * legitimately needs them. HTTP controllers and the webhook intake never import the
 * credential store or the encryption service directly.
 */
const ALLOWED_CREDENTIAL_IMPORTERS = new Set([
  'modules/integrations/integrations.module.ts',
  'modules/integrations/integrations.service.ts', // OAuth completion, revoke on disconnect
  'modules/integrations/providers/integration-provider.interface.ts', // type only
  'scripts/reencrypt-credentials.ts',
]);

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

describe('security architecture', () => {
  it('only allowed modules import the credential store', () => {
    const importers = files
      .filter((f) => /from '[^']*credentials\/credential-store'/.test(f.source))
      .map((f) => f.path)
      .filter((p) => !p.endsWith('credential-store.ts'));
    expect(importers.filter((p) => !ALLOWED_CREDENTIAL_IMPORTERS.has(p))).toEqual([]);
  });

  it('no controller or webhook code imports credential storage or decryption', () => {
    const offenders = files.filter(
      (f) =>
        (f.path.endsWith('.controller.ts') || f.path.startsWith('modules/webhooks/')) &&
        /credential-store|crypto\/encryption\.service|crypto\/envelope/.test(f.source),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('connection queries for API responses never include the credential relation', () => {
    const service = files.find((f) => f.path === 'modules/integrations/integrations.service.ts')!;
    const select = /CONNECTION_SELECT = \{([\s\S]*?)\}/.exec(service.source)?.[1] ?? '';
    expect(select).not.toMatch(/credential|encrypted/i);
  });
});
