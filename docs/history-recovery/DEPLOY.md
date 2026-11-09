# Deploy e rollback — instalação source 2.3.7 sem git

Não execute estes passos até o dono aprovar o reload. Este patch não foi aplicado numa instância em execução. Não há tempo de indisponibilidade medido. O efeito esperado de um restart é só o da API: os sockets Baileys reconectam quando o processo volta. PostgreSQL e os arquivos de sessão não são alvo deste procedimento.

Não há migration. Não altere `syncFullHistory`. Não faça logout, reset, limpeza de sessão ou wipe.

## Antes de copiar arquivos

Na máquina da instalação, com o processo ainda no ar:

```bash
cd /caminho/da/instalacao
cp package.json package.json.bak-pre-history-recovery
cp package-lock.json package-lock.json.bak-pre-history-recovery
tar -czf "$HOME/evolution-src-pre-history-recovery.tgz" src
tar -czf "$HOME/evolution-dist-pre-history-recovery.tgz" dist
# node_modules só se você for trocar dependências. Este patch não troca.
# tar -czf "$HOME/evolution-node_modules-pre-history-recovery.tgz" node_modules
```

Confirme a baseline antes de aplicar:

```bash
node -p "require('./package.json').version"          # esperado: 2.3.7
node -p "require('./package.json').dependencies.baileys"  # esperado: 7.0.0-rc.9
node -v                                                 # esperado: 20.x na instalação descrita
```

Se `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` tiver patches locais não publicados, não substitua o arquivo inteiro. Reaplique o trecho deste diff por cima desses patches. O diff sanitizado está em `docs/history-recovery/history-recovery.patch`.

Preserve o bind atual. Este patch não altera host, porta nem `SERVER_URL`. Se a instalação escuta em localhost, continue escutando em localhost.

## Aplicar

Copie somente os arquivos do diff. Não rode `npm update`. O `package.json` deste fork só ganha o script `test:history-recovery`. Dependências não mudam.

```bash
export DATABASE_PROVIDER=postgresql
npm run db:generate
npm run test:history-recovery
npm run build
```

`db:generate` regenera o client a partir do schema que já existe. Não rode migrate. Se o build falhar, pare e restaure o backup. Não reinicie o processo.

## Reload

Só com aprovação explícita do dono. O restart derruba as conexões Baileys desta API até o processo voltar a abrir os sockets. Sessão em disco ou no PostgreSQL permanece. Não há número medido de segundos.

Depois do processo no ar, use só `--dry-run` na primeira conversa. A solicitação real é outra decisão do dono. Uma conversa por vez.

## Rollback

Com o processo parado somente se o dono já tiver aprovado parar:

```bash
rm -rf src dist
tar -xzf "$HOME/evolution-src-pre-history-recovery.tgz"
tar -xzf "$HOME/evolution-dist-pre-history-recovery.tgz"
cp package.json.bak-pre-history-recovery package.json
cp package-lock.json.bak-pre-history-recovery package-lock.json
```

Se `node_modules` não foi trocado, não restaure esse tar. Suba o processo antigo só após nova aprovação. Linhas `HISTORY` já gravadas, se alguma solicitação real tiver ocorrido, permanecem no PostgreSQL. O rollback de código não as apaga. O watcher, se ainda não filtra proveniência, continuaria vendo essas linhas. Não delete mensagens como parte do rollback.

## Ferramenta do watcher (não é o reload)

O watcher real não está no git e não foi lido. Não aponte `watcher_guard.py` para `/home/box/wa-watch/wa_watch.py`. A ferramenta recusa esse caminho antes de abrir o arquivo.

Numa cópia, fora do processo:

```bash
python3 tools/history-recovery/watcher_guard.py --target /caminho/da/copia.py
python3 tools/history-recovery/watcher_guard.py --target /caminho/da/copia.py --apply
python3 tools/history-recovery/watcher_guard.py --target /caminho/da/copia.py --rollback
```

O padrão é dry-run. `--apply` grava a cópia e cria `copia.py.bak-watcher-guard` mais um sidecar com sha256. `--rollback` devolve os bytes originais. A segunda aplicação não duplica o predicado. `fetch_rows` pode concatenar literais com `+`. SQL com variável, f-string, `.format` ou `%` é recusado e a cópia não muda. `endswith("Message")` e `.replace("Message", "")` não são consulta.

Trocar o arquivo vivo e reiniciar o watcher **não** faz parte deste passo e continua bloqueado. O filtro de timestamp do watcher não substitui os dois predicados. A direção do histórico continua sendo mais antiga que a âncora, sem garantia de cobrir a queda inteira.

## O que não fazer

- Não ligar `syncFullHistory`.
- Não chamar logout, restart de sessão ou delete de instância.
- Não apontar a atualização para o upstream `evolution-foundation/evolution-api`.
- Não tratar `counts.persisted > 0` como recuperação completa da queda.
