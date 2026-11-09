import { randomUUID } from 'crypto';

import { BASELINE, HISTORY_RECOVERY_LIMITS } from './history-recovery.constants';
import {
  addCounts,
  buildProvenance,
  emptyCounts,
  isOnDemandSyncType,
  selectRecoverableMessages,
  validateRecoveryRequest,
} from './history-recovery.policy';
import {
  AuditEntry,
  HistorySetEvent,
  NormalizedRecoveryRequest,
  PublicRecoveryView,
  RecoveryBatch,
  RecoveryRecord,
  RecoveryRequestInput,
  RecoveryStatus,
  RoutingPlan,
} from './history-recovery.types';

const WATCHER_SQL =
  "COALESCE(message->'_evolutionRecovery'->>'provenance', '') <> 'on-demand-history' AND COALESCE(status, '') <> 'HISTORY'";

const VERIFICATION_STATEMENT =
  'Counts reflect events observed by this process only. They are not evidence that a missed outage window was recovered on a real WhatsApp device.';

function inFlight(status: RecoveryRecord['status']): boolean {
  return status === 'reserved' || status === 'accepted';
}

export class HistoryRecoveryCoordinator {
  private readonly records = new Map<string, RecoveryRecord>();
  private readonly bySession = new Map<string, string>();
  private readonly submittedAt: number[] = [];
  private lastSubmittedAt = 0;
  private readonly auditLog: AuditEntry[] = [];

  constructor(private readonly requestIdFactory: () => string = () => `hr_${randomUUID()}`) {}

  public prepare(
    input: RecoveryRequestInput,
    now: number,
  ): { ok: true; record: RecoveryRecord } | { ok: false; view: PublicRecoveryView } {
    const validated = validateRecoveryRequest(input);
    if (validated.ok === false) {
      return { ok: false, view: this.rejectedView(validated.errors) };
    }

    const value = validated.value;
    if (value.dryRun) {
      const record = this.makeRecord(value, now, 'dry-run', 200);
      this.remember(record);
      this.audit(record, 'dry-run', now);
      return { ok: true, record };
    }

    const active = this.activeRecord();
    if (active) {
      return {
        ok: false,
        view: this.conflictView(active.requestId),
      };
    }

    this.pruneSubmitted(now);
    if (this.lastSubmittedAt > 0 && now - this.lastSubmittedAt < HISTORY_RECOVERY_LIMITS.minIntervalMs) {
      return { ok: false, view: this.rateLimitedView('Aguarde o intervalo mínimo antes de outra recuperação.') };
    }
    if (this.submittedAt.length >= HISTORY_RECOVERY_LIMITS.maxPerHour) {
      return { ok: false, view: this.rateLimitedView('Limite horário de recuperações desta instância foi atingido.') };
    }

    const record = this.makeRecord(value, now, 'reserved', 202);
    this.remember(record);
    this.audit(record, 'reserve', now);
    return { ok: true, record };
  }

  public markSubmitted(requestId: string, sessionId: string, now: number): void {
    const record = this.records.get(requestId);
    if (!record || record.status !== 'reserved') {
      return;
    }
    record.status = 'accepted';
    record.httpStatus = 202;
    record.peerDataRequestSessionId = sessionId;
    record.submittedAt = now;
    record.deadlineAt = now + record.timeoutMs;
    this.bySession.set(sessionId, requestId);
    this.lastSubmittedAt = now;
    this.submittedAt.push(now);
    this.audit(record, 'submit', now);
  }

  public abort(requestId: string, status: RecoveryStatus, httpStatus: number, error: string, now: number): void {
    const record = this.records.get(requestId);
    if (!record) {
      return;
    }
    record.status = status;
    record.httpStatus = httpStatus;
    record.lastError = error;
    this.audit(record, status, now);
  }

  public expire(now: number): void {
    for (const record of this.records.values()) {
      if (record.status === 'accepted' && record.deadlineAt !== undefined && now >= record.deadlineAt) {
        record.status = 'timeout';
        record.httpStatus = 200;
        this.audit(record, 'timeout', now);
      }
    }
  }

