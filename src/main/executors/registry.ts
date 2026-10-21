import type { Settings } from '../../shared/types';
import type { ExecutorRegistry } from './types';
import { createCopywritingExecutor } from './copywriting';
import { createHomeworkExecutor } from './homework';
import { createImageGenExecutor } from './image_gen';
import { createMarketplaceCardExecutor } from './marketplace_card';

export function createExecutors(getSettings: () => Settings): ExecutorRegistry {
  return {
    homework: createHomeworkExecutor(getSettings),
    marketplace_card: createMarketplaceCardExecutor(getSettings),
    image_gen: createImageGenExecutor(getSettings),
    copywriting: createCopywritingExecutor(getSettings),
  };
}
