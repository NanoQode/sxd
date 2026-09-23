import { z } from 'zod';
import { integrationProviderSchema } from '@simplexd/contracts';

export const providerParams = z.object({ provider: integrationProviderSchema });