  public planEvents(events: { historySet?: any; upsert?: any }, now: number): RoutingPlan {
    this.expire(now);
    const plan: RoutingPlan = {
      passthroughHistorySet: false,
      recoveryBatches: [],
      liveUpsert: null,
    };

    if (events.historySet) {
      if (!isOnDemandSyncType(events.historySet.syncType)) {
        plan.passthroughHistorySet = true;
        plan.historyPayload = events.historySet;
      } else {
        const batch = this.consumeHistory(events.historySet, now);
        if (batch) {
          plan.recoveryBatches.push(batch);
        }
      }
    }

    if (events.upsert) {
      const sessionId =
        events.upsert.requestId === undefined || events.upsert.requestId === null
          ? ''
          : String(events.upsert.requestId);
      const requestId = sessionId ? this.bySession.get(sessionId) : undefined;
      if (requestId && this.records.has(requestId)) {
        const batch = this.consumeMessages(requestId, events.upsert.messages, now, 'messages.upsert');
        if (batch) {
          plan.recoveryBatches.push(batch);
        }
      } else {
        plan.liveUpsert = {
          messages: events.upsert.messages ?? [],
          type: events.upsert.type,
          requestId: events.upsert.requestId,
        };
      }
    }

    return plan;
  }

  public notePersistence(
    requestId: string,
    tally: {
      persisted: number;
      duplicates: number;
      skippedWithoutBody: number;
      persistenceDisabled: boolean;
      error?: string;
    },
    now: number,
  ): void {
    const record = this.records.get(requestId);
    if (!record) {
      return;
    }
    record.counts.persisted += tally.persisted;
    record.counts.duplicates += tally.duplicates;
    record.counts.skippedWithoutBody += tally.skippedWithoutBody;
    record.persistenceDisabled = tally.persistenceDisabled;
    if (tally.error) {
      record.lastError = tally.error;
    }
    this.audit(record, 'persist', now);
  }

  public get(requestId: string, now: number): RecoveryRecord | undefined {
    this.expire(now);
    return this.records.get(requestId);
  }

  public auditEntries(): AuditEntry[] {
    return this.auditLog.map((entry) => ({ ...entry, counts: { ...entry.counts } }));
  }

  public toPublic(record: RecoveryRecord): PublicRecoveryView {
    const status = record.status === 'reserved' ? 'accepted' : record.status;
    const view: PublicRecoveryView = {
      requestId: record.requestId,
      status,
      httpStatus: record.httpStatus,
      dryRun: record.dryRun,
      direction: 'older-than-anchor',
      baseline: {
        evolution: BASELINE.evolution,
        evolutionCommit: BASELINE.evolutionCommit,
        baileys: BASELINE.baileys,
      },
      remoteJid: record.remoteJid,
      anchor: {
        id: record.anchor.id,
        fromMe: record.anchor.fromMe,
        timestampSeconds: record.anchor.timestampSeconds,
      },
      limits: {
        count: record.count,
        page: record.page,
        timeoutMs: record.timeoutMs,
        maxCount: HISTORY_RECOVERY_LIMITS.maxCount,
        maxPage: HISTORY_RECOVERY_LIMITS.maxPage,
        minTimeoutMs: HISTORY_RECOVERY_LIMITS.minTimeoutMs,
        maxTimeoutMs: HISTORY_RECOVERY_LIMITS.maxTimeoutMs,
      },
      counts: { ...record.counts },
      persistence: this.persistenceView(record.persistenceDisabled),
      delivery: this.deliveryView(),
      integration: this.integrationView(),
      verification: {
        liveWhatsAppExecution: false,
        statement: VERIFICATION_STATEMENT,
      },
      protocol: this.protocolView(),
    };
    if (record.dryRun) {
      view.wouldSend = {
        method: 'fetchMessageHistory',
        count: record.count,
        oldestMsgTimestampMs: record.anchor.timestampSeconds * 1000,
        oldestMsgFromMe: record.anchor.fromMe,
        oldestMsgId: record.anchor.id,
        chatJid: record.remoteJid,
      };
    }
    if (record.lastError) {
      view.error = record.lastError;
    }
    return view;
  }

  private consumeHistory(event: HistorySetEvent, now: number): RecoveryBatch | null {
    const sessionId =
      event.peerDataRequestSessionId === undefined || event.peerDataRequestSessionId === null
        ? ''
        : String(event.peerDataRequestSessionId);
    let requestId = sessionId ? this.bySession.get(sessionId) : undefined;
    if (!requestId) {
      const candidate = this.singleAttributableRecord(now);
      requestId = candidate?.requestId;
      if (requestId && sessionId) {
        this.bySession.set(sessionId, requestId);
        const record = this.records.get(requestId);
        if (record && !record.peerDataRequestSessionId) {
          record.peerDataRequestSessionId = sessionId;
        }
      }
    }
    if (!requestId || !this.records.has(requestId)) {
      this.auditLog.push({
        at: now,
        requestId: null,
        event: 'unsolicited-on-demand',
        status: 'ignored',
        counts: { ...emptyCounts(), protocolMessages: event.messages?.length ?? 0 },
      });
      this.trimAudit();
      return null;
    }
    return this.consumeMessages(requestId, event.messages, now, 'messaging-history.set');
  }

