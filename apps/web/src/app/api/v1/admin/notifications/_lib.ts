import 'server-only';
import { ApiError } from '@simplexd/contracts';
import { NotificationAdminError, type PipelineOptions } from '@simplexd/notifications';
import { env } from '@/lib/env';

/** Pipeline options for web callers: environment, public URL and brand from the validated server env. */
export function pipelineOptions(): PipelineOptions {
  const e = env();
  return { appEnv: e.APP_ENV, appUrl: e.APP_URL, brandName: e.APP_NAME };
}

/** Runs an admin pipeline call and maps its typed errors onto the API error contract. */
export async function adminCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotificationAdminError) {
      throw new ApiError(err.code, err.message, { details: err.details });
    }
    throw err;
  }
}
