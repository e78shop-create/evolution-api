import { JSONSchema7 } from 'json-schema';
import { v4 } from 'uuid';

export const historyRecoverySchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  additionalProperties: false,
  properties: {
    remoteJid: { type: 'string', minLength: 1, maxLength: 128 },
    anchor: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 6, maxLength: 128 },
        remoteJid: { type: 'string', minLength: 1, maxLength: 128 },
        fromMe: { type: 'boolean' },
        timestamp: { type: 'integer', minimum: 1 },
      },
      required: ['id', 'fromMe', 'timestamp'],
    },
    count: { type: 'integer', minimum: 1, maximum: 50 },
    page: { type: 'integer', minimum: 1, maximum: 20 },
    notBeforeTimestamp: { type: 'integer', minimum: 1 },
    notAfterTimestamp: { type: 'integer', minimum: 1 },
    dryRun: { type: 'boolean' },
    timeoutMs: { type: 'integer', minimum: 5000, maximum: 120000 },
  },
  required: ['remoteJid', 'anchor', 'count'],
};
