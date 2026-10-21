import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type {
  AppEvent,
  Lead,
  ManagerOrderIntent,
  ManagerTestResult,
  Order,
  OrderFile,
  Service,
} from '../../shared/types';
import type { DialogTurn } from '../ai/types';
import type { Db } from '../db';
import type { Executor, ExecutorRegistry } from '../executors/types';
import type { Billing } from '../billing/types';
import type { PaymentProvider } from '../payments/types';
import type { TelegramEngine, TgMessage } from '../telegram/types';
import { sendMediaMessage, sendMessage, type OutreachDeps } from './outreach';
import { isFreeLead } from '../trusted';
import { listAuthorizedProjectAccounts } from './accounts';

const POLL_MS = 30_000;
const PAYMENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface OrdersDeps extends OutreachDeps {
  dataDir: string;
  payments: PaymentProvider;
  executors: ExecutorRegistry;
  manager?: unknown;
  dossier?: { onOrder?(order: Order): void | Promise<void> };
  billingRef?: { current?: Billing };
  /** When set, order payment status is polled by billing (ledger), not here — avoids double markPaid/run. */
  skipOrderPaymentPoll?: boolean;
}

const RUN_TIMEOUT_MS = 10 * 60_000;

// what a person writes when handing work over
const DELIVERY_INTROS = ['готово, смотри', 'вот что получилось', 'лови', 'готово, глянь'];

