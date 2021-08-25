import { Lifecycle } from "@/_lib/Lifecycle";

type HookFn = () => Promise<void>;

type HookStore = {
  get: (lifecycle: Lifecycle) => HookFn[];
  append: (lifecycle: Lifecycle, ...fn: HookFn[]) => void;
  prepend: (lifecycle: Lifecycle, ...fn: HookFn[]) => void;
};

type Application = {
  getState: () => AppState;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  terminate: () => void;
  once: (lifecycle: Lifecycle, fn: HookFn | HookFn[], order?: "append" | "prepend") => void;
};

const memo = <F extends (...args: any[]) => any>(fn: F) => {
  let value: ReturnType<F>;

  return (...args: Parameters<F>): ReturnType<F> => {
    if (!value) {
      value = fn(args);
    }

    return value;
  };
};

type ApplicationOptions = {
  shutdownTimeout: number;
  logger: Pick<Console, "info" | "error" | "warn">;
};

const appLifecycle = [
  Lifecycle.BOOTING,
  Lifecycle.BOOTED,
  Lifecycle.READY,
  Lifecycle.RUNNING,
  Lifecycle.SHUTTING_DOWN,
  Lifecycle.TERMINATED,
];

const makeAppLifecycleManager = (stateMap: Lifecycle[]) => {
  let current: Lifecycle;

  const canTransition = (lifecycle: Lifecycle): boolean => appLifecycle.indexOf(current) < stateMap.indexOf(lifecycle);

  return {
    makeTransition:
      <R, D>(callback: (lifecycle: Lifecycle) => R, or: D): ((lifecycle: Lifecycle) => R | D) =>
      (lifecycle: Lifecycle) => {
        if (canTransition(lifecycle)) {
          current = lifecycle;
          return callback(lifecycle);
        }
        return or;
      },
  };
};

enum AppState {
  IDLE = "IDLE",
  STARTING = "STARTING",
  STARTED = "STARTED",
  STOPPING = "STOPPING",
  STOPPED = "STOPED",
}

const makeApp = ({ logger, shutdownTimeout }: ApplicationOptions): Application => {
  let appState: AppState = AppState.IDLE;
  const { makeTransition } = makeAppLifecycleManager(appLifecycle);
  let release: null | (() => void);

  const hooks = makeHookStore();

  const started: HookFn = () =>
    new Promise<void>((resolve) => {
      logger.info("Application started");

      appState = AppState.STARTED;

      release = resolve;
    });

  const status = (newStatus: AppState) => async () => {
    appState = newStatus;
  };

  const transition = makeTransition((lifecycle: Lifecycle) => [() => promiseChain(hooks.get(lifecycle))], []);

  const start = memo(async () => {
    if (appState !== AppState.IDLE) throw new Error("The application has already started.");

    logger.info("Starting application");

    try {
      await promiseChain([
        status(AppState.STARTING),
        ...transition(Lifecycle.BOOTING),
        ...transition(Lifecycle.BOOTED),
        ...transition(Lifecycle.READY),
        ...transition(Lifecycle.RUNNING),
        started,
      ]);
    } catch (err) {
      logger.error(err);

      await stop();
    }
  });

  const stop = memo(async () => {
    if (appState === AppState.IDLE) throw new Error("The application is not running.");

    if (release) {
      release();
      release = null;
    }

    logger.info("Stopping application");

    await promiseChain([
      status(AppState.STOPPING),
      ...transition(Lifecycle.SHUTTING_DOWN),
      ...transition(Lifecycle.TERMINATED),
      status(AppState.STOPPED),
    ]);

    setTimeout(() => {
      logger.warn(
        "The stop process has finished but something is keeping the application from exiting. Check your cleanup process!"
      );
    }, 5000).unref();
  });

  let forceShutdown = false;

  const shutdown = (code: number) => async () => {
    process.stdout.write("\n");

    setTimeout(() => {
      logger.error("Ok, my patience is over! #ragequit");
      process.exit(code);
    }, shutdownTimeout).unref();

    if (appState === AppState.STOPPING && code === 0) {
      if (forceShutdown) {
        process.exit(code);
      }

      logger.warn("The application is yet to finishing the shutdown process. Repeat the command to force exit");
      forceShutdown = true;
      return;
    }

    if (appState !== AppState.STOPPED) {
      try {
        await stop();
      } catch (err) {
        logger.error(err);
      }
    }

    process.exit(code);
  };

  const terminate = () => process.kill(process.pid, "SIGTERM");

  process.on("SIGTERM", shutdown(0));
  process.on("SIGINT", shutdown(0));
  process.on("uncaughtException", shutdown(1));
  process.on("unhandledRejection", shutdown(1));

  return {
    start,
    stop,
    terminate,
    getState: () => appState,
    once: (lifecycle, fn, order = "append") =>
      Array.isArray(fn) ? hooks[order](lifecycle, ...fn) : hooks[order](lifecycle, fn),
  };
};

const promiseChain = <M extends HookFn[]>(hooksFns: M) => {
  return hooksFns.reduce((chain, fn) => chain.then(fn), Promise.resolve());
};

const makeHookStore = (): HookStore => {
  const hooks = new Map<Lifecycle, HookFn[]>();

  const get = (lifecycle: Lifecycle) => hooks.get(lifecycle) || [];

  const append = (lifecycle: Lifecycle, ...fn: HookFn[]) => hooks.set(lifecycle, [...get(lifecycle), ...fn]);

  const prepend = (lifecycle: Lifecycle, ...fn: HookFn[]) => hooks.set(lifecycle, [...fn, ...get(lifecycle)]);

  return {
    get,
    append,
    prepend,
  };
};

export { makeApp };
export type { Application, HookFn };
