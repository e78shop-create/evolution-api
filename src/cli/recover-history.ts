/**
 * Opt-in CLI for one bounded history recovery request.
 * Talks only to the local Evolution HTTP API. It does not open a WhatsApp socket.
 *
 * API key is read from EVOLUTION_API_KEY. Do not pass secrets as argv.
 */
import { parseArgs } from 'node:util';

interface CliArgs {
  baseUrl: string;
  instance: string;
  apiKey: string;
  remoteJid?: string;
  anchorId?: string;
  anchorFromMe?: boolean;
  anchorTimestamp?: number;
  count?: number;
  page?: number;
  notBefore?: number;
  notAfter?: number;
  dryRun: boolean;
  timeoutMs?: number;
  requestId?: string;
  poll: boolean;
}

const BODY_KEYS = new Set(['message', 'conversation', 'text', 'body', 'base64', 'caption', 'messages']);

function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSensitive(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (BODY_KEYS.has(key)) {
      continue;
    }
    output[key] = stripSensitive(nested);
  }
  return output;
}

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function readArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string', default: process.env.EVOLUTION_API_URL || 'http://127.0.0.1:8080' },
      instance: { type: 'string', default: process.env.EVOLUTION_INSTANCE },
      'remote-jid': { type: 'string' },
      'anchor-id': { type: 'string' },
      'anchor-from-me': { type: 'string' },
      'anchor-timestamp': { type: 'string' },
      count: { type: 'string' },
      page: { type: 'string' },
      'not-before': { type: 'string' },
      'not-after': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'timeout-ms': { type: 'string' },
      'request-id': { type: 'string' },
      poll: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const apiKey = process.env.EVOLUTION_API_KEY || '';
  if (!apiKey) {
    fail('Defina EVOLUTION_API_KEY no ambiente. A chave não é lida de argv.');
  }
  if (!values.instance) {
    fail('Informe --instance ou EVOLUTION_INSTANCE.');
  }

  return {
    baseUrl: String(values['base-url']).replace(/\/$/, ''),
    instance: String(values.instance),
    apiKey,
    remoteJid: values['remote-jid'],
    anchorId: values['anchor-id'],
    anchorFromMe: values['anchor-from-me'] === undefined ? undefined : values['anchor-from-me'] === 'true',
    anchorTimestamp: values['anchor-timestamp'] ? Number(values['anchor-timestamp']) : undefined,
    count: values.count ? Number(values.count) : undefined,
    page: values.page ? Number(values.page) : undefined,
    notBefore: values['not-before'] ? Number(values['not-before']) : undefined,
    notAfter: values['not-after'] ? Number(values['not-after']) : undefined,
    dryRun: values['dry-run'] === true,
    timeoutMs: values['timeout-ms'] ? Number(values['timeout-ms']) : undefined,
    requestId: values['request-id'],
    poll: values.poll === true,
  };
}

async function callApi(args: CliArgs, path: string, init: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${args.baseUrl}${path}`, {
    ...init,
    headers: {
      apikey: args.apiKey,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: 'Resposta não JSON da API.' };
    }
  }
  return { status: response.status, body: stripSensitive(body) };
}

function exitCode(body: any, httpStatus: number): number {
  if (httpStatus === 401 || httpStatus === 403) return 2;
  const status = body?.status;
  if (status === 'rejected') return 2;
  if (status === 'unavailable') return 3;
  if (status === 'timeout') return 4;
  if (status === 'conflict' || status === 'rate-limited') return 5;
  if (httpStatus >= 400) return 2;
  return 0;
}

function isTerminal(status: string | undefined): boolean {
  return [
    'dry-run',
    'received',
    'partial',
    'empty',
    'timeout',
    'late-received',
    'unavailable',
    'rejected',
    'conflict',
    'rate-limited',
  ].includes(status || '');
}

async function main(): Promise<void> {
  const args = readArgs();
  if (args.requestId && !args.remoteJid) {
    const status = await callApi(
      args,
      `/chat/recoverHistoryStatus/${encodeURIComponent(args.instance)}?requestId=${encodeURIComponent(args.requestId)}`,
      { method: 'GET' },
    );
    process.stdout.write(`${JSON.stringify(status.body, null, 2)}\n`);
    process.exit(exitCode(status.body, status.status));
  }

  if (!args.remoteJid || !args.anchorId || args.anchorFromMe === undefined || !args.anchorTimestamp || !args.count) {
    fail(
      'Uso: --remote-jid --anchor-id --anchor-from-me true|false --anchor-timestamp <segundos> --count <1-50> [--dry-run] [--poll]',
    );
  }

  const payload = {
    remoteJid: args.remoteJid,
    anchor: {
      id: args.anchorId,
      fromMe: args.anchorFromMe,
      timestamp: args.anchorTimestamp,
    },
    count: args.count,
    page: args.page,
    notBeforeTimestamp: args.notBefore,
    notAfterTimestamp: args.notAfter,
    dryRun: args.dryRun,
    timeoutMs: args.timeoutMs,
  };
  const created = await callApi(args, `/chat/recoverHistory/${encodeURIComponent(args.instance)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  let current = created;
  if (args.poll && created.body?.requestId && created.body?.status === 'accepted') {
    const deadline = Date.now() + (args.timeoutMs || 45_000) + 5_000;
    while (Date.now() < deadline && !isTerminal(current.body?.status)) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      current = await callApi(
        args,
        `/chat/recoverHistoryStatus/${encodeURIComponent(args.instance)}?requestId=${encodeURIComponent(created.body.requestId)}`,
        { method: 'GET' },
      );
    }
  }

  process.stdout.write(`${JSON.stringify(current.body, null, 2)}\n`);
  process.exit(exitCode(current.body, current.status));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Falha na CLI de recuperação.';
  fail(message, 3);
});
