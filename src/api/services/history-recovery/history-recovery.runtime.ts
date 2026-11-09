import { HISTORY_RECOVERY_STORED_STATUS } from './history-recovery.constants';
import {
  applyBaileysEventRouting,
  HistoryRecoveryCoordinator,
  safeProtocolError,
} from './history-recovery.coordinator';
import { toStoredRecoveryRow } from './history-recovery.policy';
import {
  InboundRecoveryMessage,
  NormalizedStoredMessage,
  PublicRecoveryView,
  RecoveryBatch,
  RecoveryRequestInput,
  StoredRecoveryRow,
} from './history-recovery.types';

export interface HistoryRecoveryDeps {
  connectionState: () => string | undefined;
  fetchMessageHistory: (
    count: number,
    key: { remoteJid: string; fromMe: boolean; id: string },
    oldestMsgTimestampMs: number,
  ) => Promise<unknown>;
  normalize: (message: InboundRecoveryMessage) => NormalizedStoredMessage | null;
  findExistingIds: (ids: string[], remoteJid: string) => Promise<Set<string>>;
  insertRows: (rows: StoredRecoveryRow[]) => Promise<void>;
  persistenceEnabled: () => boolean;
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
  now?: () => number;
  logger?: { info: (value: string) => void; error: (value: string) => void };
}

function defaultSchedule(fn: () => void, ms: number): { cancel: () => void } {
  const timer = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(timer) };
}

export class HistoryRecoveryRuntime {
  private readonly coordinator: HistoryRecoveryCoordinator;
  private readonly timers = new Map<string, { cancel: () => void }>();

  constructor(private readonly deps: HistoryRecoveryDeps) {
    this.coordinator = new HistoryRecoveryCoordinator();
  }

  public async request(input: RecoveryRequestInput): Promise<PublicRecoveryView> {
    const now = this.clock();
    const prepared = this.coordinator.prepare(input, now);
    if (prepared.ok === false) {
      return prepared.view;
    }
    const record = prepared.record;
    if (record.dryRun) {
      this.log(record.requestId, 'dry-run');
      return this.coordinator.toPublic(record);
    }
    if (this.deps.connectionState() !== 'open') {
      this.coordinator.abort(
        record.requestId,
        'unavailable',
        503,
        'O socket Baileys não está aberto. Nenhuma reconexão, logout ou syncFullHistory foi alterado.',
        now,
      );
      this.log(record.requestId, 'unavailable');
      return this.coordinator.toPublic(this.coordinator.get(record.requestId, now)!);
    }

    try {
      const sessionId = await this.deps.fetchMessageHistory(
        record.count,
        {
          remoteJid: record.remoteJid,
          fromMe: record.anchor.fromMe,
          id: record.anchor.id,
        },
        record.anchor.timestampSeconds * 1000,
      );
      const normalizedSession = sessionId === undefined || sessionId === null ? '' : String(sessionId);
      if (!normalizedSession) {
        throw new Error('fetchMessageHistory não retornou identificador de sessão.');
      }
      const submittedAt = this.clock();
      this.coordinator.markSubmitted(record.requestId, normalizedSession, submittedAt);
      this.armTimer(record.requestId, record.timeoutMs);
      this.log(record.requestId, 'accepted');
      return this.coordinator.toPublic(this.coordinator.get(record.requestId, submittedAt)!);
    } catch (error) {
      this.coordinator.abort(record.requestId, 'unavailable', 503, safeProtocolError(error), this.clock());
      this.log(record.requestId, 'unavailable');
      return this.coordinator.toPublic(this.coordinator.get(record.requestId, this.clock())!);
    }
  }

  public status(requestId: string): PublicRecoveryView | { status: 'rejected'; httpStatus: number; error: string } {
    if (!requestId) {
      return { status: 'rejected', httpStatus: 400, error: 'requestId é obrigatório.' };
    }
    const record = this.coordinator.get(requestId, this.clock());
    if (!record) {
      return { status: 'rejected', httpStatus: 404, error: 'Recuperação não encontrada neste processo.' };
    }
    return this.coordinator.toPublic(record);
  }

