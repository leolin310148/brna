import { brnaMiddleware } from "./middleware.js";

type Middleware = (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
type EnhanceMiddleware = (
  metroMiddleware: Middleware,
  metroServer?: unknown,
) => Middleware;

interface MetroConfig {
  server?: {
    enhanceMiddleware?: EnhanceMiddleware;
    [k: string]: unknown;
  };
  resolver?: {
    unstable_enablePackageExports?: boolean;
    unstable_enableSymlinks?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export function withBrna<C extends MetroConfig>(config: C): C {
  const previous = config.server?.enhanceMiddleware;
  const wrapped: EnhanceMiddleware = (metroMiddleware, metroServer) => {
    const upstream = previous
      ? previous(metroMiddleware, metroServer)
      : metroMiddleware;
    const brna = brnaMiddleware();
    return (req, res, next) => {
      brna(req as Parameters<typeof brna>[0], res as Parameters<typeof brna>[1], (err) => {
        if (err) return next(err);
        upstream(req, res, next);
      });
    };
  };
  return {
    ...config,
    server: {
      ...(config.server ?? {}),
      enhanceMiddleware: wrapped,
    },
    resolver: {
      ...(config.resolver ?? {}),
      unstable_enablePackageExports: true,
      unstable_enableSymlinks: true,
    },
  };
}
