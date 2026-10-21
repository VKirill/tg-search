import type { Settings } from '../../shared/types';
import type { PaymentProvider, PaymentStatus } from './types';

const API = 'https://api.yookassa.ru/v3/payments';

function basicAuth(shopId: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`;
}

function formatRub(amountRub: number): string {
  return amountRub.toFixed(2);
}

function parseStatus(data: unknown): PaymentStatus {
  const status = (data as { status?: string }).status;
  if (status === 'pending' || status === 'waiting_for_capture' || status === 'succeeded' || status === 'canceled') {
    return status;
  }
  throw new Error(`ЮKassa: неизвестный статус платежа`);
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { description?: string; type?: string };
    if (data.description) return `${res.status}: ${data.description}`;
  } catch {
    /* ignore */
  }
  return String(res.status);
}

export class YooKassaProvider implements PaymentProvider {
  constructor(private readonly getSettings: () => Settings) {}

  private credentials(): { shopId: string; secretKey: string } {
    const { yookassaShopId, yookassaSecretKey } = this.getSettings();
    if (!yookassaShopId.trim() || !yookassaSecretKey.trim()) {
      throw new Error('Укажите shopId и секретный ключ ЮKassa в настройках');
    }
    return { shopId: yookassaShopId.trim(), secretKey: yookassaSecretKey.trim() };
  }

  async create(
    idempotenceKey: string,
    amountRub: number,
    description: string,
    returnUrl: string,
  ): Promise<{ id: string; url: string }> {
    const { shopId, secretKey } = this.credentials();
    const desc = description.slice(0, 128);
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(shopId, secretKey),
        'Content-Type': 'application/json',
        'Idempotence-Key': idempotenceKey,
      },
      body: JSON.stringify({
        amount: { value: formatRub(amountRub), currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: returnUrl },
        description: desc,
        metadata: { key: idempotenceKey },
      }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as { id?: string; confirmation?: { confirmation_url?: string } };
    const id = data.id;
    const url = data.confirmation?.confirmation_url;
    if (!id || !url) throw new Error('ЮKassa: нет ссылки на оплату');
    return { id, url };
  }

  async status(paymentId: string): Promise<PaymentStatus> {
    const { shopId, secretKey } = this.credentials();
    const res = await fetch(`${API}/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: basicAuth(shopId, secretKey) },
    });
    if (!res.ok) throw new Error(await readError(res));
    return parseStatus(await res.json());
  }
}
