import type { Api } from '../../../shared/types';

export function getApi(): Api {
  if (!window.api) throw new Error('window.api is not available');
  return window.api;
}
