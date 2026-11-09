# Uso — recuperação de histórico

Autenticação igual às rotas de chat: header `apikey` e instância existente. O canal precisa ser Baileys e o socket precisa estar `open`. A chamada não reconecta, não faz logout e não altera `syncFullHistory`.

Identificadores abaixo são sintéticos.

## Dry-run

```bash
export EVOLUTION_API_KEY='...'
export EVOLUTION_API_URL='http://127.0.0.1:8080'
export EVOLUTION_INSTANCE='synthetic-instance'

node node_modules/tsx/dist/cli.mjs src/cli/recover-history.ts \
  --remote-jid 'synthetic-user-a@s.whatsapp.net' \
  --anchor-id 'SYNTHETICANCHOR0001' \
  --anchor-from-me false \
  --anchor-timestamp 1700000000 \
  --count 20 \
  --not-before 1690000000 \
  --dry-run
```

A chave sai só de `EVOLUTION_API_KEY`. A CLI não abre socket WhatsApp. A resposta não inclui corpo de mensagem. `wouldSend.oldestMsgTimestampMs` é o timestamp da âncora em milissegundos, unidade que o campo `oldestMsgTimestampMs` do Baileys 7.0.0-rc.9 exige. A âncora informada continua em segundos Unix, como `Message.messageTimestamp`.

## Solicitação real

Mesma CLI sem `--dry-run`, com `--poll`. Uma chamada, uma conversa, no máximo 50 mensagens, timeout entre 5s e 120s (padrão 45s).

```http
POST /chat/recoverHistory/:instanceName
apikey: <chave>
Content-Type: application/json

{
  "remoteJid": "synthetic-user-a@s.whatsapp.net",
  "anchor": {
    "id": "SYNTHETICANCHOR0001",
    "fromMe": false,
    "timestamp": 1700000000
  },
  "count": 20,
  "page": 1,
  "notBeforeTimestamp": 1690000000,
  "notAfterTimestamp": 1700000000,
  "dryRun": false,
  "timeoutMs": 45000
}
```

`page` é só rótulo. Não multiplica a busca. A página seguinte exige outra chamada, com uma âncora mais antiga escolhida pelo operador.

```http
GET /chat/recoverHistoryStatus/:instanceName?requestId=hr_...
```

## Status

| status | Significado |
| --- | --- |
| `dry-run` | Validado. Socket não foi chamado. |
| `accepted` | PDO enviado. Ainda não há lote. |
| `empty` | Lote correlacionado sem mensagem aproveitável. |
| `partial` | Chegaram menos mensagens do que `count`, ou parte foi filtrada. |
| `received` | O lote observado atingiu `count`. Não garante a janela inteira. |
| `timeout` | Nada correlacionado até o prazo. |
| `late-received` | O lote chegou depois do timeout e foi isolado mesmo assim. |
| `unavailable` | Socket fechado, método ausente, ou o Baileys recusou. Sem reconexão automática. |
| `rejected` | Entrada inválida. |
| `conflict` | Já existe uma recuperação em andamento nesta instância. |
| `rate-limited` | Intervalo mínimo de 15s ou 30 solicitações por hora, neste processo. |

HTTP: 200 dry-run e consulta, 202 accepted, 400 rejected, 409 conflict, 429 rate limit, 503 unavailable, 404 status desconhecido.

## O que a resposta nunca afirma

`verification.liveWhatsAppExecution` é sempre `false` neste build. `counts.persisted` é o que este processo gravou a partir de eventos que ele viu. Não é prova de que o telefone devolveu o período da queda.

`integration.externalDbPoller.status` é sempre `BLOCKED`.

## Consulta posterior

`POST /chat/findMessages/:instanceName` devolve as linhas, inclusive as recuperadas. O corpo está em `message`. A marca está em `message._evolutionRecovery` e em `status: "HISTORY"`. Quem trata essa consulta como fila de mensagens novas precisa aplicar o mesmo filtro do watcher.
