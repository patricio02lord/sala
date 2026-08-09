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
const MAX_PESSOAS = 20;
const LIMITE_PADRAO = 2;
const MAX_HISTORICO = 200;
const MAX_PAYLOAD = 8000;
const CRIAR_POR_IP = { max: 20, janela: 60 * 60 * 1000 };
const ENVIAR_POR_LIGACAO = { max: 15, janela: 10 * 1000 };
const SINAIS_POR_LIGACAO = { max: 300, janela: 60 * 1000 };
const TENTATIVAS_POR_IP = { max: 10, janela: 60 * 60 * 1000 };

// Só quem souber esta palavra-passe pode criar conversas.
// Define-a no Render em Environment como CHAVE_DONO.
const CHAVE_DONO = process.env.CHAVE_DONO || "";

/* ------------------------------------------------------------------ *
 * Armazém: Upstash Redis quando configurado, memória caso contrário.
 * Em qualquer dos casos guarda apenas texto já cifrado no browser.
 * ------------------------------------------------------------------ */

const URL_REDIS = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN_REDIS = process.env.UPSTASH_REDIS_REST_TOKEN;
const COM_REDIS = Boolean(URL_REDIS && TOKEN_REDIS);

async function comando(...partes) {
  const r = await fetch(URL_REDIS, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN_REDIS}`, "Content-Type": "application/json" },
    body: JSON.stringify(partes.map(String)),
  });
  if (!r.ok) throw new Error(`Redis respondeu ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

const chaveMeta = (code) => `sala:${code}`;
const chaveMsgs = (code) => `msgs:${code}`;

/** memória: usada quando não há Redis, e como plano B se ele falhar */
const memoria = new Map();

const armazem = {
  async criar(code, meta, segundos) {
    if (COM_REDIS) {
      await comando("SET", chaveMeta(code), JSON.stringify(meta), "EX", segundos);
      return;
    }
    memoria.set(code, { ...meta, msgs: [] });
  },

  async ler(code) {
    if (COM_REDIS) {
      const bruto = await comando("GET", chaveMeta(code));
      return bruto ? JSON.parse(bruto) : null;
    }
    const s = memoria.get(code);
    if (!s) return null;
    if (Date.now() > s.expiraEm) { memoria.delete(code); return null; }
    return s;
  },

  async historico(code) {
    if (COM_REDIS) {
      const linhas = (await comando("LRANGE", chaveMsgs(code), "0", "-1")) || [];
      return linhas.map((l) => JSON.parse(l));
    }
    return memoria.get(code)?.msgs ?? [];
  },

  async juntar(code, msg, segundos) {
    if (COM_REDIS) {
      await comando("RPUSH", chaveMsgs(code), JSON.stringify(msg));
      await comando("LTRIM", chaveMsgs(code), String(-MAX_HISTORICO), "-1");
      await comando("EXPIRE", chaveMsgs(code), String(segundos));
      return;
    }
    const s = memoria.get(code);
    if (!s) return;
    s.msgs.push(msg);
    if (s.msgs.length > MAX_HISTORICO) s.msgs.shift();
  },

  async apagar(code) {
    if (COM_REDIS) {
      await comando("DEL", chaveMeta(code));
      await comando("DEL", chaveMsgs(code));
      return;
    }
    memoria.delete(code);
  },

  async cheio() {
    return !COM_REDIS && memoria.size >= MAX_SALAS;
  },
};

const segundosAte = (quando) => Math.max(60, Math.ceil((quando - Date.now()) / 1000));

/* ------------------------------------------------------------------ */

const criacoesPorIp = new Map();
const tentativasPorIp = new Map();

function limitar(mapa, chave, regra) {
  const agora = Date.now();
  const reg = mapa.get(chave);
  if (!reg || agora > reg.reset) {
    mapa.set(chave, { n: 1, reset: agora + regra.janela });
    return true;
  }
  if (reg.n >= regra.max) return false;
  reg.n += 1;
  return true;
}

async function gerarCodigo() {
  for (let tentativa = 0; tentativa < 8; tentativa++) {
    const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    if (!(await armazem.ler(code))) return code;
  }
  throw new Error("Não foi possível gerar um código livre.");
}

async function salaViva(code) {
  const s = await armazem.ler(code);
  if (!s) return null;
  if (Date.now() > s.expiraEm) { await armazem.apagar(code); return null; }
  return s;
}

async function destruirSala(code, motivo) {
  await armazem.apagar(code);
  io.to(code).emit("sala:fechada", { code, motivo });
  io.in(code).socketsLeave(code);
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use(express.static(join(__dirname, "public"), { etag: true, maxAge: 0 }));

app.get("/estado", (_req, res) =>
  res.json({
    ok: true,
    armazem: COM_REDIS ? "redis" : "memoria",
    fechado: Boolean(CHAVE_DONO),
  })
);

// Confirma a palavra-passe sem criar nada, para o ecrã de entrada do dono.
app.post("/api/dono", (req, res) => {
  if (!CHAVE_DONO) return res.json({ ok: true, aberto: true });
  if (!limitar(tentativasPorIp, req.ip, TENTATIVAS_POR_IP)) {
    return res.status(429).json({ erro: "Demasiadas tentativas. Espera uma hora." });
  }
  if (req.body?.chave !== CHAVE_DONO) {
    return res.status(401).json({ erro: "Palavra-passe errada." });
  }
  res.json({ ok: true });
});

app.post("/api/salas", async (req, res) => {
  try {
    if (CHAVE_DONO) {
      if (!limitar(tentativasPorIp, req.ip, TENTATIVAS_POR_IP)) {
        return res.status(429).json({ erro: "Demasiadas tentativas. Espera uma hora." });
      }
      if (req.get("x-dono") !== CHAVE_DONO) {
        return res.status(401).json({ erro: "Só o dono pode criar conversas aqui." });
      }
    }
    if (await armazem.cheio()) {
      return res.status(503).json({ erro: "O servidor está cheio. Tenta daqui a pouco." });
    }
    if (!limitar(criacoesPorIp, req.ip, CRIAR_POR_IP)) {
      return res.status(429).json({ erro: "Criaste conversas a mais. Espera uma hora." });
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

    const code = await gerarCodigo();
    const expiraEm = Date.now() + ttlMin * 60_000;
    await armazem.criar(
      code,
      { code, criadaEm: Date.now(), expiraEm, anfitriao, limite },
      segundosAte(expiraEm)
    );
    res.json({ code, expiraEm });
  } catch (e) {
    console.error("criar sala:", e.message);
    res.status(500).json({ erro: "Não foi possível criar a conversa." });
  }
});

app.get("/api/salas/:code", async (req, res) => {
  try {
    const s = await salaViva(req.params.code.toUpperCase());
    if (!s) return res.status(404).json({ erro: "Esta conversa não existe ou já terminou." });
    res.json({ code: s.code, expiraEm: s.expiraEm, anfitriao: s.anfitriao });
  } catch (e) {
    console.error("ler sala:", e.message);
    res.status(500).json({ erro: "Não foi possível confirmar a conversa." });
  }
});

app.get("/s/:code", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));

const http = createServer(app);
const io = new Server(http, { maxHttpBufferSize: 1e5, pingTimeout: 20000 });

io.on("connection", (socket) => {
  const minhas = new Set();   // uma ligação serve várias conversas ao mesmo tempo
  const envios = new Map();
  const sinais = new Map();

  const contar = (c) => io.sockets.adapter.rooms.get(c)?.size ?? 0;

  socket.on("entrar", async ({ code } = {}, ack) => {
    try {
      const c = String(code || "").toUpperCase();
      const s = await salaViva(c);
      if (!s) return ack?.({ ok: false, code: c, erro: "Esta conversa não existe ou já terminou." });

      const historico = await armazem.historico(c);
      if (minhas.has(c)) return ack?.({ ok: true, code: c, expiraEm: s.expiraEm, historico });
      if (minhas.size >= 30) return ack?.({ ok: false, code: c, erro: "Conversas a mais nesta ligação." });
      if (contar(c) >= (s.limite || MAX_PESSOAS)) {
        return ack?.({ ok: false, code: c, erro: "Esta conversa já está ocupada." });
      }

      minhas.add(c);
      await socket.join(c);
      ack?.({ ok: true, code: c, expiraEm: s.expiraEm, historico });
      io.to(c).emit("presenca", { code: c, n: contar(c) });
    } catch (e) {
      console.error("entrar:", e.message);
      ack?.({ ok: false, erro: "Falha ao entrar. Tenta outra vez." });
    }
  });

  socket.on("mensagem", async ({ code, ct } = {}, ack) => {
    try {
      const c = String(code || "").toUpperCase();
      if (!minhas.has(c)) return ack?.({ ok: false, erro: "Não estás nesta conversa." });
      if (typeof ct !== "string" || !ct || ct.length > MAX_PAYLOAD) {
        return ack?.({ ok: false, erro: "Mensagem inválida." });
      }
      if (!limitar(envios, "self", ENVIAR_POR_LIGACAO)) {
        return ack?.({ ok: false, erro: "Estás a escrever depressa demais." });
      }
      const s = await salaViva(c);
      if (!s) return ack?.({ ok: false, erro: "A conversa terminou." });

      // O servidor nunca vê o conteúdo: `ct` é texto cifrado no browser.
      const msg = { id: `${Date.now().toString(36)}${randomInt(1e6).toString(36)}`, ct, t: Date.now() };
      io.to(c).emit("mensagem", { code: c, ...msg });
      ack?.({ ok: true });
      await armazem.juntar(c, msg, segundosAte(s.expiraEm));
    } catch (e) {
      console.error("mensagem:", e.message);
      ack?.({ ok: false, erro: "Não foi possível enviar." });
    }
  });

  // Sinalização das chamadas: cifrada, o servidor apenas reencaminha.
  socket.on("sinal", ({ code, ct } = {}) => {
    const c = String(code || "").toUpperCase();
    if (!minhas.has(c)) return;
    if (typeof ct !== "string" || !ct || ct.length > 20000) return;
    if (!limitar(sinais, "self", SINAIS_POR_LIGACAO)) return;
    socket.to(c).emit("sinal", { code: c, ct });
  });

  socket.on("sair", ({ code } = {}) => {
    const c = String(code || "").toUpperCase();
    if (!minhas.delete(c)) return;
    socket.leave(c);
    io.to(c).emit("presenca", { code: c, n: contar(c) });
    socket.to(c).emit("saiu", { code: c });
  });

  socket.on("fechar", async ({ code } = {}) => {
    const c = String(code || "").toUpperCase();
    if (minhas.has(c)) await destruirSala(c, "Esta conversa foi apagada.");
  });

  socket.on("disconnect", () => {
    for (const c of minhas) {
      socket.to(c).emit("saiu", { code: c });
      io.to(c).emit("presenca", { code: c, n: Math.max(0, contar(c) - 1) });
    }
    minhas.clear();
  });
});

// Com Redis o próprio TTL trata da limpeza; em memória é preciso varrer.
if (!COM_REDIS) {
  setInterval(() => {
    const agora = Date.now();
    for (const [code, s] of memoria) {
      if (agora > s.expiraEm) destruirSala(code, "Esta conversa chegou ao fim do tempo.");
    }
  }, 60_000).unref();
}

http.listen(PORT, () =>
  console.log(
    `sala a correr em http://localhost:${PORT}` +
    ` · armazém: ${COM_REDIS ? "Upstash Redis" : "memória"}` +
    ` · criação: ${CHAVE_DONO ? "só o dono" : "aberta"}`
  )
);

export { app, armazem, memoria };
