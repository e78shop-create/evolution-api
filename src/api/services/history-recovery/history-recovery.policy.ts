import {
  ANCHOR_MAX_UNIX_SECONDS,
  ANCHOR_MIN_UNIX_SECONDS,
  HISTORY_RECOVERY_LIMITS,
  HISTORY_RECOVERY_PROVENANCE,
  HISTORY_RECOVERY_STORED_STATUS,
  MILLISECOND_TIMESTAMP_FLOOR,
  ON_DEMAND_SYNC_TYPE,
} from './history-recovery.constants';
import {
  InboundRecoveryMessage,
  NormalizedRecoveryRequest,
  RecoveryAnchorInput,
  RecoveryCounts,
  RecoveryProvenance,
  RecoveryRecord,
  RecoveryRequestInput,
  SelectedRecoveryMessage,
  StoredRecoveryRow,
} from './history-recovery.types';

const JID_PATTERN =
  /^(?:[0-9]{6,20}@s\.whatsapp\.net|[0-9]{6,30}(?:-[0-9]{6,30})?@g\.us|[0-9]{6,20}@lid|synthetic-[a-z0-9-]{1,40}@(?:s\.whatsapp\.net|g\.us|lid))$/;

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9]{6,128}$/;

export function emptyCounts(): RecoveryCounts {
  return {
    protocolMessages: 0,
    acceptedForStorage: 0,
    persisted: 0,
    duplicates: 0,
    skippedWithoutBody: 0,
    filteredByWindow: 0,
    ignoredOtherChat: 0,
    newerOrEqualToAnchor: 0,
  };
}

export function isOnDemandSyncType(syncType: unknown): boolean {
  return syncType === ON_DEMAND_SYNC_TYPE || syncType === 'ON_DEMAND' || syncType === '6';
}

