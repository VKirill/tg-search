// Contract of the client memory (docs/architecture-agent.md). Implemented in ./store.ts.

import type { Asset, AssetRole, ChatMessage, Client, FactKind, Lead, MemoryEpisode, MemoryFact, Order } from '../../shared/types';

export interface AgentContext {
  text: string; // assembled sections for the operator prompt, within the token budget
  tokens: number; // rough estimate (chars / 4)
}

export interface MemorySearchResult {
  facts: MemoryFact[];
  episodes: MemoryEpisode[];
  assets: Asset[];
}

export interface MemoryStore {
  // Client of the lead's author (created on first sight, merged across leads by Telegram user id)
  ensureClient(lead: Lead): Client | null;
  clientForLead(leadId: number): Client | null;
  // Facts → recent episodes → last messages → open orders and subscription → assets matching the query
  context(leadId: number, query: string, budgetTokens?: number): AgentContext;
  remember(clientId: number, kind: FactKind, text: string, source: string | null): MemoryFact;
  search(clientId: number, query: string): MemorySearchResult; // FTS + cached vectors only (instant)
  searchAsync(clientId: number, query: string): Promise<MemorySearchResult>; // full hybrid: embeds the query first
  addAsset(a: { clientId: number; orderId: number | null; path: string; mime: string; name: string; role: AssetRole; caption?: string; tags?: string[] }): Asset;
  // Hooks from the app's event route: capture assets, compact episodes, extract facts
  onMessage(message: ChatMessage): void;
  onOrder(order: Order): void;
  releaseModel(): void; // unload the local embedding model now (memory pressure); it reloads on the next request
  stop(): void;
}
