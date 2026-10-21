// Contract of the service executors («Исполнители»). Implemented in ./registry.ts and one file per kind.

import type { Lead, Order, OrderFile, Service, ServiceKind } from '../../shared/types';
import type { DialogTurn } from '../ai/types';

export interface ExecutorInput {
  service: Service;
  order: Order;
  lead: Lead;
  history: DialogTurn[]; // the dialog so far (voice notes as transcripts)
  inputs: OrderFile[]; // files the client sent (photos of homework, product photos, faces)
  workDir: string; // where to write output files (inside the client's dossier)
  clientPhotoPath: string | null; // the client's avatar, only when they consented to its use
}

export interface ExecutorOutput {
  text: string; // message to the client that accompanies the result (or the whole result for text services)
  files: OrderFile[]; // role 'preview' or 'output'
}

export interface Executor {
  // Price inside [service.priceMin, service.priceMax] by complexity, with a one-line reason for the owner
  estimate(input: ExecutorInput): Promise<{ price: number; reason: string }>;
  // Cheap free sample to sell the order (only when service.previewEnabled)
  preview(input: ExecutorInput): Promise<ExecutorOutput>;
  // The full job, self-checked before returning; throws with a Russian reason when it cannot be done
  run(input: ExecutorInput): Promise<ExecutorOutput>;
}

export type ExecutorRegistry = Record<ServiceKind, Executor>;
