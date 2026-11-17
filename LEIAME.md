# Mesa RPG — protótipo v2

Um único app (PWA, instalável no celular). Qualquer pessoa cria uma mesa e vira o **mestre** dela (um mestre por mesa). Jogadores sem limite entram pelo link de convite.

## Rodar
```
npm install
npm start               # http://localhost:3777  (usa process.env.PORT no Render)
npm test                # teste automático (com o servidor rodando)
```

## Publicar no Render
O `render.yaml` já define um Web Service Node (`npm install` / `node server.js`, health check `/health`).
Atenção: no plano grátis o disco é temporário; `data/` (mesas, imagens) some a cada deploy/reinício.

## Funções
- **Convite**: botão Convidar (compartilhar do celular), WhatsApp, E-mail e Copiar link. O link `/m/CODIGO` abre direto na tela de entrar na mesa.
- **PWA**: manifest + service worker + ícones, então dá para "instalar" o app na tela inicial.
- **Cena**: foto da galeria/câmera ou link, título e descrição, para todos ao vivo. **Detalhe**: zoom numa região da imagem (marcador pulsante na cena) ou uma segunda foto, com texto; a cena principal continua visível.
- **Voz**: WebRTC em malha (até 8 na voz), STUN do Google, botão de mudo, indicador de quem fala, modo ON/OFF de cada um.
- **Transcrição**: Web Speech API (pt-BR, contínua) no navegador. Cada frase final vai para o Registro do Mestre com falante, horário e ON/OFF. O botão ✍️ é para segurar e ditar.
- **ON/OFF para todos**: o botão no topo vale para a voz, o chat e as mensagens diretas.
- **Chat** do grupo + **mensagens diretas** jogador→jogador (só os dois e o mestre recebem).
- **Registro do Mestre**: só o mestre vê. Junta voz transcrita, chat, DMs, narração, dados, cenas e entradas, com filtros e exportação em .txt.
- **Dados** d4–d100 com quantidade e modificador, sorteados no servidor. **Fichas**: o jogador vê só a dele; o mestre vê e edita todas.
