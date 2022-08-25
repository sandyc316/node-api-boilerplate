import { makeModule } from '@/context';
import { errorHandler } from '@/_lib/http/middlewares/errorHandler';
import { gracefulShutdown } from '@/_lib/http/middlewares/gracefulShutdown';
import { httpLogger, reqStartTimeKey } from '@/_lib/http/middlewares/httpLogger';
import { requestContainer } from '@/_lib/http/middlewares/requestContainer';
import { requestId } from '@/_lib/http/middlewares/requestId';
import { statusHandler } from '@/_lib/http/middlewares/statusHandler';
import { errorConverters } from '@/_sharedKernel/interface/http/ErrorConverters';
import { asValue } from 'awilix';
import cors from 'cors';
import express, { Application, json, Router, urlencoded } from 'express';
import helmet from 'helmet';
import { createServer, Server } from 'http';

type ServerConfig = {
  http: {
    host: string;
    port: number;
    cors?:
      | boolean
      | {
          allowedOrigins: string | string[];
        };
  };
};

const server = makeModule(
  'server',
  async ({ app: { onBooted, onReady }, container, config: { cli, http, environment }, logger }) => {
    const { register } = container;
    const server = express();

    const httpServer = createServer(server);

    const { shutdownHook, shutdownHandler } = gracefulShutdown(httpServer);

    server.use((req, res, next) => {
      res[reqStartTimeKey] = Date.now();

      next();
    });

    server.use(shutdownHandler());

    if (http.cors) {
      server.use((req, res, next) => {
        return cors({
          allowedHeaders:
            'accept, accept-encoding, origin, referer, sec-fetch-*, user-agent, content-type, authorization',
          credentials: true,
          origin: typeof http.cors === 'boolean' ? req.get('origin') : http.cors?.allowedOrigins,
          methods: '*',
        })(req, res, next);
      });
    }

    server.use(requestId());
    server.use(requestContainer(container));
    server.use(httpLogger());
    server.use(helmet());
    server.use(json());
    server.use(urlencoded({ extended: false }));

    const rootRouter = Router();
    const apiRouter = Router();

    rootRouter.get('/status', statusHandler);
    rootRouter.use('/api', apiRouter);

    server.use(rootRouter);

    onBooted(async () => {
      server.use((_, res) => {
        res.sendStatus(404);
      });

      server.use(errorHandler(errorConverters, { logger }));
    });

    if (!cli && environment !== 'test') {
      onReady(
        async () =>
          new Promise<void>((resolve) => {
            httpServer.listen(http.port, http.host, () => {
              logger.info(`Webserver listening at: http://${http.host}:${http.port}`);
              resolve();
            });
          })
      );
    }

    register({
      requestId: asValue(undefined),
      server: asValue(server),
      httpServer: asValue(httpServer),
      rootRouter: asValue(rootRouter),
      apiRouter: asValue(apiRouter),
    });

    return async () => {
      await shutdownHook();
    };
  }
);

type ServerRegistry = {
  requestId?: string;
  server: Application;
  httpServer: Server;
  rootRouter: Router;
  apiRouter: Router;
};

export { server };
export type { ServerRegistry, ServerConfig };
