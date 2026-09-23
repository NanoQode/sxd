import type { PipelineLogger, PipelineOptions } from './types';

/** Resolved runtime settings for one pipeline call. */
export interface PipelineEnv {
  appEnv: string;
  nodeEnv: string;
  production: boolean;
  now: () => Date;
  appUrl: string;
  brandName: string;
  log: PipelineLogger;
  options: PipelineOptions;
}

const silentLogger: PipelineLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function resolveEnv(options: PipelineOptions = {}): PipelineEnv {
  const appEnv = options.appEnv ?? process.env.APP_ENV ?? 'development';
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  return {
    appEnv,
    nodeEnv,
    production: appEnv === 'production',
    now: options.now ?? (() => new Date()),
    appUrl: (options.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    brandName: options.brandName ?? process.env.APP_NAME ?? 'SimplexD',
    log: options.log ?? silentLogger,
    options,
  };
}

export const EMAIL_FOOTER =
  'You receive this message because of your SimplexD account or a request you made. Manage notification preferences in your portal settings.';
