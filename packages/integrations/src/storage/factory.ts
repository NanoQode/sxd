import fs from 'node:fs';
import path from 'node:path';
import { LocalDevStorageProvider, type LocalDevStorageOptions } from './local-dev';
import { S3StorageProvider, type S3StorageOptions } from './s3';
import { StorageError, type StorageProvider, type StorageProviderId } from './types';

export interface StorageFactoryInput {
  appEnv: string;
  provider: StorageProviderId;
  s3?: Omit<S3StorageOptions, 'signedUrlTtlSeconds'>;
  localDev?: Omit<LocalDevStorageOptions, 'appEnv' | 'signedUrlTtlSeconds'>;
  signedUrlTtlSeconds?: number;
}

export function createStorageProvider(input: StorageFactoryInput): StorageProvider {
  if (input.provider === 'local-dev') {
    if (!input.localDev)
      throw new StorageError('local-dev storage options are missing', 'not_configured');
    return new LocalDevStorageProvider({
      appEnv: input.appEnv,
      ...input.localDev,
      signedUrlTtlSeconds: input.signedUrlTtlSeconds,
    });
  }
  if (input.provider === 's3') {
    if (!input.s3) throw new StorageError('S3 storage options are missing', 'not_configured');
    return new S3StorageProvider({ ...input.s3, signedUrlTtlSeconds: input.signedUrlTtlSeconds });
  }
  throw new StorageError(`unknown storage provider ${String(input.provider)}`, 'not_configured');
}

/** Maps the documented environment variables to factory input (no validation of secrets' values). */
export function storageConfigFromEnv(env: Record<string, string | undefined>): StorageFactoryInput {
  const appEnv = env.APP_ENV ?? 'development';
  const provider = (env.STORAGE_PROVIDER ?? 'local-dev') as StorageProviderId;
  const ttl = env.SIGNED_URL_TTL_SECONDS ? Number(env.SIGNED_URL_TTL_SECONDS) : undefined;
  if (provider === 's3') {
    return {
      appEnv,
      provider,
      signedUrlTtlSeconds: ttl,
      s3: {
        region: env.S3_REGION ?? 'us-east-1',
        endpoint: env.S3_ENDPOINT || null,
        forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
        credentials:
          env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
            ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
            : null,
        buckets: {
          private: env.S3_BUCKET_PRIVATE ?? 'simplexd-private',
          quarantine: env.S3_BUCKET_QUARANTINE ?? 'simplexd-quarantine',
          derivatives: env.S3_BUCKET_DERIVATIVES || null,
        },
      },
    };
  }
  return {
    appEnv,
    provider: 'local-dev',
    signedUrlTtlSeconds: ttl,
    localDev: {
      root: env.DEV_STORAGE_ROOT || defaultDevStorageRoot(),
      appUrl: env.APP_URL ?? 'http://localhost:3000',
      signingSecret: env.DEV_STORAGE_SIGNING_SECRET || env.AUTH_SECRET || '',
    },
  };
}

/**
 * Default development storage directory: `var/uploads-dev` at the workspace
 * root (the nearest directory containing pnpm-workspace.yaml), so the web app
 * and the worker, which run from different working directories, share one
 * store. Falls back to the current directory outside a workspace.
 */
export function defaultDevStorageRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return path.join(dir, 'var', 'uploads-dev');
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start, 'uploads-dev');
    dir = parent;
  }
}
