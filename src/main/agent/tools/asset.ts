import { existsSync } from 'node:fs';
import type { AgentTool } from '../types';
import { listAuthorizedProjectAccounts } from '../../pipeline/accounts';
import type { ToolHostDeps } from './deps';

export function createSendAssetTool(deps: ToolHostDeps): AgentTool {
  return {
    name: 'send_asset',
    description: 'Отправить клиенту его сохранённый файл (фото или документ).',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'number' },
        caption: { type: 'string' },
      },
      required: ['assetId'],
    },
    async run(args, ctx) {
      const assetId = Number(args.assetId);
      const caption = args.caption != null ? String(args.caption) : undefined;
      if (!deps.memory) return 'Файлы клиента не подключены';
      if (ctx.clientId == null) return 'Клиент не привязан';
      if (ctx.dryRun) return `[dryRun] Отправили бы asset #${assetId}`;
      const found = deps.memory.search(ctx.clientId, String(assetId));
      const asset = found.assets.find((a) => a.id === assetId);
      if (!asset) return 'Ошибка: файл не найден';
      if (asset.clientId !== ctx.clientId) return 'Ошибка: файл принадлежит другому клиенту';
      if (!existsSync(asset.path)) return 'Ошибка: файл отсутствует на диске';
      const lead = deps.db.getLead(ctx.leadId);
      const project = deps.db.getProject(lead.projectId);
      const accountId = lead.accountId ?? listAuthorizedProjectAccounts(deps.db, project.accountIds)[0]?.id;
      if (accountId == null || lead.authorUserId == null) return 'Нет аккаунта для отправки';
      const chatId = await deps.engine.ensurePrivateChat(accountId, lead.authorUserId);
      const mime = asset.mime || '';
      if (mime.startsWith('image/')) {
        await deps.engine.sendPhoto(accountId, chatId, asset.path, caption);
      } else {
        await deps.engine.sendDocument(accountId, chatId, asset.path, caption);
      }
      return `Файл «${asset.name}» отправлен`;
    },
  };
}
