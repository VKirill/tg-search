import { existsSync } from 'node:fs';
import type { AgentTool } from '../types';
import { sendMediaMessage } from '../../pipeline/outreach';
import type { ToolHostDeps } from './deps';

export function createSendAssetTool(deps: ToolHostDeps): AgentTool {
  return {
    name: 'send_asset',
    description:
      'Отправить клиенту его сохранённые файлы: одно сообщение — до 10 фото альбомом, текст подписью под ними (Markdown можно).',
    parameters: {
      type: 'object',
      properties: {
        assetIds: { type: 'array', items: { type: 'number' }, description: 'id файлов из памяти клиента' },
        assetId: { type: 'number', description: 'один файл (устаревшее, лучше assetIds)' },
        caption: { type: 'string', description: 'текст сообщения под файлами' },
      },
    },
    async run(args, ctx) {
      const ids = (Array.isArray(args.assetIds) ? args.assetIds : [args.assetId]).map(Number).filter((n) => Number.isFinite(n));
      const caption = args.caption != null ? String(args.caption) : '';
      if (!ids.length) return 'Ошибка: укажите assetIds';
      if (!deps.memory) return 'Файлы клиента не подключены';
      if (ctx.clientId == null) return 'Клиент не привязан';
      if (ctx.dryRun) return `[dryRun] Отправили бы файлы ${ids.join(', ')}`;
      const { memory } = deps;
      const clientId = ctx.clientId;
      const assets: { path: string; mime: string; name: string }[] = [];
      for (const id of ids) {
        const asset = memory.search(clientId, String(id)).assets.find((a) => a.id === id);
        if (!asset) return `Ошибка: файл #${id} не найден`;
        if (asset.clientId !== clientId) return `Ошибка: файл #${id} принадлежит другому клиенту`;
        if (!existsSync(asset.path)) return `Ошибка: файл #${id} отсутствует на диске`;
        assets.push(asset);
      }
      await sendMediaMessage(deps, ctx.leadId, caption, assets.map((a) => ({ path: a.path, mime: a.mime || '' })), true);
      return `Отправлено одним сообщением: ${assets.map((a) => `«${a.name}»`).join(', ')}`;
    },
  };
}