export function withoutRecoveredHistory<T extends Record<string, unknown>>(where: T): T & { NOT: { status: string } } {
  return { ...where, NOT: { status: HISTORY_RECOVERY_STORED_STATUS } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function validateAnchorTimestamp(value: unknown, errors: string[]): number | null {
  const timestamp = readInteger(value);
  if (timestamp === null) {
    errors.push('A âncora precisa de timestamp inteiro em segundos Unix.');
    return null;
  }
  if (timestamp >= MILLISECOND_TIMESTAMP_FLOOR) {
    errors.push('A âncora deve usar timestamp em segundos Unix, não milissegundos.');
    return null;
  }
  if (timestamp < ANCHOR_MIN_UNIX_SECONDS || timestamp > ANCHOR_MAX_UNIX_SECONDS) {
    errors.push('O timestamp da âncora está fora do intervalo aceito de segundos Unix.');
    return null;
  }
  return timestamp;
}

function validateOptionalWindow(value: unknown, label: string, errors: string[]): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const timestamp = readInteger(value);
  if (timestamp === null || timestamp >= MILLISECOND_TIMESTAMP_FLOOR) {
    errors.push(`${label} deve ser segundos Unix, não milissegundos.`);
    return undefined;
  }
  if (timestamp < ANCHOR_MIN_UNIX_SECONDS || timestamp > ANCHOR_MAX_UNIX_SECONDS) {
    errors.push(`${label} está fora do intervalo aceito.`);
    return undefined;
  }
  return timestamp;
}

export function validateRecoveryRequest(
  input: RecoveryRequestInput,
): { ok: true; value: NormalizedRecoveryRequest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const remoteJid = typeof input?.remoteJid === 'string' ? input.remoteJid : '';
  if (!JID_PATTERN.test(remoteJid)) {
    errors.push('remoteJid deve ser um JID de usuário, grupo, lid ou um identificador sintético de teste.');
  }

  const anchor = (input?.anchor ?? {}) as RecoveryAnchorInput;
  const anchorId = typeof anchor.id === 'string' ? anchor.id : '';
  if (!MESSAGE_ID_PATTERN.test(anchorId)) {
    errors.push('anchor.id deve ser o identificador real da mensagem âncora, sem texto livre.');
  }
  if (typeof anchor.fromMe !== 'boolean') {
    errors.push('anchor.fromMe deve ser booleano. A recuperação não infere a direção.');
  }
  const anchorRemote =
    typeof anchor.remoteJid === 'string' && anchor.remoteJid.length > 0 ? anchor.remoteJid : remoteJid;
  if (anchorRemote !== remoteJid) {
    errors.push('anchor.remoteJid deve ser o mesmo remoteJid da conversa solicitada.');
  }
  if (anchor.remoteJid !== undefined && anchor.remoteJid !== null && !JID_PATTERN.test(String(anchor.remoteJid))) {
    errors.push('anchor.remoteJid possui formato inválido.');
  }
  const timestampSeconds = validateAnchorTimestamp(anchor.timestamp, errors);

  const count = readInteger(input?.count);
  if (count === null || count < HISTORY_RECOVERY_LIMITS.minCount || count > HISTORY_RECOVERY_LIMITS.maxCount) {
    errors.push(
      `count deve ser um inteiro entre ${HISTORY_RECOVERY_LIMITS.minCount} e ${HISTORY_RECOVERY_LIMITS.maxCount}.`,
    );
  }

  const page = input?.page === undefined || input?.page === null ? 1 : readInteger(input.page);
  if (page === null || page < HISTORY_RECOVERY_LIMITS.minPage || page > HISTORY_RECOVERY_LIMITS.maxPage) {
    errors.push(
      `page deve ser um inteiro entre ${HISTORY_RECOVERY_LIMITS.minPage} e ${HISTORY_RECOVERY_LIMITS.maxPage}.`,
    );
  }

  const notBeforeTimestamp = validateOptionalWindow(input?.notBeforeTimestamp, 'notBeforeTimestamp', errors);
  const notAfterTimestamp = validateOptionalWindow(input?.notAfterTimestamp, 'notAfterTimestamp', errors);
  if (notBeforeTimestamp !== undefined && notAfterTimestamp !== undefined && notBeforeTimestamp > notAfterTimestamp) {
    errors.push('notBeforeTimestamp não pode ser maior que notAfterTimestamp.');
  }
  if (timestampSeconds !== null && notBeforeTimestamp !== undefined && notBeforeTimestamp >= timestampSeconds) {
    errors.push(
      'A recuperação sob demanda só devolve mensagens mais antigas que a âncora. A janela informada está inteiramente depois da âncora.',
    );
  }

  if (input?.dryRun !== undefined && input?.dryRun !== null && typeof input.dryRun !== 'boolean') {
    errors.push('dryRun deve ser booleano.');
  }

  const timeoutMs =
    input?.timeoutMs === undefined || input?.timeoutMs === null
      ? HISTORY_RECOVERY_LIMITS.defaultTimeoutMs
      : readInteger(input.timeoutMs);
  if (
    timeoutMs === null ||
    timeoutMs < HISTORY_RECOVERY_LIMITS.minTimeoutMs ||
    timeoutMs > HISTORY_RECOVERY_LIMITS.maxTimeoutMs
  ) {
    errors.push(
      `timeoutMs deve ser um inteiro entre ${HISTORY_RECOVERY_LIMITS.minTimeoutMs} e ${HISTORY_RECOVERY_LIMITS.maxTimeoutMs}.`,
    );
  }

  if (errors.length > 0 || timestampSeconds === null || count === null || page === null || timeoutMs === null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      remoteJid,
      anchor: {
        id: anchorId,
        remoteJid,
        fromMe: anchor.fromMe as boolean,
        timestampSeconds,
      },
      count,
      page,
      notBeforeTimestamp,
      notAfterTimestamp,
      dryRun: input.dryRun === true,
      timeoutMs,
    },
  };
}

export function unixSecondsFromProtocol(value: unknown): number | null {
  let numeric: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    numeric = value;
  } else if (isPlainObject(value) && typeof value.toNumber === 'function') {
    const converted = (value.toNumber as () => number)();
    if (typeof converted === 'number' && Number.isFinite(converted)) {
      numeric = converted;
    }
  }
  if (numeric === null) {
    return null;
  }
  if (numeric >= MILLISECOND_TIMESTAMP_FLOOR) {
    numeric = Math.floor(numeric / 1000);
  }
  return Math.floor(numeric);
}

function hasRecoverableBody(message: object | null | undefined): boolean {
  if (!isPlainObject(message)) {
    return false;
  }
  const keys = Object.keys(message).filter((key) => key !== 'messageContextInfo' && key !== '_evolutionRecovery');
  return keys.length > 0;
}

export interface SelectionResult {
  selected: SelectedRecoveryMessage[];
  counts: Pick<
    RecoveryCounts,
    | 'protocolMessages'
    | 'acceptedForStorage'
    | 'duplicates'
    | 'skippedWithoutBody'
    | 'filteredByWindow'
    | 'ignoredOtherChat'
    | 'newerOrEqualToAnchor'
  >;
}

