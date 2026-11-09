import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import express from 'express';
import { validate } from 'jsonschema';

import { applyBaileysEventRouting } from '../../src/api/services/history-recovery/history-recovery.coordinator';
import { withoutRecoveredHistory } from '../../src/api/services/history-recovery/history-recovery.policy';
import { HistoryRecoveryRuntime } from '../../src/api/services/history-recovery/history-recovery.runtime';
import { historyRecoverySchema } from '../../src/validate/history-recovery.schema';

const JID = 'synthetic-user-a@s.whatsapp.net';
const OTHER_JID = 'synthetic-user-b@s.whatsapp.net';
const ANCHOR_ID = 'SYNTHETICANCHOR0001';
const ANCHOR_TS = 1_700_000_000;
const BODY = 'synthetic-body-token';

function recoveryInput(overrides: Record<string, unknown> = {}) {
  return {
    remoteJid: JID,
    anchor: { id: ANCHOR_ID, fromMe: false, timestamp: ANCHOR_TS },
    count: 2,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function inbound(overrides: Record<string, any> = {}) {
  return {
    key: {
      id: 'SYNTHETICMSG000001',
      remoteJid: JID,
      fromMe: false,
      ...(overrides.key || {}),
    },
    messageTimestamp: overrides.messageTimestamp ?? ANCHOR_TS - 100,
    message: overrides.message === undefined ? { conversation: BODY } : overrides.message,
    pushName: 'synthetic-push',
  };
}

function harness(options?: { open?: boolean; persistence?: boolean }) {
  let now = 1_800_000_000_000;
  const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
  const rows: any[] = [];
  const fetchCalls: any[] = [];
  let lookup: (ids: string[], remoteJid: string) => Promise<Set<string>> = async (ids, remoteJid) =>
    new Set(rows.filter((row) => row.key.remoteJid === remoteJid && ids.includes(row.key.id)).map((row) => row.key.id));
  let fetchImpl: (count: number, key: any, ts: number) => Promise<unknown> = async (count, key, ts) => {
    fetchCalls.push({ count, key, ts });
    return 'synthetic-session-1';
  };
  const runtime = new HistoryRecoveryRuntime({
    connectionState: () => (options?.open === false ? 'close' : 'open'),
    fetchMessageHistory: (count, key, ts) => fetchImpl(count, key, ts),
    normalize: (message) => {
      if (!message?.message) return null;
      return {
        key: {
          id: String(message.key?.id),
          remoteJid: String(message.key?.remoteJid),
          fromMe: message.key?.fromMe === true,
        },
        message: { ...(message.message as Record<string, unknown>) },
        messageType: 'conversation',
        messageTimestamp: Number(message.messageTimestamp),
        instanceId: 'synthetic-instance',
        source: 'web',
        pushName: null,
      };
    },
    findExistingIds: (ids, remoteJid) => lookup(ids, remoteJid),
    insertRows: async (incoming) => {
      rows.push(...incoming.map((row) => JSON.parse(JSON.stringify(row))));
    },
    persistenceEnabled: () => options?.persistence !== false,
    schedule: (fn, ms) => {
      const entry = { fn, at: now + ms, cancelled: false };
      timers.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    now: () => now,
  });

  return {
    runtime,
    rows,
    fetchCalls,
    setFetch(impl: typeof fetchImpl) {
      fetchImpl = impl;
    },
    setLookup(impl: typeof lookup) {
      lookup = impl;
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= now) {
          timer.cancelled = true;
          timer.fn();
        }
      }
    },
    handlers() {
      const calls = { live: 0, history: 0, liveMessages: [] as any[] };
      return {
        calls,
        passthroughHistory: async () => {
          calls.history += 1;
        },
        liveUpsert: async (payload: { messages?: any[] }) => {
          calls.live += 1;
          calls.liveMessages.push(...(payload.messages || []));
        },
      };
    },
  };
}

test('dry-run validates and does not call fetchMessageHistory', async () => {
  const { runtime, fetchCalls } = harness();
  const view = await runtime.request(recoveryInput({ dryRun: true, page: 2 }));
  assert.equal(view.status, 'dry-run');
  assert.equal(view.httpStatus, 200);
  assert.equal(fetchCalls.length, 0);
  assert.equal(view.wouldSend?.oldestMsgTimestampMs, ANCHOR_TS * 1000);
  assert.equal(view.wouldSend?.count, 2);
  assert.equal(view.verification.liveWhatsAppExecution, false);
  assert.equal(view.integration.externalDbPoller.status, 'BLOCKED');
  assert.equal(view.delivery.messagesUpsertWebhook, false);
  assert.equal(view.delivery.chatbotEmit, false);
  assert.equal(view.direction, 'older-than-anchor');
});

test('rejects malformed anchors, bounds, millisecond timestamps and inverted windows', async () => {
  const { runtime, fetchCalls } = harness();
  const cases = [
    recoveryInput({ remoteJid: 'not-a-jid' }),
    recoveryInput({ anchor: { id: 'x', fromMe: false, timestamp: ANCHOR_TS } }),
    recoveryInput({ anchor: { id: ANCHOR_ID, fromMe: 'false', timestamp: ANCHOR_TS } }),
    recoveryInput({ anchor: { id: ANCHOR_ID, fromMe: false, timestamp: ANCHOR_TS * 1000 } }),
    recoveryInput({ count: 51 }),
    recoveryInput({ count: 0 }),
    recoveryInput({ page: 21 }),
    recoveryInput({ timeoutMs: 1000 }),
    recoveryInput({ notBeforeTimestamp: ANCHOR_TS }),
    recoveryInput({ anchor: { id: ANCHOR_ID, remoteJid: OTHER_JID, fromMe: false, timestamp: ANCHOR_TS } }),
  ];
  for (const input of cases) {
    const view = await runtime.request(input);
    assert.equal(view.status, 'rejected', JSON.stringify(input));
    assert.equal(view.httpStatus, 400);
  }
  assert.equal(fetchCalls.length, 0);
});

test('closed socket is unavailable and does not fetch or reconnect', async () => {
  const { runtime, fetchCalls } = harness({ open: false });
  const view = await runtime.request(recoveryInput());
  assert.equal(view.status, 'unavailable');
  assert.equal(view.httpStatus, 503);
  assert.equal(fetchCalls.length, 0);
  assert.match(view.error || '', /não está aberto/);
});

test('accepted request sends one older-than-anchor fetch with millisecond timestamp', async () => {
  const { runtime, fetchCalls } = harness();
  const view = await runtime.request(recoveryInput({ page: 2 }));
  assert.equal(view.status, 'accepted');
  assert.equal(view.httpStatus, 202);
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(fetchCalls[0].key, { remoteJid: JID, fromMe: false, id: ANCHOR_ID });
  assert.equal(fetchCalls[0].ts, ANCHOR_TS * 1000);
  assert.equal(fetchCalls[0].count, 2);
  assert.equal(view.verification.liveWhatsAppExecution, false);
});

test('a second request conflicts while the first is in flight', async () => {
  const { runtime, setFetch } = harness();
  let release: (value: string) => void = () => undefined;
  setFetch(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = runtime.request(recoveryInput());
  const conflict = await runtime.request(recoveryInput());
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.httpStatus, 409);
  release('synthetic-session-1');
  const accepted = await pending;
  assert.equal(accepted.status, 'accepted');
});

test('history.set ON_DEMAND persists original timestamp and fromMe and does not wake live handlers', async () => {
  const { runtime, rows, handlers } = harness();
  await runtime.request(recoveryInput());
  const live = handlers();
  await runtime.planAndApply(
    {
      historySet: {
        syncType: 6,
        peerDataRequestSessionId: 'synthetic-session-1',
        messages: [inbound({ key: { fromMe: true, id: 'SYNTHETICMSG000001' }, messageTimestamp: ANCHOR_TS - 80 })],
      },
    },
    live,
  );
  assert.equal(live.calls.live, 0);
  assert.equal(live.calls.history, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key.fromMe, true);
  assert.equal(rows[0].key.id, 'SYNTHETICMSG000001');
  assert.equal(rows[0].key.remoteJid, JID);
  assert.equal(rows[0].messageTimestamp, ANCHOR_TS - 80);
  assert.equal(rows[0].status, 'HISTORY');
  assert.equal(rows[0].message.conversation, BODY);
  assert.equal(rows[0].message._evolutionRecovery.provenance, 'on-demand-history');
  assert.equal(rows[0].message._evolutionRecovery.direction, 'older-than-anchor');
  const status = runtime.status(rows[0].message._evolutionRecovery.requestId);
  assert.equal(status.verification.liveWhatsAppExecution, false);
  assert.equal(JSON.stringify(runtime.audit()).includes(BODY), false);
});

test('duplicate history does not overwrite the original timestamp or fromMe', async () => {
  const { runtime, rows, handlers } = harness();
  const created = await runtime.request(recoveryInput());
  const first = handlers();
  const message = inbound();
  await runtime.planAndApply(
    { historySet: { syncType: 'ON_DEMAND', peerDataRequestSessionId: 'synthetic-session-1', messages: [message, message] } },
    first,
  );
  assert.equal(rows.length, 1);
  const again = handlers();
  await runtime.planAndApply(
    {
      historySet: {
        syncType: 6,
        peerDataRequestSessionId: 'synthetic-session-1',
        messages: [inbound({ key: { fromMe: true }, messageTimestamp: ANCHOR_TS - 1 })],
      },
    },
    again,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageTimestamp, ANCHOR_TS - 100);
  assert.equal(rows[0].key.fromMe, false);
  assert.equal(again.calls.live, 0);
  const status = runtime.status(created.requestId!);
  assert.ok(status.counts.duplicates >= 1);
});

test('empty, partial, no-body and out-of-window batches do not fabricate messages', async () => {
  const { runtime, rows, handlers } = harness();
  const created = await runtime.request(recoveryInput({ notBeforeTimestamp: ANCHOR_TS - 50 }));
  const sink = handlers();
  await runtime.planAndApply(
    {
      historySet: {
        syncType: 6,
        peerDataRequestSessionId: 'synthetic-session-1',
        messages: [
          inbound({ key: { id: 'SYNTHETICMSG000002' }, messageTimestamp: ANCHOR_TS - 10 }),
          inbound({ key: { id: 'SYNTHETICMSG000003' }, message: null }),
          inbound({ key: { id: 'SYNTHETICMSG000004', remoteJid: OTHER_JID } }),
          inbound({ key: { id: 'SYNTHETICMSG000005' }, messageTimestamp: ANCHOR_TS - 500 }),
          inbound({ key: { id: ANCHOR_ID }, messageTimestamp: ANCHOR_TS - 5 }),
          inbound({ key: { id: 'SYNTHETICMSG000006' }, messageTimestamp: ANCHOR_TS + 5 }),
        ],
      },
    },
    sink,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key.id, 'SYNTHETICMSG000002');
  assert.equal(JSON.stringify(rows).includes('placeholder'), false);
  const status = runtime.status(created.requestId!);
  assert.equal(status.status, 'partial');
  assert.equal(status.counts.skippedWithoutBody, 1);
  assert.equal(status.counts.ignoredOtherChat, 1);
  assert.equal(status.counts.filteredByWindow, 1);
  assert.ok(status.counts.newerOrEqualToAnchor >= 1);
  assert.equal(sink.calls.live, 0);

  const emptyRuntime = harness();
  const emptyCreated = await emptyRuntime.runtime.request(recoveryInput());
  await emptyRuntime.runtime.planAndApply(
    { historySet: { syncType: 6, peerDataRequestSessionId: 'synthetic-session-1', messages: [] } },
    emptyRuntime.handlers(),
  );
  assert.equal(emptyRuntime.rows.length, 0);
  assert.equal(emptyRuntime.runtime.status(emptyCreated.requestId!).status, 'empty');
});

test('timeout stays isolated and a late upsert with the recovery request id is not live', async () => {
  const { runtime, rows, handlers, advance } = harness();
  const created = await runtime.request(recoveryInput());
  advance(5_000);
  assert.equal(runtime.status(created.requestId!).status, 'timeout');
  const sink = handlers();
  await runtime.planAndApply(
    {
      upsert: {
        type: 'notify',
        requestId: 'synthetic-session-1',
        messages: [inbound({ key: { id: 'SYNTHETICMSG000009' }, messageTimestamp: ANCHOR_TS - 30 })],
      },
    },
    sink,
  );
  assert.equal(sink.calls.live, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageTimestamp, ANCHOR_TS - 30);
  assert.equal(rows[0].key.fromMe, false);
  assert.equal(runtime.status(created.requestId!).status, 'late-received');
});

test('genuine live upserts stay live while recovery is isolated', async () => {
  const { runtime, rows, handlers } = harness();
  await runtime.request(recoveryInput());
  const live = handlers();
  await runtime.planAndApply(
    {
      upsert: {
        type: 'notify',
        messages: [inbound({ key: { id: 'SYNTHETICLIVE000001' }, messageTimestamp: ANCHOR_TS + 20 })],
      },
    },
    live,
  );
  assert.equal(live.calls.live, 1);
  assert.equal(rows.length, 0);

  const placeholder = handlers();
  await runtime.planAndApply(
    {
      upsert: {
        type: 'notify',
        requestId: 'synthetic-placeholder-other',
        messages: [inbound({ key: { id: 'SYNTHETICLIVE000002' } })],
      },
    },
    placeholder,
  );
  assert.equal(placeholder.calls.live, 1);
  assert.equal(rows.length, 0);

  const recent = handlers();
  await runtime.planAndApply({ historySet: { syncType: 3, messages: [inbound()] } }, recent);
  assert.equal(recent.calls.history, 1);
  assert.equal(rows.length, 0);
});

test('recovery upsert matching the session id does not call the live handler', async () => {
  const { runtime, rows, handlers } = harness();
  await runtime.request(recoveryInput());
  const sink = handlers();
  await runtime.planAndApply(
    {
      upsert: {
        type: 'notify',
        requestId: 'synthetic-session-1',
        messages: [inbound({ key: { id: 'SYNTHETICMSG000008', fromMe: false } })],
      },
    },
    sink,
  );
  assert.equal(sink.calls.live, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'HISTORY');
});

test('disabled persistence and database lookup failure do not invent rows', async () => {
  const disabled = harness({ persistence: false });
  await disabled.runtime.request(recoveryInput());
  await disabled.runtime.planAndApply(
    { historySet: { syncType: 6, peerDataRequestSessionId: 'synthetic-session-1', messages: [inbound()] } },
    disabled.handlers(),
  );
  assert.equal(disabled.rows.length, 0);

  const failing = harness();
  failing.setLookup(async () => {
    throw new Error('synthetic database offline');
  });
  const created = await failing.runtime.request(recoveryInput());
  await failing.runtime.planAndApply(
    { historySet: { syncType: 6, peerDataRequestSessionId: 'synthetic-session-1', messages: [inbound()] } },
    failing.handlers(),
  );
  assert.equal(failing.rows.length, 0);
  assert.match(failing.runtime.status(created.requestId!).error || '', /database offline/);
});

test('live delivery still runs when recovery persistence throws', async () => {
  let live = 0;
  await applyBaileysEventRouting(
    {
      passthroughHistorySet: false,
      recoveryBatches: [
        {
          requestId: 'hr_synthetic',
          provenance: {
            provenance: 'on-demand-history',
            requestId: 'hr_synthetic',
            peerDataRequestSessionId: null,
            direction: 'older-than-anchor',
            anchorMessageId: ANCHOR_ID,
            anchorFromMe: false,
            anchorTimestampSeconds: ANCHOR_TS,
            syncType: 'ON_DEMAND',
            recoveredAt: '2026-01-01T00:00:00.000Z',
          },
          messages: [],
        },
      ],
      liveUpsert: { messages: [inbound()] },
    },
    {
      liveUpsert: async () => {
        live += 1;
      },
      passthroughHistory: async () => {
        throw new Error('history passthrough should not run');
      },
      persistRecovery: async () => {
        throw new Error('synthetic persist failure');
      },
    },
  );
  assert.equal(live, 1);
});

test('rate limit is finite after the in-flight request settles', async () => {
  const { runtime, advance } = harness();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const view = await runtime.request(recoveryInput());
    assert.equal(view.status, 'accepted');
    advance(15_000);
  }
  const limited = await runtime.request(recoveryInput());
  assert.equal(limited.status, 'rate-limited');
  assert.equal(limited.httpStatus, 429);
});

