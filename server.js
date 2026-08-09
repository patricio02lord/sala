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
  io.to(code).emit("sala:fechada", { motivo });
  io.in(code).disconnectSockets(true);
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

app.use(express.static(join(__dirname, "public"), { maxAge: "1h" }));

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
  let salaAtual = null;
  const envios = new Map();

  socket.on("entrar", async ({ code } = {}, ack) => {
    if (salaAtual) return;
    const c = String(code || "").toUpperCase();
    const s = salaViva(c);
    if (!s) return ack?.({ ok: false, erro: "Essa sala não existe ou já expirou." });

    const dentro = io.sockets.adapter.rooms.get(c)?.size ?? 0;
    if (dentro >= (s.limite || MAX_PESSOAS)) {
      return ack?.({ ok: false, erro: "Esta sala já está ocupada." });
    }

    salaAtual = c;
    await socket.join(c);
    ack?.({ ok: true, expiraEm: s.expiraEm, historico: s.msgs });
    io.to(c).emit("presenca", { n: io.sockets.adapter.rooms.get(c)?.size ?? 1 });
  });

  socket.on("mensagem", ({ ct } = {}, ack) => {
    if (!salaAtual) return ack?.({ ok: false, erro: "Não estás numa sala." });
    if (typeof ct !== "string" || !ct || ct.length > MAX_PAYLOAD) {
      return ack?.({ ok: false, erro: "Mensagem inválida." });
    }
    if (!limitar(envios, "self", ENVIAR_POR_LIGACAO)) {
      return ack?.({ ok: false, erro: "Estás a escrever depressa demais." });
    }
    const s = salaViva(salaAtual);
    if (!s) return ack?.({ ok: false, erro: "A sala expirou." });

    // O servidor nunca vê o conteúdo: `ct` é texto cifrado no browser.
    const msg = { id: `${Date.now().toString(36)}${randomInt(1e6).toString(36)}`, ct, t: Date.now() };
    s.msgs.push(msg);
    if (s.msgs.length > MAX_HISTORICO) s.msgs.shift();
    io.to(salaAtual).emit("mensagem", msg);
    ack?.({ ok: true });
  });

  socket.on("fechar", () => {
    if (salaAtual) destruirSala(salaAtual, "Alguém fechou a sala.");
  });

  socket.on("disconnect", () => {
    if (!salaAtual) return;
    const n = io.sockets.adapter.rooms.get(salaAtual)?.size ?? 0;
    io.to(salaAtual).emit("presenca", { n });
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
