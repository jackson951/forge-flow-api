import { NestExpressApplication } from '@nestjs/platform-express';

export interface RouteInfo {
  method: string;
  path: string;
}

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Every route registered on the running app, read from the Express router. */
export function listRoutes(app: NestExpressApplication): RouteInfo[] {
  const instance = app.getHttpAdapter().getInstance() as {
    router?: { stack: ExpressLayer[] };
    _router?: { stack: ExpressLayer[] };
  };
  const stack = instance.router?.stack ?? instance._router?.stack ?? [];
  return stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route!.methods)
        .filter((m) => m !== '_all')
        .map((m) => ({ method: m.toUpperCase(), path: layer.route!.path })),
    );
}

/** Fills `:param` placeholders, e.g. `{ workspaceId: '…' }`; unknown params use `fallback`. */
export function fillPath(
  path: string,
  values: Record<string, string>,
  fallback: (name: string) => string,
): string {
  return path.replace(/:(\w+)/g, (_m, name: string) => values[name] ?? fallback(name));
}