  private consumeMessages(
    requestId: string,
    messages: HistorySetEvent['messages'],
    now: number,
    eventName: string,
  ): RecoveryBatch | null {
    const record = this.records.get(requestId);
    if (!record || !this.correlatable(record, now)) {
      return null;
    }
    const selection = selectRecoverableMessages(messages, record);
    addCounts(record.counts, selection.counts);
    const wasTimeout = record.status === 'timeout';
    if (record.counts.acceptedForStorage === 0) {
      record.status = wasTimeout ? 'timeout' : 'empty';
    } else if (wasTimeout) {
      record.status = 'late-received';
    } else if (record.counts.acceptedForStorage >= record.count) {
      record.status = 'received';
    } else {
      record.status = 'partial';
    }
    record.httpStatus = 200;
    this.audit(record, eventName, now);
    return {
      requestId,
      provenance: buildProvenance(record, now),
      messages: selection.selected,
    };
  }

  private correlatable(record: RecoveryRecord, now: number): boolean {
    if (record.dryRun || record.status === 'reserved' || record.status === 'rejected') {
      return false;
    }
    const started = record.submittedAt ?? record.createdAt;
    return now - started <= HISTORY_RECOVERY_LIMITS.correlationTtlMs;
  }

  private singleAttributableRecord(now: number): RecoveryRecord | undefined {
    const candidates = [...this.records.values()].filter((record) => {
      if (!this.correlatable(record, now)) {
        return false;
      }
      return record.status === 'accepted' || record.status === 'timeout' || record.status === 'partial';
    });
    const accepted = candidates.filter((record) => record.status === 'accepted');
    if (accepted.length === 1) {
      return accepted[0];
    }
    if (accepted.length === 0 && candidates.length === 1) {
      return candidates[0];
    }
    return undefined;
  }

  private activeRecord(): RecoveryRecord | undefined {
    return [...this.records.values()].find((record) => inFlight(record.status));
  }

  private makeRecord(
    value: NormalizedRecoveryRequest,
    now: number,
    status: RecoveryRecord['status'],
    httpStatus: number,
  ): RecoveryRecord {
    return {
      requestId: this.requestIdFactory(),
      peerDataRequestSessionId: null,
      remoteJid: value.remoteJid,
      anchor: value.anchor,
      count: value.count,
      page: value.page,
      notBeforeTimestamp: value.notBeforeTimestamp,
      notAfterTimestamp: value.notAfterTimestamp,
      timeoutMs: value.timeoutMs,
      dryRun: value.dryRun,
      status,
      httpStatus,
      createdAt: now,
      counts: emptyCounts(),
      persistenceDisabled: false,
    };
  }

  private remember(record: RecoveryRecord): void {
    this.records.set(record.requestId, record);
    this.trimRecords();
  }

  private trimRecords(): void {
    const terminal = [...this.records.values()].filter((record) => !inFlight(record.status));
    while (this.records.size > HISTORY_RECOVERY_LIMITS.maxTrackedRequests && terminal.length > 0) {
      const oldest = terminal.shift();
      if (!oldest) {
        break;
      }
      this.records.delete(oldest.requestId);
      if (oldest.peerDataRequestSessionId) {
        this.bySession.delete(oldest.peerDataRequestSessionId);
      }
    }
  }

  private pruneSubmitted(now: number): void {
    const cutoff = now - 60 * 60 * 1000;
    while (this.submittedAt.length > 0 && this.submittedAt[0] < cutoff) {
      this.submittedAt.shift();
    }
  }

  private audit(record: RecoveryRecord, event: string, now: number): void {
    this.auditLog.push({
      at: now,
      requestId: record.requestId,
      event,
      status: record.status,
      counts: { ...record.counts },
    });
    this.trimAudit();
  }

  private trimAudit(): void {
    while (this.auditLog.length > HISTORY_RECOVERY_LIMITS.maxAuditEntries) {
      this.auditLog.shift();
    }
  }

