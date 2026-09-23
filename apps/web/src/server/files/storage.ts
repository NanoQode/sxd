import 'server-only';
import {
  createStorageProvider,
  type LocalDevStorageProvider,
  storageConfigFromEnv,
  type StorageProvider,
} from '@simplexd/integrations/storage';

/**
 * Process-wide storage provider for the web app. The provider is built from
 * the documented environment variables (docs/providers/storage.md); the
 * development adapter refuses to start outside APP_ENV=development|test.
 */

const globalRef = globalThis as unknown as { __sxStorage?: StorageProvider };

export function getStorage(): StorageProvider {
  if (!globalRef.__sxStorage) {
    globalRef.__sxStorage = createStorageProvider(storageConfigFromEnv(process.env));
  }
  return globalRef.__sxStorage;
}

/** The development adapter, or null when S3 is configured. */
export function getDevStorage(): LocalDevStorageProvider | null {
  const provider = getStorage();
  // Compare the provider id rather than using instanceof: the provider is cached
  // on globalThis, and a hot reload in development re-evaluates the class, so an
  // instanceof check against the new class would fail for the cached instance.
  return provider.id === 'local-dev' ? (provider as LocalDevStorageProvider) : null;
}

/** Test hook: replaces the provider (for example to point the dev root at a temp directory). */
export function setStorageForTests(provider: StorageProvider | null): void {
  if (provider) globalRef.__sxStorage = provider;
  else delete globalRef.__sxStorage;
}