test('schema and authenticated route contract reject bad input and missing api key', async () => {
  const invalid = validate({ remoteJid: JID, count: 100 }, historyRecoverySchema);
  assert.equal(invalid.valid, false);
  const valid = validate(recoveryInput(), historyRecoverySchema);
  assert.equal(valid.valid, true);

  const app = express();
  app.use(express.json());
  app.post('/chat/recoverHistory/:instanceName', (req, res) => {
    if (req.get('apikey') !== 'synthetic-api-key') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const result = validate(req.body, historyRecoverySchema);
    if (!result.valid) {
      return res.status(400).json({ error: 'invalid' });
    }
    return res.status(202).json({ status: 'accepted', verification: { liveWhatsAppExecution: false } });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  try {
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/chat/recoverHistory/synthetic-instance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(recoveryInput()),
    });
    assert.equal(unauthenticated.status, 401);
    const bad = await fetch(`http://127.0.0.1:${port}/chat/recoverHistory/synthetic-instance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: 'synthetic-api-key' },
      body: JSON.stringify({ remoteJid: JID }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const router = readFileSync('src/api/routes/chat.router.ts', 'utf8');
  assert.match(router, /routerPath\('recoverHistory'\), \.\.\.guards/);
  assert.match(router, /routerPath\('recoverHistoryStatus'\), \.\.\.guards/);
  const chatwoot = readFileSync('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', 'utf8');
  assert.match(chatwoot, /withoutRecoveredHistory\(/);
  const service = readFileSync('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', 'utf8');
  assert.match(service, /planAndApply\(/);
  assert.equal(service.includes('syncFullHistory = true'), false);
});

test('unread and chatwoot filters exclude recovered status', () => {
  const where = withoutRecoveredHistory({ instanceId: 'synthetic-instance', messageTimestamp: { gte: 10 } });
  assert.deepEqual(where.NOT, { status: 'HISTORY' });
  assert.equal(where.instanceId, 'synthetic-instance');
});

test('CLI requires the API key from the environment', async () => {
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli/recover-history.ts'], {
    env: { ...process.env, EVOLUTION_API_KEY: '' },
    cwd: process.cwd(),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number>((resolve) => child.on('close', (exitCode) => resolve(exitCode ?? 1)));
  assert.equal(code, 2);
  assert.match(stderr, /EVOLUTION_API_KEY/);
  assert.equal(stderr.includes('synthetic-api-key'), false);
});
