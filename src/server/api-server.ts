import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'path';
import type { Server } from 'http';
import type { ServiceContainer } from '../types/command';
import type { FollowOptions } from '../types/api';
import { getVersion } from '../utils/command-helpers';

type AsyncRouteHandler = (req: Request, res: Response) => Promise<void>;

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    const [head] = value;
    return typeof head === 'string' ? head : undefined;
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  const text = firstString(value);
  if (text === undefined) {
    return undefined;
  }
  const parsed = parseFloat(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toBoolean(value: unknown): boolean | undefined {
  const text = firstString(value);
  if (text === undefined) {
    return undefined;
  }
  return text.toLowerCase() === 'true';
}

function asyncHandler(handler: AsyncRouteHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function toFixedString(value: number, decimals = 8): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toFixed(decimals);
}

function computeUnrealizedPnl(positions: any[]): number {
  return positions.reduce((acc, position) => {
    const raw = position?.unRealizedProfit ?? position?.unrealizedPnl ?? position?.unRealizedPnl ?? '0';
    const parsed = parseFloat(raw);
    return acc + (Number.isFinite(parsed) ? parsed : 0);
  }, 0);
}

export function buildApiApp(services: ServiceContainer, staticDir?: string) {
  const app = express();
  app.disable('x-powered-by');

  const resolvedStaticDir = staticDir ?? path.join(process.cwd(), 'dashboard');
  app.use(express.static(resolvedStaticDir));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(resolvedStaticDir, 'index.html'));
  });

  app.get(
    '/health',
    (_req, res) => {
      res.json({
        status: 'ok',
        version: getVersion(),
        exchange: services.executor.getExchangeLabel(),
        testnet: services.executor.isTestnet(),
        timestamp: new Date().toISOString()
      });
    }
  );

  const apiRouter = express.Router();

  apiRouter.get(
    '/config',
    (_req, res) => {
      const hasConfig = Boolean(
        (process.env.BYBIT_API_KEY || process.env.EXCHANGE_API_KEY) &&
        (process.env.BYBIT_API_SECRET || process.env.EXCHANGE_API_SECRET)
      );
      res.json({
        hasConfig,
        exchange: services.executor.getExchangeLabel(),
        testnet: services.executor.isTestnet(),
        timestamp: new Date().toISOString()
      });
    }
  );

  apiRouter.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const connected = await services.executor.validateConnection();
      const config = services.analyzer.getConfigManager().getConfig();
      res.json({
        connected,
        exchange: services.executor.getExchangeLabel(),
        config,
        timestamp: new Date().toISOString()
      });
    })
  );

  apiRouter.get(
    '/account',
    asyncHandler(async (_req, res) => {
      const [account, positions] = await Promise.all([
        services.executor.getAccountInfo(),
        services.executor.getAllPositions()
      ]);

      const reportedUnrealizedRaw = account?.totalUnrealizedProfit ?? account?.totalUnrealizedPnl;
      const reportedUnrealized = typeof reportedUnrealizedRaw === 'string' ? parseFloat(reportedUnrealizedRaw) : Number(reportedUnrealizedRaw);
      const computedUnrealized = computeUnrealizedPnl(positions);
      const totalUnrealized = Number.isFinite(reportedUnrealized) ? reportedUnrealized : computedUnrealized;
      const enrichedAccount = {
        ...account,
        exchange: services.executor.getExchangeLabel(),
        testnet: services.executor.isTestnet(),
        totalUnrealizedProfit: toFixedString(totalUnrealized),
        totalUnrealizedPnl: toFixedString(totalUnrealized),
        timestamp: new Date().toISOString()
      };

      res.json(enrichedAccount);
    })
  );

  apiRouter.get(
    '/positions',
    asyncHandler(async (req, res) => {
      const includeZero = toBoolean(req.query.includeZero) === true;
      const positions = includeZero
        ? await services.executor.getAllPositions()
        : await services.executor.getPositions();

      const normalized = positions.map(position => ({
        ...position,
        marginType: (position.marginType ?? '').toString().toLowerCase()
      }));

      res.json(normalized);
    })
  );

  apiRouter.get(
    '/trades',
    asyncHandler(async (req, res) => {
      const limitQuery = toNumber(req.query.limit) ?? 25;
      const limit = Math.min(Math.max(Math.trunc(limitQuery), 1), 1000);
      const trades = await services.executor.getRecentTrades(limit);
      const sorted = [...trades].sort((a, b) => {
        const timeA = typeof a.time === 'number' ? a.time : 0;
        const timeB = typeof b.time === 'number' ? b.time : 0;
        return timeB - timeA;
      });
      res.json(sorted.slice(0, limit));
    })
  );

  apiRouter.get(
    '/agents',
    asyncHandler(async (_req, res) => {
      const agents = await services.analyzer.getAvailableAgents();
      res.json({ agents });
    })
  );

  apiRouter.get(
    '/agents/:agent/follow-plans',
    asyncHandler(async (req, res) => {
      const { agent } = req.params;
      const followOptions: FollowOptions = {};

      const totalMargin = toNumber(req.query.totalMargin);
      if (totalMargin !== undefined) {
        followOptions.totalMargin = totalMargin;
      }

      const fixedAmountPerCoin = toNumber(req.query.fixedAmountPerCoin);
      if (fixedAmountPerCoin !== undefined) {
        followOptions.fixedAmountPerCoin = fixedAmountPerCoin;
      }

      const profitTarget = toNumber(req.query.profitTarget ?? req.query.profit);
      if (profitTarget !== undefined) {
        followOptions.profitTarget = profitTarget;
      }

      const autoRefollow = toBoolean(req.query.autoRefollow);
      if (autoRefollow !== undefined) {
        followOptions.autoRefollow = autoRefollow;
      }

      const marginType = firstString(req.query.marginType);
      if (marginType === 'ISOLATED' || marginType === 'CROSSED') {
        followOptions.marginType = marginType;
      }

      const plans = await services.analyzer.followAgent(agent, followOptions);
      res.json({
        agent,
        followOptions,
        plans
      });
    })
  );

  if (services.orderHistoryManager) {
    apiRouter.get(
      '/orders/history',
      (_req, res) => {
        services.orderHistoryManager!.reloadHistory();
        res.json({
          processedOrders: services.orderHistoryManager!.getProcessedOrders(),
          profitExits: services.orderHistoryManager!.getProfitExitRecords(),
          manualCloses: services.orderHistoryManager!.getManualCloseRecords(),
          stats: services.orderHistoryManager!.getStats(),
          createdAt: services.orderHistoryManager!.getCreatedAt()
        });
      }
    );
  }

  app.use('/api', apiRouter);

  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      console.error('❌ API error:', message);
      res.status(500).json({ error: message });
    }
  );

  return app;
}

export interface StartApiServerOptions {
  services: ServiceContainer;
  port: number;
  host: string;
  staticDir?: string;
}

export interface ApiServerHandle {
  close: () => Promise<void>;
  server: Server;
  host: string;
  port: number;
}

export async function startApiServer(options: StartApiServerOptions): Promise<ApiServerHandle> {
  const { services, port, host, staticDir } = options;
  const app = buildApiApp(services, staticDir);

  return await new Promise<ApiServerHandle>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`🚀 API server listening on http://${host}:${port}`);
      resolve({
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close(err => {
              if (err) {
                closeReject(err);
              } else {
                closeResolve();
              }
            });
          }),
        server,
        host,
        port
      });
    });

    server.on('error', reject);
  });
}