  private persistenceView(persistenceDisabled: boolean): PublicRecoveryView['persistence'] {
    return {
      table: 'Message',
      storedStatus: 'HISTORY',
      provenancePath: 'message._evolutionRecovery.provenance',
      provenanceValue: 'on-demand-history',
      idempotent: true,
      preserves: ['messageTimestamp', 'key.fromMe', 'key.id', 'key.remoteJid'],
      persistenceDisabled,
    };
  }

  private deliveryView(): PublicRecoveryView['delivery'] {
    return {
      messagesUpsertWebhook: false,
      messagesSetWebhook: false,
      chatbotEmit: false,
      chatwootEvent: false,
      readReceipts: false,
      unreadCounter: false,
      autosend: false,
    };
  }

  private integrationView(): PublicRecoveryView['integration'] {
    return {
      externalDbPoller: {
        status: 'BLOCKED',
        requiredSqlExclusion: WATCHER_SQL,
        reason:
          'Recovered rows are inserted into Message with their original timestamps. A database poller that treats every new row as a live message will misclassify them until it excludes this provenance and HISTORY status. That watcher is not in this repository.',
      },
    };
  }

  private protocolView(): PublicRecoveryView['protocol'] {
    return {
      method: 'baileys.fetchMessageHistory',
      responseEvents: ['messaging-history.set', 'messages.upsert'],
      notes: [
        'The Baileys 7.0.0-rc.9 request asks for messages older than the anchor. It does not fetch newer messages.',
        'WhatsApp may return no data, a partial page, or nothing before the timeout. This API does not invent message bodies.',
        'A completed or partial status only means a correlated protocol batch was observed. It does not mean the outage window is complete.',
        'Page is a label for the caller. Each invocation performs one fetch. The next older page requires a new explicit call with a new anchor.',
        'syncFullHistory is not changed. There is no automatic catch-up scan.',
      ],
    };
  }

  private rejectedView(errors: string[]): PublicRecoveryView {
    return {
      status: 'rejected',
      httpStatus: 400,
      dryRun: false,
      direction: 'older-than-anchor',
      baseline: { evolution: BASELINE.evolution, evolutionCommit: BASELINE.evolutionCommit, baileys: BASELINE.baileys },
      limits: {
        maxCount: HISTORY_RECOVERY_LIMITS.maxCount,
        maxPage: HISTORY_RECOVERY_LIMITS.maxPage,
        minTimeoutMs: HISTORY_RECOVERY_LIMITS.minTimeoutMs,
        maxTimeoutMs: HISTORY_RECOVERY_LIMITS.maxTimeoutMs,
      },
      counts: emptyCounts(),
      persistence: this.persistenceView(false),
      delivery: this.deliveryView(),
      integration: this.integrationView(),
      verification: { liveWhatsAppExecution: false, statement: VERIFICATION_STATEMENT },
      protocol: this.protocolView(),
      errors,
      error: errors[0],
    };
  }

  private conflictView(activeRequestId: string): PublicRecoveryView {
    const view = this.rejectedView(['Já existe uma recuperação em andamento para esta instância.']);
    view.status = 'conflict';
    view.httpStatus = 409;
    view.activeRequestId = activeRequestId;
    return view;
  }

  private rateLimitedView(message: string): PublicRecoveryView {
    const view = this.rejectedView([message]);
    view.status = 'rate-limited';
    view.httpStatus = 429;
    return view;
  }
}

export function safeProtocolError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Falha ao solicitar histórico sob demanda.';
  return message.replace(/\s+/g, ' ').slice(0, 200);
}

export async function applyBaileysEventRouting(
  plan: RoutingPlan,
  handlers: {
    passthroughHistory: (payload: any) => Promise<void>;
    persistRecovery: (batch: RecoveryBatch) => Promise<void>;
    liveUpsert: (payload: { messages: any[]; type?: unknown; requestId?: unknown }) => Promise<void>;
    onRecoveryError?: (error: unknown) => void;
  },
): Promise<void> {
  if (plan.liveUpsert) {
    await handlers.liveUpsert(plan.liveUpsert);
  }
  if (plan.passthroughHistorySet && plan.historyPayload) {
    await handlers.passthroughHistory(plan.historyPayload);
  }
  for (const batch of plan.recoveryBatches) {
    try {
      await handlers.persistRecovery(batch);
    } catch (error) {
      handlers.onRecoveryError?.(error);
    }
  }
}