function workDir(dataDir: string, leadId: number, orderId: number): string {
  const dir = join(dataDir, 'clients', String(leadId), 'orders', String(orderId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function priceInRange(service: Service, price: number): boolean {
  return price >= service.priceMin && price <= service.priceMax;
}

function openOrderStatuses(): Set<Order['status']> {
  return new Set(['collecting', 'quoted', 'awaiting_payment', 'paid', 'in_progress', 'revision']);
}

function buildExecutorInput(
  deps: OrdersDeps,
  order: Order,
  service: Service,
  lead: Lead,
  history: DialogTurn[],
  clientPhotoPath: string | null,
) {
  const dir = workDir(deps.dataDir, lead.id, order.id);
  return {
    service,
    order,
    lead,
    history,
    inputs: order.files.filter((f) => f.role === 'input'),
    workDir: dir,
    clientPhotoPath,
  };
}

async function clientPhotoPath(deps: OrdersDeps, lead: Lead, order: Order): Promise<string | null> {
  const avatar = join(workDir(deps.dataDir, lead.id, order.id), 'client-avatar.jpg');
  return existsSync(avatar) ? avatar : null;
}

async function savePhotoConsent(deps: OrdersDeps, lead: Lead, order: Order): Promise<void> {
  const accountId = lead.accountId ?? listAuthorizedProjectAccounts(deps.db, deps.db.getProject(lead.projectId).accountIds)[0]?.id;
  if (accountId == null || lead.authorUserId == null) return;
  const path = await deps.engine.getUserPhoto(accountId, lead.authorUserId);
  if (!path) return;
  const dest = join(workDir(deps.dataDir, lead.id, order.id), 'client-avatar.jpg');
  copyFileSync(path, dest);
}

function dialogHistory(deps: OrdersDeps, lead: Lead): DialogTurn[] {
  const messages = deps.db.listMessages(lead.id);
  const turns: DialogTurn[] = lead.text.trim() ? [{ direction: 'in', text: lead.text }] : [];
  for (const m of messages) turns.push({ direction: m.direction, text: m.text });
  return turns;
}

function looksLikeRevisionRequest(text: string): boolean {
  return /правк|исправ|передел|не подходит|не то|другой вариант|переделай|измени/i.test(text);
}

export function createOrders(deps: OrdersDeps) {
  let timer: ReturnType<typeof setInterval> | null = null;

  function emitOrder(order: Order) {
    deps.emit({ type: 'order:update', order });
    void deps.dossier?.onOrder?.(order);
  }

  function patchOrder(id: number, patch: Partial<Omit<Order, 'id' | 'leadId' | 'createdAt'>>): Order {
    const order = deps.db.updateOrder(id, patch);
    emitOrder(order);
    return order;
  }

  function getExecutor(service: Service): Executor {
    return deps.executors[service.kind];
  }

  function activeOrderForLead(leadId: number): Order | null {
    const open = openOrderStatuses();
    return deps.db.listOrders(leadId).find((o) => open.has(o.status)) ?? null;
  }

  async function deliverPreview(leadId: number, text: string, files: OrderFile[]) {
    await sendMediaMessage(deps, leadId, text, files, true);
  }

  async function requestPayment(orderId: number): Promise<Order> {
    const order = deps.db.getOrder(orderId);
    // «свои люди»: tasks are free — straight to work
    if (isFreeLead(deps.db, deps.db.getLead(order.leadId))) {
      patchOrder(orderId, { price: 0 });
      return markPaid(orderId);
    }
    const service = deps.db.getService(order.serviceId);
    if (order.price == null || !priceInRange(service, order.price)) {
      throw new Error(`Цена должна быть от ${service.priceMin} до ${service.priceMax} ₽`);
    }
    const settings = deps.db.getSettings();
    const returnUrl = settings.yookassaReturnUrl.trim() || 'https://t.me';
    const description = `${service.name} — заказ #${order.id}`;
    const { id, url } = await deps.payments.create(`order-${orderId}-${order.price}`, order.price, description, returnUrl);
    const updated = patchOrder(orderId, {
      paymentId: id,
      paymentUrl: url,
      status: 'awaiting_payment',
      error: null,
    });
    const linkText = `Оплата ${order.price} ₽: ${url}`;
    await sendMessage(deps, order.leadId, linkText, 'dm', true);
    const lead = deps.db.getLead(order.leadId);
    const clientId = lead.clientId ?? lead.id;
    deps.billingRef?.current?.recordPayment({
      clientId,
      purpose: 'order',
      orderId: order.id,
      subscriptionId: null,
      amount: order.price,
      status: 'pending',
      providerId: id,
      url,
      paidAt: null,
    });
    return updated;
  }

  async function markPaid(orderId: number): Promise<Order> {
    const updated = patchOrder(orderId, { status: 'paid', paidAt: Date.now(), error: null });
    await run(orderId);
    return deps.db.getOrder(orderId);
  }

  async function run(orderId: number): Promise<Order> {
    let order = patchOrder(orderId, { status: 'in_progress', error: null });
    const service = deps.db.getService(order.serviceId);
    const lead = deps.db.getLead(order.leadId);
    const history = dialogHistory(deps, lead);
    const photoPath = await clientPhotoPath(deps, lead, order);
    const input = buildExecutorInput(deps, order, service, lead, history, photoPath);
    try {
      // a provider that never answers must not leave the order «in progress» forever
      const output = await Promise.race([
        getExecutor(service).run(input),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('исполнитель не ответил за 10 минут')), RUN_TIMEOUT_MS).unref?.()),
      ]);
      const outputs = output.files.filter((f) => f.role === 'output' || f.role === 'preview');
      order = patchOrder(orderId, {
        files: [...order.files.filter((f) => f.role === 'input' || f.role === 'preview'), ...outputs],
        result: output.text,
      });
      return deliver(orderId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      patchOrder(orderId, { status: 'failed', error: reason });
      const handoffReason = `Исполнитель не справился: ${reason}`;
      const updatedLead = deps.db.updateLead(lead.id, { handoff: true, handoffReason });
      deps.emit({ type: 'lead:update', lead: updatedLead });
      return deps.db.getOrder(orderId);
    }
  }

  async function deliver(orderId: number): Promise<Order> {
    const order = deps.db.getOrder(orderId);
    // the result text and every output file in one go: albums with the text under them
    const outputs = order.files.filter((f) => f.role === 'output');
    if (order.result?.trim() || outputs.length) {
      const intro = DELIVERY_INTROS[order.id % DELIVERY_INTROS.length];
      await sendMediaMessage(deps, order.leadId, order.result?.trim() ? `${intro}\n\n${order.result.trim()}` : intro, outputs, true);
    }
    return patchOrder(orderId, { status: 'delivered' });
  }

  async function startRevision(orderId: number, addition: string): Promise<Order> {
    const order = deps.db.getOrder(orderId);
    const service = deps.db.getService(order.serviceId);
    if (order.revisionsUsed >= service.revisions) {
      throw new Error('Лимит бесплатных правок исчерпан');
    }
    const brief = `${order.brief}\n\nПравки клиента: ${addition.trim()}`;
    patchOrder(orderId, {
      status: 'revision',
      brief,
      revisionsUsed: order.revisionsUsed + 1,
      error: null,
    });
    return run(orderId);
  }

  async function applyManagerIntent(leadId: number, intent: ManagerOrderIntent): Promise<void> {
    const service = deps.db.getService(intent.serviceId);
    if (!service.enabled) throw new Error('Услуга недоступна');

    let order = activeOrderForLead(leadId);
    if (!order || order.serviceId !== intent.serviceId) {
      order = attachRecentMedia(deps.db.createOrder(leadId, intent.serviceId, intent.brief));
      emitOrder(order);
    } else {
      order = patchOrder(order.id, { brief: intent.brief });
    }

    // Price and billing change only before payment: the manager repeats itself across turns, and a paid or
    // awaiting order must never be re-billed or moved back to «quoted».
    const negotiable = order.status === 'collecting' || order.status === 'quoted';

    if (intent.agreedPrice != null && negotiable) {
      if (!priceInRange(service, intent.agreedPrice)) {
        throw new Error(`Цена вне вилки ${service.priceMin}–${service.priceMax} ₽`);
      }
      order = patchOrder(order.id, { price: intent.agreedPrice, status: 'quoted' });
    } else if (order.status === 'collecting') {
      order = patchOrder(order.id, { status: 'collecting' });
    }

    if (intent.photoConsent) {
      await savePhotoConsent(deps, deps.db.getLead(leadId), order);
    }

    if (intent.wantsPreview && service.previewEnabled) {
      const lead = deps.db.getLead(leadId);
      const history = dialogHistory(deps, lead);
      const photoPath = await clientPhotoPath(deps, lead, order);
      const output = await getExecutor(service).preview(
        buildExecutorInput(deps, order, service, lead, history, photoPath),
      );
      const previews = output.files.filter((f) => f.role === 'preview');
      patchOrder(order.id, {
        files: [...order.files.filter((f) => f.role !== 'preview'), ...previews],
      });
      await deliverPreview(leadId, output.text, previews);
    }

    if (negotiable && intent.readyToPay && intent.agreedPrice != null && priceInRange(service, intent.agreedPrice)) {
      await requestPayment(order.id);
    }
  }

  async function handlePostManagerReply(leadId: number, result: ManagerTestResult, lastClientText: string): Promise<void> {
    if (result.order) {
      await applyManagerIntent(leadId, result.order);
      return;
    }
    const delivered = deps.db.listOrders(leadId).find((o) => o.status === 'delivered');
    if (!delivered) return;
    if (!looksLikeRevisionRequest(lastClientText) && !looksLikeRevisionRequest(result.reply)) return;
    const addition = lastClientText.trim() || result.reply.trim();
    if (!addition) return;
    await startRevision(delivered.id, addition);
  }

  // Photos and files the client sent before the order existed (usually with the request itself) become its inputs
  function attachRecentMedia(order: Order): Order {
    // only what came for this order: after the previous order of the lead (a new task's photo, not last task's beds)
    const previous = deps.db.listOrders(order.leadId).filter((o) => o.id !== order.id).reduce((t, o) => Math.max(t, o.createdAt), 0);
    const since = Math.max(Date.now() - 24 * 3600_000, previous);
    const media = deps.db.listMessages(order.leadId)
      .filter((m) => m.direction === 'in' && m.mediaPath && m.kind !== 'voice' && m.date > since && existsSync(m.mediaPath));
    if (!media.length) return order;
    const dir = workDir(deps.dataDir, order.leadId, order.id);
    const files: OrderFile[] = media.map((m) => {
      const name = basename(m.mediaPath!);
      const dest = join(dir, name);
      copyFileSync(m.mediaPath!, dest);
      return { path: dest, role: 'input', name, mime: /\.(jpe?g|png|webp)$/i.test(name) ? 'image/jpeg' : 'application/octet-stream' };
    });
    return patchOrder(order.id, { files: [...order.files, ...files] });
  }

  async function ingestPrivateMedia(leadId: number, accountId: number, msg: TgMessage): Promise<void> {
    const order = activeOrderForLead(leadId);
    if (!order) return;
    let fileId: number | null = null;
    let name = `file-${msg.messageId}`;
    let mime = 'application/octet-stream';
    if (msg.photo) {
      fileId = msg.photo.fileId;
      name = `photo-${msg.messageId}.jpg`;
      mime = 'image/jpeg';
    } else if (msg.document) {
      fileId = msg.document.fileId;
      name = msg.document.name || name;
      mime = msg.document.mime || mime;
    }
    if (fileId == null) return;
    const downloaded = await deps.engine.downloadFile(accountId, fileId);
    const dir = workDir(deps.dataDir, leadId, order.id);
    const dest = join(dir, basename(name));
    copyFileSync(downloaded, dest);
    const file: OrderFile = { path: dest, role: 'input', name, mime };
    patchOrder(order.id, { files: [...order.files, file] });
  }

  async function pollPayments() {
    // Ledger order payments are polled in billing.check / billing.start (see skipOrderPaymentPoll).
    if (deps.skipOrderPaymentPoll) return;
    const now = Date.now();
    for (const order of deps.db.listOrders()) {
      if (order.status !== 'awaiting_payment' || !order.paymentId) continue;
      if (now - order.updatedAt > PAYMENT_TTL_MS) continue;
      try {
        const status = await deps.payments.status(order.paymentId);
        if (status === 'succeeded') {
          patchOrder(order.id, { status: 'paid', paidAt: now, error: null });
          await run(order.id);
        } else if (status === 'canceled') {
          patchOrder(order.id, { status: 'quoted', error: 'Оплата отменена' });
        }
      } catch (err) {
        console.error('payment poll', order.id, err);
      }
    }
  }

  function startPoller() {
    if (timer) return;
    timer = setInterval(() => {
      pollPayments().catch((err) => console.error('orders poller', err));
    }, POLL_MS);
    timer.unref();
  }

  function stopPoller() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    requestPayment,
    markPaid,
    run,
    deliver,
    applyManagerIntent,
    ingestPrivateMedia,
    attachRecentMedia,
    handlePostManagerReply,
    startPoller,
    stopPoller,
  };
}

export function stubExecutorRegistry(): ExecutorRegistry {
  const fail = async (): Promise<never> => {
    throw new Error('Исполнитель не подключён');
  };
  const stub: Executor = { estimate: fail, preview: fail, run: fail };
  return {
    homework: stub,
    marketplace_card: stub,
    image_gen: stub,
    copywriting: stub,
    assistant: stub,
    agent: stub,
  };
}
