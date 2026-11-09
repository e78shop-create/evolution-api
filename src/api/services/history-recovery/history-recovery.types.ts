import { HISTORY_RECOVERY_PROVENANCE, HISTORY_RECOVERY_STORED_STATUS } from './history-recovery.constants';

export type RecoveryStatus =
  | 'dry-run'
  | 'accepted'
  | 'received'
  | 'partial'
  | 'empty'
  | 'timeout'
  | 'late-received'
  | 'unavailable'
  | 'rejected'
  | 'conflict'
  | 'rate-limited';

export interface RecoveryAnchorInput {
  id?: unknown;
  remoteJid?: unknown;
  fromMe?: unknown;
  timestamp?: unknown;
}

export interface RecoveryRequestInput {
  remoteJid?: unknown;
  anchor?: RecoveryAnchorInput | null;
  count?: unknown;
  page?: unknown;
  notBeforeTimestamp?: unknown;
  notAfterTimestamp?: unknown;
  dryRun?: unknown;
  timeoutMs?: unknown;
}

export interface NormalizedAnchor {
  id: string;
  remoteJid: string;
  fromMe: boolean;
  timestampSeconds: number;
}

export interface NormalizedRecoveryRequest {
  remoteJid: string;
  anchor: NormalizedAnchor;
  count: number;
  page: number;
  notBeforeTimestamp?: number;
  notAfterTimestamp?: number;
  dryRun: boolean;
  timeoutMs: number;
}

export interface RecoveryCounts {
  protocolMessages: number;
  acceptedForStorage: number;
  persisted: number;
  duplicates: number;
  skippedWithoutBody: number;
  filteredByWindow: number;
  ignoredOtherChat: number;
  newerOrEqualToAnchor: number;
}

export interface RecoveryProvenance {
  provenance: typeof HISTORY_RECOVERY_PROVENANCE;
  requestId: string;
  peerDataRequestSessionId: string | null;
  direction: 'older-than-anchor';
  anchorMessageId: string;
  anchorFromMe: boolean;
  anchorTimestampSeconds: number;
  syncType: 'ON_DEMAND';
  recoveredAt: string;
}

export interface InboundRecoveryMessage {
  key?: {
    id?: unknown;
    remoteJid?: unknown;
    fromMe?: unknown;
    participant?: unknown;
  } | null;
  message?: object | null;
  messageTimestamp?: unknown;
  pushName?: unknown;
  status?: unknown;
  participant?: unknown;
}

export interface SelectedRecoveryMessage {
  id: string;
  remoteJid: string;
  fromMe: boolean;
  participant?: string;
  timestampSeconds: number;
  pushName?: string;
  raw: InboundRecoveryMessage;
}

export interface RecoveryRecord {
  requestId: string;
  peerDataRequestSessionId: string | null;
  remoteJid: string;
  anchor: NormalizedAnchor;
  count: number;
  page: number;
  notBeforeTimestamp?: number;
  notAfterTimestamp?: number;
  timeoutMs: number;
  dryRun: boolean;
  status: RecoveryStatus | 'reserved';
  httpStatus: number;
  createdAt: number;
  submittedAt?: number;
  deadlineAt?: number;
  counts: RecoveryCounts;
  persistenceDisabled: boolean;
  lastError?: string;
  activeRequestId?: string;
}

export interface PublicRecoveryView {
  requestId?: string;
  activeRequestId?: string;
  status: RecoveryStatus;
  httpStatus: number;
  dryRun: boolean;
  direction: 'older-than-anchor';
  baseline: {
    evolution: string;
    evolutionCommit: string;
    baileys: string;
  };
  remoteJid?: string;
  anchor?: {
    id: string;
    fromMe: boolean;
    timestampSeconds: number;
  };
  limits: {
    count?: number;
    page?: number;
    timeoutMs?: number;
    maxCount: number;
    maxPage: number;
    minTimeoutMs: number;
    maxTimeoutMs: number;
  };
  counts: RecoveryCounts;
  wouldSend?: {
    method: 'fetchMessageHistory';
    count: number;
    oldestMsgTimestampMs: number;
    oldestMsgFromMe: boolean;
    oldestMsgId: string;
    chatJid: string;
  };
  persistence: {
    table: 'Message';
    storedStatus: typeof HISTORY_RECOVERY_STORED_STATUS;
    provenancePath: 'message._evolutionRecovery.provenance';
    provenanceValue: typeof HISTORY_RECOVERY_PROVENANCE;
    idempotent: true;
    preserves: Array<'messageTimestamp' | 'key.fromMe' | 'key.id' | 'key.remoteJid'>;
    persistenceDisabled: boolean;
  };
  delivery: {
    messagesUpsertWebhook: false;
    messagesSetWebhook: false;
    chatbotEmit: false;
    chatwootEvent: false;
    readReceipts: false;
    unreadCounter: false;
    autosend: false;
  };
  integration: {
    externalDbPoller: {
      status: 'BLOCKED';
      requiredSqlExclusion: string;
      reason: string;
    };
  };
  verification: {
    liveWhatsAppExecution: false;
    statement: string;
  };
  protocol: {
    method: 'baileys.fetchMessageHistory';
    responseEvents: Array<'messaging-history.set' | 'messages.upsert'>;
    notes: string[];
  };
  error?: string;
  errors?: string[];
}

export interface HistorySetEvent {
  messages?: InboundRecoveryMessage[];
  syncType?: unknown;
  peerDataRequestSessionId?: unknown;
  isLatest?: unknown;
  progress?: unknown;
}

export interface UpsertEvent {
  messages?: InboundRecoveryMessage[];
  type?: unknown;
  requestId?: unknown;
}

export interface RecoveryBatch {
  requestId: string;
  provenance: RecoveryProvenance;
  messages: SelectedRecoveryMessage[];
}

export interface RoutingPlan {
  passthroughHistorySet: boolean;
  historyPayload?: any;
  recoveryBatches: RecoveryBatch[];
  liveUpsert: { messages: any[]; type?: unknown; requestId?: unknown } | null;
}

export interface AuditEntry {
  at: number;
  requestId: string | null;
  event: string;
  status: string;
  counts: RecoveryCounts;
}

export interface NormalizedStoredMessage {
  key: {
    id: string;
    remoteJid: string;
    fromMe: boolean;
    participant?: string;
  };
  pushName?: string | null;
  message: Record<string, unknown>;
  contextInfo?: unknown;
  messageType: string;
  messageTimestamp: number;
  instanceId: string;
  source?: string;
}

export interface StoredRecoveryRow {
  key: {
    id: string;
    remoteJid: string;
    fromMe: boolean;
    participant?: string;
  };
  pushName: string | null;
  status: typeof HISTORY_RECOVERY_STORED_STATUS;
  message: Record<string, unknown>;
  contextInfo?: unknown;
  messageType: string;
  messageTimestamp: number;
  instanceId: string;
  source: string;
}

export interface PersistTally {
  persisted: number;
  duplicates: number;
  skippedWithoutBody: number;
  persistenceDisabled: boolean;
  error?: string;
}
