# BOT_NOTICE

Este patch foi escrito por um agente de código no fork público `e78shop-create/evolution-api`, contra a baseline de aplicação 2.3.7 (`cd800f2976e1e5b682fbf86a01ee4d85ae61f370`) e Baileys `7.0.0-rc.9`.

Não é merge upstream. Não foi executado em WhatsApp, não leu sessão, não enviou mensagem e não tocou em banco.

Limites que o texto deste repositório não pode ultrapassar:

- Recuperação é opt-in, uma conversa por chamada, âncora fornecida pelo operador.
- O protocolo pedido é o on-demand do Baileys, direção mais antiga que a âncora. Pode voltar vazio, parcial ou estourar o timeout.
- Nenhum corpo é inventado para preencher a janela da indisponibilidade.
- Histórico correlacionado não segue o caminho de mensagem nova deste processo.
- Mensagem viva concorrente continua no caminho antigo.
- O watcher externo de polling em `Message` não foi alterado. Até ele excluir `message._evolutionRecovery.provenance = on-demand-history` e `status = HISTORY`, a implantação de ponta a ponta está **BLOCKED**.
- `verification.liveWhatsAppExecution` é falso. Não anuncie restauração concluída.

Reload do processo exige aprovação explícita do dono. Veja `DEPLOY.md`.
