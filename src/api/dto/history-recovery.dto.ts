export class HistoryRecoveryAnchorDto {
  id: string;
  remoteJid?: string;
  fromMe: boolean;
  timestamp: number;
}

export class HistoryRecoveryDto {
  remoteJid: string;
  anchor: HistoryRecoveryAnchorDto;
  count: number;
  page?: number;
  notBeforeTimestamp?: number;
  notAfterTimestamp?: number;
  dryRun?: boolean;
  timeoutMs?: number;
}
