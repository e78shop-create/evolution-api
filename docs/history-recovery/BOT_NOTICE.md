# BOT_NOTICE

Este patch foi escrito por um agente de código no fork público `e78shop-create/evolution-api`, contra a baseline de aplicação 2.3.7 (`cd800f2976e1e5b682fbf86a01ee4d85ae61f370`) e Baileys `7.0.0-rc.9`.

Não é merge upstream. Não foi executado em WhatsApp, não leu sessão, não enviou mensagem e não tocou em banco.

Limites que o texto deste repositório não pode ultrapassar:

- Recuperação é opt-in, uma conversa por chamada, âncora fornecida pelo operador.
- O protocolo pedido é o on-demand do Baileys, direção mais antiga que a âncora. Pode voltar vazio, parcial ou estourar o timeout.
- Nenhum corpo é inventado para preencher a janela da indisponibilidade.
- Histórico correlacionado não segue o caminho de mensagem nova deste processo.
- Mensagem viva concorrente continua no caminho antigo.
- O watcher externo de polling em `Message` não foi alterado no box. A ferramenta offline só mexe numa cópia com a forma documentada e recusa `/home/box/wa-watch/wa_watch.py`. `messageTimestamp >= since` não isola histórico. Até o dono autorizar a aplicação dessa cópia e o reload do watcher, a implantação de ponta a ponta está **BLOCKED**.
- A direção continua sendo mais antiga que a âncora. Não há garantia de recuperar a janela inteira da indisponibilidade.
- `verification.liveWhatsAppExecution` é falso. Não anuncie restauração concluída.

Reload da API e reload do watcher exigem autorizações explícitas e separadas. Veja `DEPLOY.md`. Nenhum dos dois foi feito.
