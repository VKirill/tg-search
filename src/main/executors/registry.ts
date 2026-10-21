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
    assistant: notConnected('assistant'), // web search / research executor: agent worker
  };
}

function notConnected(kind: string) {
  const fail = async (): Promise<never> => {
    throw new Error(`Исполнитель «${kind}» ещё не подключён`);
  };
  return { estimate: fail, preview: fail, run: fail };
}