  public async planAndApply(
    events: { historySet?: any; upsert?: any },
    handlers: {
      passthroughHistory: (payload: any) => Promise<void>;
      liveUpsert: (payload: { messages: any[]; type?: unknown; requestId?: unknown }) => Promise<void>;
    },
  ): Promise<void> {
    const plan = this.coordinator.planEvents(events, this.clock());
    if (plan.recoveryBatches.length > 0) {
      for (const batch of plan.recoveryBatches) {
        this.disarm(batch.requestId);
      }
    }
    await applyBaileysEventRouting(plan, {
      passthroughHistory: handlers.passthroughHistory,
      liveUpsert: handlers.liveUpsert,
      persistRecovery: (batch) => this.persistBatch(batch),
      onRecoveryError: (error) =>
        this.deps.logger?.error(`history-recovery persist failed: ${safeProtocolError(error)}`),
    });
  }

  public async persistBatch(batch: RecoveryBatch): Promise<void> {
    const now = this.clock();
    if (!this.deps.persistenceEnabled()) {
      this.coordinator.notePersistence(
        batch.requestId,
        { persisted: 0, duplicates: 0, skippedWithoutBody: 0, persistenceDisabled: true },
        now,
      );
      this.log(batch.requestId, 'persistence-disabled');
      return;
    }

    const rows: StoredRecoveryRow[] = [];
    let skippedWithoutBody = 0;
    for (const selected of batch.messages) {
      let normalized: NormalizedStoredMessage | null = null;
      try {
        normalized = this.deps.normalize(selected.raw);
      } catch {
        normalized = null;
      }
      if (!normalized?.message || Object.keys(normalized.message).length === 0) {
        skippedWithoutBody += 1;
        continue;
      }
      rows.push(
        toStoredRecoveryRow(selected, normalized.message, {
          provenance: batch.provenance,
          instanceId: normalized.instanceId,
          messageType: normalized.messageType,
          contextInfo: normalized.contextInfo,
          source: normalized.source,
          pushName: normalized.pushName,
        }),
      );
    }

    if (rows.length === 0) {
      this.coordinator.notePersistence(
        batch.requestId,
        { persisted: 0, duplicates: 0, skippedWithoutBody, persistenceDisabled: false },
        now,
      );
      return;
    }

    let existing: Set<string>;
    try {
      existing = await this.deps.findExistingIds(
        rows.map((row) => row.key.id),
        rows[0].key.remoteJid,
      );
    } catch (error) {
      this.coordinator.notePersistence(
        batch.requestId,
        {
          persisted: 0,
          duplicates: 0,
          skippedWithoutBody,
          persistenceDisabled: false,
          error: safeProtocolError(error),
        },
        now,
      );
      return;
    }

    const fresh = rows.filter((row) => !existing.has(row.key.id));
    const duplicates = rows.length - fresh.length;
    if (fresh.some((row) => row.status !== HISTORY_RECOVERY_STORED_STATUS)) {
      this.coordinator.notePersistence(
        batch.requestId,
        {
          persisted: 0,
          duplicates,
          skippedWithoutBody,
          persistenceDisabled: false,
          error: 'Linha recuperada sem status HISTORY foi recusada.',
        },
        now,
      );
      return;
    }
    if (fresh.length > 0) {
      try {
        await this.deps.insertRows(fresh);
      } catch (error) {
        this.coordinator.notePersistence(
          batch.requestId,
          {
            persisted: 0,
            duplicates,
            skippedWithoutBody,
            persistenceDisabled: false,
            error: safeProtocolError(error),
          },
          now,
        );
        return;
      }
    }
    this.coordinator.notePersistence(
      batch.requestId,
      { persisted: fresh.length, duplicates, skippedWithoutBody, persistenceDisabled: false },
      now,
    );
    this.log(batch.requestId, 'persisted');
  }

  public audit() {
    return this.coordinator.auditEntries();
  }

  private armTimer(requestId: string, timeoutMs: number): void {
    const schedule = this.deps.schedule ?? defaultSchedule;
    const timer = schedule(() => {
      this.timers.delete(requestId);
      this.coordinator.expire(this.clock());
      this.log(requestId, 'timeout-check');
    }, timeoutMs);
    this.timers.set(requestId, timer);
  }

  private disarm(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer) {
      timer.cancel();
      this.timers.delete(requestId);
    }
  }

  private clock(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private log(requestId: string, status: string): void {
    this.deps.logger?.info(`history-recovery requestId=${requestId} status=${status}`);
  }
}

export { applyBaileysEventRouting };
