import type { AgentTool } from '../types';
import type { ToolHostDeps } from './deps';
import { recordAddonOffer } from '../upsell';

// The agent marks an upsell before offering it, so the same addon is not pushed again for a month
export function createOfferAddonTool(deps: ToolHostDeps): AgentTool {
  return {
    name: 'offer_addon',
    description: 'Отметить, что предлагаешь клиенту дополнительную услугу из блока upsell (вызывать перед предложением).',
    parameters: {
      type: 'object',
      properties: { serviceId: { type: 'number', description: 'id услуги из блока upsell' } },
      required: ['serviceId'],
    },
    async run(args, ctx) {
      const serviceId = Number(args.serviceId);
      const service = deps.db.listServices().find((s) => s.id === serviceId && s.enabled);
      if (!service) return 'Ошибка: нет такой услуги в каталоге';
      if (ctx.dryRun) return `[dryRun] Предложили бы «${service.name}»`;
      recordAddonOffer(deps.db, ctx.leadId, serviceId);
      return `Записано. Предложи «${service.name}» одной-двумя фразами с ценой ${service.priceMin}–${service.priceMax} ₽; если клиент согласится — создай заказ.`;
    },
  };
}
