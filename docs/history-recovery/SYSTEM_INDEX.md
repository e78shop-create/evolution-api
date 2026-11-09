# SYSTEM_INDEX — recuperação opt-in de histórico (baseline 2.3.7)

Mapa do patch. Não é um resultado de execução contra WhatsApp.

## Baseline identificada

| Item | Valor |
| --- | --- |
| Tag | `2.3.7` |
| Commit da tag | `cd800f2976e1e5b682fbf86a01ee4d85ae61f370` |
| `package.json` version | `2.3.7` |
| Fork `main` no momento do branch | `fa09d378` (somente docs/licença sobre a tag; `src/` idêntico à tag) |
| Baileys | `7.0.0-rc.9` (`package-lock.json`, sem bump) |
| Banco deste desenho | PostgreSQL e MySQL continuam no schema atual. Sem migration. |
| Redis | Não é exigido. Limites ficam na memória do processo. |

`git diff 2.3.7...fa09d378` não altera `src/`. O patch aplica em cima desse código de aplicação.

## O que a 2.3.7 já fazia

- `client.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)` existe em Baileys `7.0.0-rc.9` (`lib/Socket/messages-recv.js`).
- Envia `PeerDataOperationRequest` do tipo `HISTORY_SYNC_ON_DEMAND` com `oldestMsgTimestampMs`.
- O retorno de `sendPeerDataOperationMessage` é o id da mensagem peer (`msgId`), não o histórico.
- A resposta esperada é `messaging-history.set` com `syncType = 6` (`ON_DEMAND`) e `peerDataRequestSessionId`.
- `messages.upsert.requestId` nesta versão é o caminho de placeholder resend. O código da 2.3.7 também o recebe. O patch isola esse evento só quando o `requestId` é o id da nossa solicitação.
- Não havia rota HTTP. O único disparo era o texto de depuração `onDemandHistSync` dentro de `messages.upsert`.
- `shouldSyncHistoryMessage` já deixa o download ocorrer (`historySyncNotification` retorna `true`). `syncFullHistory` não foi alterado.
- O handler antigo de `messaging-history.set` gravava o lote e emitia `messages.set`, inclusive para `ON_DEMAND`.

## Direção do protocolo

A solicitação pede mensagens **mais antigas que a âncora**. Não pede mensagens mais novas. Um âncora anterior à janela perdida não preenche essa janela. Para alcançar mensagens perdidas durante a indisponibilidade, a âncora precisa ser uma mensagem real que o telefone ainda conhece e que seja **mais nova** do que o trecho buscado. Cada chamada é uma página. A página seguinte é outra chamada explícita, com a mensagem mais antiga já obtida como nova âncora. Não há varredura automática.

WhatsApp pode responder vazio, parcial, ou não responder. Timeout não fabrica corpo. Status `received` ou `partial` significa apenas que este processo observou um lote correlacionado. Não significa que a janela da indisponibilidade foi recuperada.

## Fluxo

```
POST /chat/recoverHistory/:instanceName
  guards existentes (instância + apikey)
  schema JSON + validação semântica
  dry-run: não chama o socket
  senão, se state !== open: unavailable, sem reconnect
  senão: uma chamada fetchMessageHistory
        count 1..50
        key { remoteJid, fromMe, id }
        oldestMsgTimestampMs = timestampSegundos * 1000

evento Baileys
  messaging-history.set syncType != ON_DEMAND
    -> handler antigo (messages.set, Chatwoot de histórico inicial, etc.)
  messaging-history.set syncType ON_DEMAND
    -> isolado: sem messages.set, sem chatbot, sem recibo, sem unread
    -> persiste só a conversa da solicitação, com proveniência
  messages.upsert sem requestId, ou requestId desconhecido
    -> handler vivo antigo (webhook, chatbot, Chatwoot)
  messages.upsert requestId == sessão desta recuperação
    -> mesmo isolamento da recuperação, mesmo se chegar atrasado
```

## Arquivos

| Caminho | Papel |
| --- | --- |
| `src/api/services/history-recovery/history-recovery.constants.ts` | Limites, proveniência, baseline |
| `src/api/services/history-recovery/history-recovery.types.ts` | Contratos |
| `src/api/services/history-recovery/history-recovery.policy.ts` | Validação, seleção, proveniência, filtro `HISTORY` |
| `src/api/services/history-recovery/history-recovery.coordinator.ts` | Estado em memória, correlação, auditoria sem corpo |
| `src/api/services/history-recovery/history-recovery.runtime.ts` | Socket, timeout, dedupe, insert |
| `src/api/dto/history-recovery.dto.ts` | DTO |
| `src/validate/history-recovery.schema.ts` | JSONSchema7 |
| `src/api/routes/chat.router.ts` | `POST recoverHistory`, `GET recoverHistoryStatus` |
| `src/api/controllers/chat.controller.ts` | Delegação só se o canal tiver o método |
| `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` | Uma chamada de protocolo e o desvio de eventos |
| `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` | `syncLostMessages` ignora `status = HISTORY` |
| `src/cli/recover-history.ts` | CLI HTTP. Não abre WhatsApp |
| `test/history-recovery/history-recovery.test.ts` | Testes sintéticos |
| `docs/history-recovery/HANDOFF.md` | Handoff |
| `docs/history-recovery/DEPLOY.md` | Backup, build, rollback |
| `docs/history-recovery/USAGE.md` | Contrato HTTP/CLI |
| `docs/history-recovery/BOT_NOTICE.md` | Limites do que este patch não prova |
| `docs/history-recovery/history-recovery.patch` | Diff sanitizado do código |

## Persistência

Sem coluna nova. Linha em `Message`:

- `key.id`, `key.remoteJid`, `key.fromMe` e `messageTimestamp` vêm da mensagem de protocolo.
- `status` gravado como `HISTORY` para não entrar na contagem de não lidas (`DELIVERY_ACK`).
- `message._evolutionRecovery.provenance = "on-demand-history"`.
- Insert idempotente: id já existente na mesma conversa não é atualizado.
- Corpo ausente não é substituído por placeholder.
- `SAVE_DATA.NEW_MESSAGE` ou `SAVE_DATA.HISTORIC` precisa estar ligado. Se ambos estiverem desligados, nada é gravado.

## Isolamento que este processo faz

Recuperação não chama `sendDataWebhook`, `chatbotController.emit`, `readMessages`, contador de não lidas, nem `chatwootService.eventWhatsapp`. Mensagem viva concorrente, sem o `requestId` da recuperação, continua no handler antigo. `syncFullHistory` não é ligado. Não há logout, reset, limpeza de sessão, wipe de banco ou replay automático.

## BLOCKER externo

O watcher que faz polling da tabela `Message` **não está neste repositório**. Inserir histórico nessa tabela cria linhas novas com timestamp original. Enquanto o watcher não excluir a proveniência, o fim a fim **não** está seguro.

Filtro obrigatório no watcher:

```sql
COALESCE(message->'_evolutionRecovery'->>'provenance', '') <> 'on-demand-history'
AND COALESCE(status, '') <> 'HISTORY'
```

A API devolve `integration.externalDbPoller.status = "BLOCKED"` em toda resposta. Isso não é um sucesso de restauração.
