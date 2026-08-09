import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem I, O, 0, 1
const TTLS = { "1h": 60, "24h": 1440, "7d": 10080 };

const MAX_SALAS = 5000;
const MAX_PESSOAS = 20;      // tecto absoluto
const LIMITE_PADRAO = 2;     // conversa privada, so duas pessoas
const MAX_HISTORICO = 200;
const MAX_PAYLOAD = 8000; // bytes de texto cifrado
const CRIAR_POR_IP = { max: 20, janela: 60 * 60 * 1000 };
const ENVIAR_POR_LIGACAO = { max: 15, janela: 10 * 1000 };
const SINAIS_POR_LIGACAO = { max: 300, janela: 60 * 1000 };

/** @type {Map<string, {code:string, expiraEm:number, msgs:Array, criadaEm:number}>} */
const salas = new Map();
const criacoesPorIp = new Map();

function gerarCodigo() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  } while (salas.has(code));
  return code;
}

function salaViva(code) {
  const s = salas.get(code);
  if (!s) return null;
  if (Date.now() > s.expiraEm) {
    salas.delete(code);
    return null;
  }
  return s;
}

function destruirSala(code, motivo) {
  if (!salas.delete(code)) return;
  io.to(code).emit("sala:fechada", { code, motivo });
  io.in(code).socketsLeave(code);
}

function limitar(mapa, chave, regra) {
  const agora = Date.now();
  const registo = mapa.get(chave);
  if (!registo || agora > registo.reset) {
    mapa.set(chave, { n: 1, reset: agora + regra.janela });
    return true;
  }
  if (registo.n >= regra.max) return false;
  registo.n += 1;
  return true;
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use(express.static(join(__dirname, "public"), { etag: true, maxAge: 0 }));

app.post("/api/salas", (req, res) => {
  if (salas.size >= MAX_SALAS) {
    return res.status(503).json({ erro: "O servidor está cheio. Tenta daqui a pouco." });
  }
  if (!limitar(criacoesPorIp, req.ip, CRIAR_POR_IP)) {
    return res.status(429).json({ erro: "Abriste salas a mais. Espera uma hora." });
  }
  const ttlMin = TTLS[req.body?.ttl] ?? TTLS["24h"];
  const limite = Math.min(
    MAX_PESSOAS,
    Math.max(2, Number.parseInt(req.body?.limite, 10) || LIMITE_PADRAO)
  );
  const anfitriao =
    typeof req.body?.anfitriao === "string" && req.body.anfitriao.length <= 800
      ? req.body.anfitriao
      : "";
  const code = gerarCodigo();
  salas.set(code, {
    code,
    criadaEm: Date.now(),
    expiraEm: Date.now() + ttlMin * 60_000,
    anfitriao, // texto cifrado no browser: o servidor não o lê
    limite,
    msgs: [],
  });
  res.json({ code, expiraEm: salas.get(code).expiraEm });
});

app.get("/api/salas/:code", (req, res) => {
  const s = salaViva(req.params.code.toUpperCase());
  if (!s) return res.status(404).json({ erro: "Essa sala não existe ou já expirou." });
  res.json({ code: s.code, expiraEm: s.expiraEm, anfitriao: s.anfitriao });
});

app.get("/s/:code", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));

const http = createServer(app);
const io = new Server(http, { maxHttpBufferSize: 1e5, pingTimeout: 20000 });

io.on("connection", (socket) => {
  const minhas = new Set();   // uma ligacao pode servir varias conversas ao mesmo tempo
  const envios = new Map();
  const sinais = new Map();

  const contar = (c) => io.sockets.adapter.rooms.get(c)?.size ?? 0;

  socket.on("entrar", async ({ code } = {}, ack) => {
    const c = String(code || "").toUpperCase();
    const s = salaViva(c);
    if (!s) return ack?.({ ok: false, code: c, erro: "Esta conversa não existe ou já terminou." });

    if (minhas.has(c)) {
      return ack?.({ ok: true, code: c, expiraEm: s.expiraEm, historico: s.msgs });
    }
    if (minhas.size >= 30) return ack?.({ ok: false, code: c, erro: "Conversas a mais nesta ligação." });
    if (contar(c) >= (s.limite || MAX_PESSOAS)) {
      return ack?.({ ok: false, code: c, erro: "Esta conversa já está ocupada." });
    }

    minhas.add(c);
    await socket.join(c);
    ack?.({ ok: true, code: c, expiraEm: s.expiraEm, historico: s.msgs });
    io.to(c).emit("presenca", { code: c, n: contar(c) });
  });

  socket.on("mensagem", ({ code, ct } = {}, ack) => {
    const c = String(code || "").toUpperCase();
    if (!minhas.has(c)) return ack?.({ ok: false, erro: "Não estás nesta conversa." });
    if (typeof ct !== "string" || !ct || ct.length > MAX_PAYLOAD) {
      return ack?.({ ok: false, erro: "Mensagem inválida." });
    }
    if (!limitar(envios, "self", ENVIAR_POR_LIGACAO)) {
      return ack?.({ ok: false, erro: "Estás a escrever depressa demais." });
    }
    const s = salaViva(c);
    if (!s) return ack?.({ ok: false, erro: "A conversa terminou." });

    // O servidor nunca ve o conteudo: `ct` e texto cifrado no browser.
    const msg = { id: `${Date.now().toString(36)}${randomInt(1e6).toString(36)}`, ct, t: Date.now() };
    s.msgs.push(msg);
    if (s.msgs.length > MAX_HISTORICO) s.msgs.shift();
    io.to(c).emit("mensagem", { code: c, ...msg });
    ack?.({ ok: true });
  });

  // Sinalizacao das chamadas. O conteudo vai cifrado: o servidor apenas reencaminha.
  socket.on("sinal", ({ code, ct } = {}) => {
    const c = String(code || "").toUpperCase();
    if (!minhas.has(c)) return;
    if (typeof ct !== "string" || !ct || ct.length > 20000) return;
    if (!limitar(sinais, "self", SINAIS_POR_LIGACAO)) return;
    if (!salaViva(c)) return;
    socket.to(c).emit("sinal", { code: c, ct });
  });

  socket.on("sair", ({ code } = {}) => {
    const c = String(code || "").toUpperCase();
    if (!minhas.delete(c)) return;
    socket.leave(c);
    io.to(c).emit("presenca", { code: c, n: contar(c) });
    socket.to(c).emit("saiu", { code: c });
  });

  socket.on("fechar", ({ code } = {}) => {
    const c = String(code || "").toUpperCase();
    if (minhas.has(c)) destruirSala(c, "Esta conversa foi apagada.");
  });

  socket.on("disconnect", () => {
    for (const c of minhas) {
      socket.to(c).emit("saiu", { code: c });
      io.to(c).emit("presenca", { code: c, n: Math.max(0, contar(c) - 1) });
    }
    minhas.clear();
  });
});

setInterval(() => {
  const agora = Date.now();
  for (const [code, s] of salas) {
    if (agora > s.expiraEm) destruirSala(code, "A sala chegou ao fim do tempo.");
  }
}, 60_000).unref();

http.listen(PORT, () => console.log(`sala a correr em http://localhost:${PORT}`));

export { app, salas };
