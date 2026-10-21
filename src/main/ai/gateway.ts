// Every model request in the app goes through OpenCode. Modules keep calling their familiar helpers
// (chatCompletion, visionChat, captions…); when the gateway is installed those helpers route here instead of a
// provider's HTTP API. Tests run without a gateway.
import type { ModelRole } from '../opencode/models';

export interface GatewayRequest {
  role: ModelRole;
  system?: string;
  messages: { role: 'user' | 'assistant'; text: string }[];
  images?: string[]; // data: URIs
  json?: boolean; // the answer must be a JSON object
  title?: string;
}

export interface LlmGateway {
  complete(req: GatewayRequest): Promise<string>;
}

let gateway: LlmGateway | null = null;

export function setLlmGateway(g: LlmGateway | null) {
  gateway = g;
}

export function llmGateway(): LlmGateway | null {
  return gateway;
}

// Flatten a chat into one prompt for a tool-less one-shot session
export function gatewayPrompt(req: GatewayRequest): string {
  const parts: string[] = [];
  if (req.system?.trim()) parts.push(`# Инструкция\n${req.system.trim()}`);
  const dialog = req.messages.filter((m) => m.text.trim());
  if (dialog.length === 1 && dialog[0].role === 'user') parts.push(dialog[0].text.trim());
  else if (dialog.length) {
    parts.push(`# Диалог\n${dialog.map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.text.trim()}`).join('\n\n')}`);
    parts.push('Ответь на последнее сообщение пользователя.');
  }
  if (req.json) parts.push('Ответ — только один JSON-объект, без пояснений и без markdown-обёртки.');
  return parts.join('\n\n');
}

// For modules that speak the chat-completions wire format through an injectable fetch: the request goes to the
// gateway and the answer comes back in the same shape, so the module code stays as it is
export function gatewayFetch(role: ModelRole): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const gw = llmGateway();
    if (!gw) throw new Error('OpenCode не подключён');
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] }[];
    };
    const msgs = body.messages ?? [];
    const textOf = (c: unknown) => (typeof c === 'string' ? c : (c as { type: string; text?: string }[]).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n'));
    const images = msgs.flatMap((m) => (typeof m.content === 'string' ? [] : m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url!.url)));
    const content = await gw.complete({
      role,
      system: msgs.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n'),
      messages: msgs.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: textOf(m.content) })),
      images,
    });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

// The auxiliary endpoint of a module: OpenCode through the gateway when it is installed, else the configured one
export function auxEndpoint(
  settings: { auxBaseUrl: string; auxApiKey: string; auxModel: string },
  fetchFn: typeof fetch,
  role: ModelRole,
): { base: string; key: string; model: string; fetchFn: typeof fetch } | null {
  if (llmGateway()) return { base: 'opencode', key: 'opencode', model: 'opencode', fetchFn: gatewayFetch(role) };
  const base = settings.auxBaseUrl.replace(/\/$/, '');
  const key = settings.auxApiKey.trim();
  const model = settings.auxModel.trim();
  return base && key && model ? { base, key, model, fetchFn } : null;
}
