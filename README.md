# Sala

Salas de conversa efémeras. Sem conta, sem número de telefone, sem perfil, sem procura.
Abres uma sala, passas o link a quem quiseres, e a conversa desaparece quando o tempo acaba.

## Correr localmente

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # com reinício automático
```

## Como funciona a privacidade

A chave de cifra é gerada no browser e vive no **fragmento do URL** (a parte depois do `#`):

```
https://o-teu-dominio.com/s/K7PQ2M#k=Xy9...
                          ^^^^^^   ^^^^^^^
                          vai ao   nunca sai
                          servidor do browser
```

Os browsers não enviam o fragmento em pedidos HTTP. O servidor conhece o código da sala, mas
nunca vê a chave — recebe e reencaminha texto cifrado com AES-GCM 256 e não o consegue ler.
Nada é escrito em disco: as salas vivem em memória e morrem com o processo.

**O que isto não protege:** quem receber o link consegue ler tudo (partilha o link por um canal
em que confies). Não há verificação de identidade — dentro da sala, o nome é só o que a pessoa
escreveu. E qualquer participante pode copiar ou fotografar o que lá está.

## Limites já implementados

| Limite | Valor | Onde mudar |
|---|---|---|
| Salas em simultâneo | 5000 | `MAX_SALAS` |
| Pessoas por sala | 20 | `MAX_PESSOAS` |
| Mensagens guardadas | 200 (as mais recentes) | `MAX_HISTORICO` |
| Tamanho da mensagem | 8000 caracteres cifrados | `MAX_PAYLOAD` |
| Salas por IP | 20 por hora | `CRIAR_POR_IP` |
| Mensagens por ligação | 15 por 10 segundos | `ENVIAR_POR_LIGACAO` |
| Duração da sala | 1h / 24h / 7 dias | `TTLS` |

## Deploy

**Render** (mais simples, tem plano grátis)

1. Põe o código num repositório no GitHub.
2. Render → New → Web Service → liga o repositório.
3. Build command: `npm install` · Start command: `npm start`.
4. Não é preciso configurar nada mais: o Render define a variável `PORT`.

**Fly.io**

```bash
fly launch --no-deploy     # aceita a deteção de Node
fly deploy
```

Em qualquer dos dois, usa **uma só instância**. As salas vivem na memória do processo, por isso
duas instâncias não se veem uma à outra. Se precisares de escalar, mete o Redis adapter do
Socket.io (`@socket.io/redis-adapter`) e move as salas para Redis com TTL nativo.

## Antes de pores isto no ar a sério

- **Domínio e HTTPS.** Sem HTTPS a cifra no browser perde metade do sentido.
- **Abuso.** Salas anónimas atraem assédio e conteúdo ilegal. Não podes moderar o que não lês,
  por isso precisas de: um canal de denúncia associado ao código da sala, capacidade de bloquear
  um código, e termos de uso que digam o que é proibido. Fala com alguém que perceba do assunto
  antes de divulgar.
- **Logs.** Por omissão o Express não regista IPs, mas o teu alojamento regista. Verifica e
  desliga o que puderes se prometeres privacidade.
- **Custo.** Um servidor pequeno aguenta centenas de salas. WebSockets consomem memória, não CPU.

## Estrutura

```
server.js          Express + Socket.io, salas em memória, TTL e limites
public/index.html  porta de entrada, ecrã de convite e sala
public/app.js      Web Crypto (AES-GCM), ligação e interface
public/style.css   identidade visual
```