export function selectRecoverableMessages(
  messages: InboundRecoveryMessage[] | undefined,
  record: Pick<RecoveryRecord, 'remoteJid' | 'anchor' | 'notBeforeTimestamp' | 'notAfterTimestamp'>,
): SelectionResult {
  const counts = {
    protocolMessages: messages?.length ?? 0,
    acceptedForStorage: 0,
    duplicates: 0,
    skippedWithoutBody: 0,
    filteredByWindow: 0,
    ignoredOtherChat: 0,
    newerOrEqualToAnchor: 0,
  };
  const selected: SelectedRecoveryMessage[] = [];
  const seen = new Set<string>();

  for (const raw of messages ?? []) {
    const remoteJid = typeof raw?.key?.remoteJid === 'string' ? raw.key.remoteJid : '';
    if (remoteJid !== record.remoteJid) {
      counts.ignoredOtherChat += 1;
      continue;
    }
    const id = typeof raw?.key?.id === 'string' ? raw.key.id : '';
    if (!MESSAGE_ID_PATTERN.test(id) || typeof raw?.key?.fromMe !== 'boolean') {
      counts.skippedWithoutBody += 1;
      continue;
    }
    if (!hasRecoverableBody(raw.message)) {
      counts.skippedWithoutBody += 1;
      continue;
    }
    const timestampSeconds = unixSecondsFromProtocol(raw.messageTimestamp);
    if (timestampSeconds === null) {
      counts.skippedWithoutBody += 1;
      continue;
    }
    if (timestampSeconds >= record.anchor.timestampSeconds || id === record.anchor.id) {
      counts.newerOrEqualToAnchor += 1;
      continue;
    }
    if (record.notBeforeTimestamp !== undefined && timestampSeconds < record.notBeforeTimestamp) {
      counts.filteredByWindow += 1;
      continue;
    }
    if (record.notAfterTimestamp !== undefined && timestampSeconds > record.notAfterTimestamp) {
      counts.filteredByWindow += 1;
      continue;
    }
    const identity = `${remoteJid}\u0000${id}`;
    if (seen.has(identity)) {
      counts.duplicates += 1;
      continue;
    }
    seen.add(identity);
    const participant = typeof raw.key?.participant === 'string' ? raw.key.participant : undefined;
    selected.push({
      id,
      remoteJid,
      fromMe: raw.key.fromMe,
      participant,
      timestampSeconds,
      pushName: typeof raw.pushName === 'string' ? raw.pushName : undefined,
      raw,
    });
  }

  counts.acceptedForStorage = selected.length;
  return { selected, counts };
}

export function buildProvenance(record: RecoveryRecord, recoveredAtMs: number): RecoveryProvenance {
  return {
    provenance: HISTORY_RECOVERY_PROVENANCE,
    requestId: record.requestId,
    peerDataRequestSessionId: record.peerDataRequestSessionId,
    direction: 'older-than-anchor',
    anchorMessageId: record.anchor.id,
    anchorFromMe: record.anchor.fromMe,
    anchorTimestampSeconds: record.anchor.timestampSeconds,
    syncType: 'ON_DEMAND',
    recoveredAt: new Date(recoveredAtMs).toISOString(),
  };
}

export function toStoredRecoveryRow(
  selected: SelectedRecoveryMessage,
  normalizedMessage: Record<string, unknown>,
  extras: {
    provenance: RecoveryProvenance;
    instanceId: string;
    messageType: string;
    contextInfo?: unknown;
    source?: string;
    pushName?: string | null;
  },
): StoredRecoveryRow {
  const message = { ...normalizedMessage, _evolutionRecovery: extras.provenance };
  const row: StoredRecoveryRow = {
    key: {
      id: selected.id,
      remoteJid: selected.remoteJid,
      fromMe: selected.fromMe,
      ...(selected.participant ? { participant: selected.participant } : {}),
    },
    pushName: extras.pushName ?? selected.pushName ?? null,
    status: HISTORY_RECOVERY_STORED_STATUS,
    message,
    messageType: extras.messageType || 'unknown',
    messageTimestamp: selected.timestampSeconds,
    instanceId: extras.instanceId,
    source: extras.source || 'unknown',
  };
  if (extras.contextInfo !== undefined) {
    row.contextInfo = extras.contextInfo;
  }
  return row;
}

export function addCounts(target: RecoveryCounts, extra: Partial<RecoveryCounts>): void {
  (Object.keys(extra) as Array<keyof RecoveryCounts>).forEach((key) => {
    target[key] += extra[key] ?? 0;
  });
}
