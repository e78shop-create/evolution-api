# Handoff — recuperação de histórico por conversa

Baseline de aplicação: Evolution API **2.3.7**, commit `cd800f2976e1e5b682fbf86a01ee4d85ae61f370`, Baileys **7.0.0-rc.9**. O `main` deste fork, no branch de origem `fa09d378`, só tinha commits de documentação sobre essa tag.

Este handoff é para o dono da instalação. Nenhum teste daqui falou com WhatsApp.

## O que foi entregue

Uma recuperação **opt-in**, de **uma conversa por chamada**, com âncora explícita. A API pede ao Baileys `fetchMessageHistory` uma única vez. O lote que voltar por `messaging-history.set` (`ON_DEMAND`) ou por `messages.upsert` com o mesmo id de sessão é gravado com a data, `fromMe` e id originais, ou descartado se não tiver corpo. Não há corpo fabricado.

Mensagens vivas que chegam ao mesmo tempo, sem esse id de sessão, seguem o webhook e as integrações de hoje.

## O que não foi provado

Não houve execução contra um aparelho, sessão ou banco de produção. `verification.liveWhatsAppExecution` permanece `false`. Um status `received` em produção, no futuro, ainda será só a observação de um lote. Não fecha a janela da indisponibilidade.

O protocolo só busca mensagens **mais antigas** que a âncora. Reconectar com `syncFullHistory=false` continua igual. Este patch não liga sync completo e não varre conversas.

## BLOCKER

O watcher externo continua fora do git. O contrato sanitizado confirma a lacuna: `BASE_WHERE` não tem `status <> 'HISTORY'` nem a proveniência, e `fetch_rows` não filtra isso. O filtro `messageTimestamp >= since` não substitui a proveniência.

A ferramenta offline está em `tools/history-recovery/`. Ela é dry-run por omissão, só grava com `--apply`, falha fechada se a forma não for exatamente a documentada, é idempotente e faz rollback byte a byte. Não foi executada no arquivo vivo. Deploy de ponta a ponta: **BLOCKED** até o dono autorizar, em separado, a troca da cópia revisada e o reload do watcher. Este patch não faz nenhum dos dois.

Chatwoot `syncLostMessages` neste repositório já ignora `status = HISTORY`. Isso não cobre o watcher externo.

### O que ainda falta no contrato, sem inventar

A ferramenta rejeita a cópia se aparecer qualquer um destes desvios. Para cobrir o arquivo real, o próximo contrato sanitizado precisa trazer só isto:

- o literal exato de `BASE_WHERE` se não for uma string tripla nem concatenação de literais entre parênteses
- o literal SQL único de `fetch_rows` se a busca `instanceId` + `key->>'id'` estiver partida, ou se houver `ORDER BY`, `GROUP BY` ou `LIMIT`
- se `fetch_rows` pode devolver um objeto já montado em vez de reler o SQL
- a lista de outras filas em memória que acordam sem passar por `fetch_rows`

Sem isso, um guard só em `BASE_WHERE` não esvazia um id que já estava na fila nem um segundo `SELECT` em `"Message"`.

## Corrida de persistência

`persistBatch` no runtime usado pelo Baileys agora entra numa fila. Duas gravações sobrepostas do mesmo id deixam uma linha, com timestamp, `fromMe` e `message._evolutionRecovery`. Um `history.set` seguido de `messages.upsert` com o mesmo id de sessão não reescreve a linha. Depois do timeout, um lote atrasado ainda grava `HISTORY` e a proveniência, e um upsert vivo no meio continua no handler vivo. Isso não cria índice único no PostgreSQL: dois processos da API ainda poderiam inserir duplicata. Esta instalação é um processo.

## Como operar uma conversa

1. Escolha uma conversa e uma mensagem âncora que o telefone conhece, mais nova que o trecho desejado.
2. Rode a CLI com `--dry-run`. Ela só valida e mostra o que seria enviado.
3. Se o dry-run estiver coerente, repita sem `--dry-run` e com `--poll`.
4. Leia `counts` e `status`. Vazio, parcial e timeout são resultados reais possíveis.
5. Outra conversa, ou a página mais antiga da mesma conversa, é outra invocação. Não há fila automática.

Aprovação explícita do dono é obrigatória antes de qualquer reload do processo. Veja `DEPLOY.md`.

## Comandos de verificação deste patch

```bash
npm run test:history-recovery
npm run test:watcher-guard
npx eslint --ext .ts src/api/services/history-recovery src/cli/recover-history.ts src/api/routes/chat.router.ts src/api/controllers/chat.controller.ts
```

Nesta sessão do agente: 20 testes TypeScript e 10 testes Python, 0 falhas. A leva anterior de 17 testes TypeScript foi só reportada pelo agente; o APP ainda não executou essa suíte por conta própria. ESLint dos arquivos TypeScript tocados sem erro.

`npx tsc --noEmit` neste ambiente ainda acusa `@prisma/client` sem generate (`DATABASE_PROVIDER` não foi usado; generate e migrate não foram executados). Esses erros também aparecem em controllers que este patch não alterou. Na instalação do dono, com o client já gerado:

```bash
export DATABASE_PROVIDER=postgresql
npm run db:generate
npm run build
```

`db:generate` não é migrate. Não rode `db:deploy` por causa deste patch: não há migration.

## Rollback

Restaure o backup de `src/` e `dist/` descrito em `DEPLOY.md`. Não apague sessão nem banco para desfazer este patch.
