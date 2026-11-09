/**
 * Bounds for opt-in, per-conversation on-demand history recovery.
 * Baileys 7.0.0-rc.9 fetchMessageHistory sends HistorySyncOnDemandRequest.
 * The companion asks the primary phone for messages OLDER than the anchor.
 */
export const HISTORY_RECOVERY_LIMITS = {
  minCount: 1,
  maxCount: 50,
  minPage: 1,
  maxPage: 20,
  minTimeoutMs: 5_000,
  maxTimeoutMs: 120_000,
  defaultTimeoutMs: 45_000,
  minIntervalMs: 15_000,
  maxPerHour: 30,
  correlationTtlMs: 24 * 60 * 60 * 1000,
  maxTrackedRequests: 50,
  maxAuditEntries: 100,
} as const;

/** proto.HistorySync.HistorySyncType.ON_DEMAND in Baileys 7.0.0-rc.9. */
export const ON_DEMAND_SYNC_TYPE = 6;

export const HISTORY_RECOVERY_PROVENANCE = 'on-demand-history';

/**
 * Stored Message.status for recovered rows.
 * DELIVERY_ACK is what this codebase counts as unread, so recovered rows must not use it.
 */
export const HISTORY_RECOVERY_STORED_STATUS = 'HISTORY';

export const ANCHOR_MIN_UNIX_SECONDS = 1_000_000_000;
export const ANCHOR_MAX_UNIX_SECONDS = 4_000_000_000;
export const MILLISECOND_TIMESTAMP_FLOOR = 1_000_000_000_000;

export const BASELINE = {
  evolution: '2.3.7',
  evolutionCommit: 'cd800f2976e1e5b682fbf86a01ee4d85ae61f370',
  baileys: '7.0.0-rc.9',
  direction: 'older-than-anchor',
} as const;
