/* Sala — cliente.
   Uma unica ligacao serve todas as conversas ao mesmo tempo.
   A chave AES-GCM de cada conversa vive no fragmento do link (#k=...),
   que os browsers nunca enviam ao servidor. */

const $ = (id) => document.getElementById(id) || document.createElement("span");
const escutar = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);
const ECRAS = ["v-app", "v-criar", "v-convite", "v-entrada"];
const CORES = ["#5a765f", "#7a6b59", "#5c6b80", "#785f76", "#6b7752", "#82665a"];

/** conversas activas nesta ligacao: code -> {chave, k, para, expira, msgs, novas, dono, ligada} */
const vivas = new Map();

let socket = null;
let activa = "";        // conversa aberta no ecra
let nome = "";
let ttl = "24h";
let convite = null;     // dados do link recebido, antes de entrar

/* ---------- Utilidades ---------- */

const mostrar = (id) => ECRAS.forEach((e) => $(e).classList.toggle("oculto", e !== id));
const erro = (id, txt) => ($(id).textContent = txt || "");
const inicial = (n) => (n || "?").trim().charAt(0).toUpperCase() || "?";
const horas = (t) => new Date(t).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });

function corDe(txt) {
  let h = 0;
  for (let i = 0; i < (txt || "").length; i++) h = (h * 31 + txt.charCodeAt(i)) >>> 0;
  return CORES[h % CORES.length];
}

function restante(ate) {
  const s = Math.max(0, ate - Date.now()) / 1000;
  if (s < 60) return "menos de um minuto";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)} dia${h >= 48 ? "s" : ""}`;
  if (h >= 1) return `${h}h ${m}m`;
  return `${m} minutos`;
}

let avisoTimer;
function avisar(txt) {
  const el = $("aviso");
  el.textContent = txt;
  el.classList.remove("oculto");
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => el.classList.add("oculto"), 2400);
}

const guardarNome = (n) => { try { localStorage.setItem("sala:nome", n); } catch {} };
const lerNome = () => { try { return localStorage.getItem("sala:nome") || ""; } catch { return ""; } };
const linkDe = (code) => `${location.origin}/s/${code}#k=${vivas.get(code)?.k || ""}`;

function ajustarAltura() {
  const h = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--alt", h + "px");
}
window.visualViewport?.addEventListener("resize", ajustarAltura);
window.addEventListener("resize", ajustarAltura);
ajustarAltura();

/* ---------- Cifra ---------- */

const b64u = {
  para: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  de: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
};

const gerarChave = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
const exportarChave = async (k) => b64u.para(await crypto.subtle.exportKey("raw", k));
const importarChave = (s) => crypto.subtle.importKey("raw", b64u.de(s), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

async function cifrar(objeto, chave) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, chave,
    new TextEncoder().encode(JSON.stringify(objeto)));
  const junto = new Uint8Array(iv.length + ct.byteLength);
  junto.set(iv); junto.set(new Uint8Array(ct), iv.length);
  return b64u.para(junto);
}

async function decifrar(texto, chave) {
  const b = b64u.de(texto);
  const claro = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, chave, b.slice(12));
  return JSON.parse(new TextDecoder().decode(claro));
}

/* ---------- Arquivo local ---------- */

const CHAVE_ARQ = "sala:minhas";

function lerArquivo() {
  try { return JSON.parse(localStorage.getItem(CHAVE_ARQ) || "[]"); } catch { return []; }
}
function gravarArquivo(v) {
  try { localStorage.setItem(CHAVE_ARQ, JSON.stringify(v.slice(0, 60))); } catch {}
}
function guardarSala(entrada) {
  const v = lerArquivo().filter((x) => x.code !== entrada.code);
  v.unshift(entrada);
  gravarArquivo(v);
}
function etiquetar(code, quem) {
  const v = lerArquivo();
  const i = v.findIndex((x) => x.code === code);
  if (i >= 0 && !v[i].para) { v[i].para = quem; gravarArquivo(v); }
}
function esquecerSala(code) {
  gravarArquivo(lerArquivo().filter((x) => x.code !== code));
}
const souDono = () => lerArquivo().some((x) => x.dono === true);
const ehConvidado = () => lerArquivo().length > 0 && !souDono();
const primeiraViva = () => lerArquivo().find((x) => Date.now() < x.expira);

/* ---------- Som ---------- */

let audio = null, tocando = null;
const podeVibrar = (ms) => { try { navigator.vibrate?.(ms); } catch {} };

function contexto() {
  if (!audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audio = new AC();
  }
  if (audio.state === "suspended") audio.resume().catch(() => {});
  return audio;
}

function tom(freq, dur = 0.13, vol = 0.05, atraso = 0) {
  const ac = contexto();
  if (!ac) return;
  const t = ac.currentTime + atraso;
  const osc = ac.createOscillator(), g = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

const som = {
  toque: () => tom(660, 0.06, 0.025),
  enviada: () => tom(880, 0.09, 0.035),
  recebida: () => { tom(700, 0.1, 0.04); tom(940, 0.1, 0.035, 0.09); },
  entrou: () => { tom(620, 0.12, 0.04); tom(830, 0.14, 0.04, 0.12); },
  atendida: () => { tom(560, 0.1, 0.05); tom(750, 0.12, 0.05, 0.1); tom(940, 0.16, 0.05, 0.21); },
  desligada: () => { tom(480, 0.14, 0.05); tom(330, 0.2, 0.045, 0.13); },
};

function tocarChamada(tipo) {
  pararToque();
  const padrao = tipo === "entrada"
    ? () => { tom(700, 0.22, 0.075); tom(940, 0.26, 0.07, 0.24); podeVibrar([250, 180, 250]); }
    : () => tom(430, 0.32, 0.035);
  padrao();
  tocando = setInterval(padrao, tipo === "entrada" ? 2400 : 2600);
}

function pararToque() {
  clearInterval(tocando);
  tocando = null;
  podeVibrar(0);
}

document.addEventListener("pointerdown", (e) => {
  if (e.target.closest("button")) { som.toque(); podeVibrar(8); }
}, { passive: true });

/* ---------- Painel de conversas ---------- */

function abrirPalco(aberta) {
  $("v-app").classList.toggle("com-sala", aberta);
  $("v-sala").classList.toggle("oculto", !aberta);
  $("v-nada").classList.toggle("oculto", aberta);
}

function modoConvidado() {
  const convidado = ehConvidado();
  $("v-app").classList.toggle("convidado", convidado);
  $("b-nova").classList.toggle("oculto", convidado);
  $("b-sair").classList.toggle("oculto", convidado);
  $("b-voltar-lista").classList.toggle("oculto", convidado);
  $("b-fechar").classList.toggle("oculto", convidado);
  document.body.classList.toggle("sem-painel", convidado);
}

function desenharLista() {
  const v = lerArquivo();
  const alvo = $("lista");
  alvo.textContent = "";
  $("meu-nome").textContent = lerNome() || "sem nome";
  modoConvidado();

  if (!v.length) {
    const p = document.createElement("p");
    p.className = "vazio-lista";
    p.textContent = "Ainda não tens conversas. Começa uma e manda o link à pessoa.";
    alvo.append(p);
    return;
  }

  for (const sala of v) {
    const morta = Date.now() > sala.expira;
    const estado = vivas.get(sala.code);
    const item = document.createElement("div");
    item.className = "item" + (morta ? " morta" : "") + (sala.code === activa ? " activa" : "");

    const av = document.createElement("div");
    av.className = "item-avatar";
    av.style.background = corDe(sala.para || sala.code);
    av.textContent = inicial(sala.para || sala.code);

    const txt = document.createElement("button");
    txt.className = "item-texto";
    const n = document.createElement("p");
    n.className = "item-nome";
    n.textContent = sala.para || "À espera de alguém";
    const sub = document.createElement("p");
    sub.className = "item-sub";
    sub.textContent = morta ? "terminada" : `termina daqui a ${restante(sala.expira)}`;
    txt.append(n, sub);
    txt.addEventListener("click", () => { if (!morta) abrirConversa(sala.code); });

    const direita = document.createElement("div");
    direita.className = "item-direita";
    if (estado?.novas > 0 && sala.code !== activa) {
      const b = document.createElement("span");
      b.className = "bolha";
      b.textContent = estado.novas > 99 ? "99+" : String(estado.novas);
      direita.append(b);
    }
    const acao = document.createElement("button");
    acao.className = "item-acao";
    acao.setAttribute("aria-label", morta ? "Esquecer" : "Copiar link");
    acao.textContent = morta ? "\u00d7" : "\u29c9";
    acao.addEventListener("click", (e) => {
      e.stopPropagation();
      if (morta) { esquecerSala(sala.code); vivas.delete(sala.code); desenharLista(); return; }
      partilharOuCopiar(sala.code);
    });
    direita.append(acao);

    item.append(av, txt, direita);
    alvo.append(item);
  }
}

/* ---------- Ligação única, várias conversas ---------- */

function garantirSocket() {
  if (socket) return socket;
  socket = io({ transports: ["websocket", "polling"] });

  socket.on("connect", () => {
    for (const code of vivas.keys()) entrarNaConversa(code);
  });

  socket.on("mensagem", ({ code, ...msg }) => receber(code, msg, false));

  socket.on("presenca", ({ code, n }) => {
    const s = vivas.get(code);
    if (s) s.pessoas = n;
    if (code === activa) actualizarSub();
  });

  socket.on("sala:fechada", ({ code, motivo }) => {
    if (code === activa) {
      sistema(motivo || "Esta conversa foi apagada.");
      $("texto").disabled = true;
      $("b-enviar").disabled = true;
    }
    vivas.delete(code);
    esquecerSala(code);
    desenharLista();
  });

  socket.on("sinal", receberSinal);
  socket.on("saiu", ({ code }) => {
    if (chamada.code === code && chamada.estado !== "parado") terminar("A pessoa saiu.");
  });
  socket.on("disconnect", () => { if (activa) $("conta").textContent = "sem ligação · a tentar voltar"; });

  return socket;
}

function entrarNaConversa(code) {
  const s = vivas.get(code);
  if (!s) return;
  garantirSocket().emit("entrar", { code }, async (r) => {
    if (!r?.ok) {
      vivas.delete(code);
      esquecerSala(code);
      if (code === activa) { activa = ""; abrirPalco(false); avisar(r?.erro || "Conversa indisponível"); }
      desenharLista();
      return;
    }
    s.expira = r.expiraEm;
    const jaTinha = s.iniciada;
    s.iniciada = true;
    s.msgs = [];
    for (const m of r.historico) await receber(code, m, true);
    if (code === activa) desenharConversa();
    if (!jaTinha) {
      try { socket.emit("mensagem", { code, ct: await cifrar({ n: nome, tipo: "entrada" }, s.chave) }); } catch {}
    }
  });
}

async function receber(code, msg, doHistorico) {
  const s = vivas.get(code);
  if (!s) return;
  let claro = null;
  try { claro = await decifrar(msg.ct, s.chave); } catch {}

  const item = {
    id: msg.id, t: msg.t,
    autor: claro ? String(claro.n || "?").slice(0, 20) : "—",
    txt: claro ? String(claro.txt || "") : "",
    tipo: claro?.tipo || "",
    ilegivel: !claro,
  };
  s.msgs.push(item);
  if (s.msgs.length > 300) s.msgs.shift();

  if (item.tipo === "entrada" && item.autor !== nome) {
    if (!s.para) { s.para = item.autor; etiquetar(code, item.autor); desenharLista(); }
    if (code === activa) desenharCabecalho();
    if (!doHistorico) som.entrou();
  }

  if (code === activa) {
    pintar(item, s);
    if (!doHistorico && item.autor !== nome && item.tipo !== "entrada") som.recebida();
  } else if (!doHistorico && item.autor !== nome && item.tipo !== "entrada") {
    s.novas = (s.novas || 0) + 1;
    som.recebida();
    desenharLista();
  }
}

/* ---------- Desenhar a conversa ---------- */

let ultimoAutor = null, ultimoElemento = null;

function sistema(txt) {
  const p = document.createElement("p");
  p.className = "sistema";
  p.textContent = txt;
  $("mensagens").append(p);
  ultimoAutor = null;
  $("fim").scrollIntoView({ block: "end" });
}

function pintar(item, s) {
  if (item.tipo === "entrada") {
    sistema(`${item.autor} entrou.`);
    return;
  }
  const div = document.createElement("div");
  div.className = "msg";
  const minha = !item.ilegivel && item.autor === nome;
  if (minha) div.classList.add("minha");
  if (item.ilegivel) div.classList.add("ilegivel");

  const novoGrupo = item.autor !== ultimoAutor;
  if (novoGrupo) div.classList.add("inicio-grupo");
  else if (ultimoElemento) ultimoElemento.classList.remove("fim-grupo");
  div.classList.add("fim-grupo");

  const balao = document.createElement("div");
  balao.className = "balao";
  if (novoGrupo && !minha) {
    const a = document.createElement("span");
    a.className = "autor";
    a.textContent = item.autor;
    a.style.color = corDe(item.autor);
    balao.append(a);
  }
  const p = document.createElement("p");
  p.className = "corpo";
  p.textContent = item.ilegivel ? "mensagem cifrada com outra chave" : item.txt;
  const h = document.createElement("span");
  h.className = "hora";
  h.textContent = horas(item.t);
  balao.append(p, h);
  div.append(balao);

  $("mensagens").append(div);
  ultimoAutor = item.autor;
  ultimoElemento = div;
  $("fim").scrollIntoView({ behavior: "smooth", block: "end" });
}

function desenharConversa() {
  const s = vivas.get(activa);
  if (!s) return;
  $("mensagens").textContent = "";
  ultimoAutor = null; ultimoElemento = null;
  for (const m of s.msgs) pintar(m, s);
  $("fim").scrollIntoView({ block: "end" });
}

function desenharCabecalho() {
  const s = vivas.get(activa);
  const outro = s?.para || "";
  $("titulo-sala").textContent = outro ? `Conversa com ${outro}` : "À espera de alguém";
  $("avatar-sala").textContent = outro ? inicial(outro) : "·";
  $("avatar-sala").style.background = corDe(outro || activa);
}

function actualizarSub() {
  const s = vivas.get(activa);
  if (!s) return;
  const p = s.pessoas === undefined ? "" : s.pessoas <= 1 ? "só tu · " : "2 pessoas · ";
  $("conta").textContent = `${p}termina daqui a ${restante(s.expira)}`;
}

async function abrirConversa(code) {
  if (!vivas.has(code)) {
    const g = lerArquivo().find((x) => x.code === code && Date.now() < x.expira);
    if (g) {
      try {
        vivas.set(code, {
          chave: await importarChave(g.k), k: g.k, para: g.para || "",
          expira: g.expira, msgs: [], novas: 0, dono: !!g.dono,
        });
        entrarNaConversa(code);
      } catch {}
    }
  }
  const s = vivas.get(code);
  if (!s) { avisar("Não foi possível abrir esta conversa"); mostrarAlgo(); return; }
  activa = code;
  s.novas = 0;
  $("texto").disabled = false;
  $("b-enviar").disabled = false;
  erro("e-sala", "");
  mostrar("v-app");
  abrirPalco(true);
  desenharCabecalho();
  actualizarSub();
  desenharConversa();
  desenharLista();
  if (chamada.estado !== "parado" && chamada.code === code) ecraChamada(chamada.estado, $("chamada-estado").textContent);
  else if (chamada.code !== code) $("chamada").classList.add("oculto");
  history.replaceState(null, "", `/s/${code}#k=${s.k}`);
}

function voltarAoPainel() {
  if (ehConvidado()) return;
  activa = "";
  abrirPalco(false);
  desenharLista();
  history.replaceState(null, "", "/");
}

/* ---------- Enviar ---------- */

async function enviar() {
  const txt = $("texto").value.trim();
  const s = vivas.get(activa);
  if (!txt || !s) return;
  if (!socket?.connected) return erro("e-sala", "Sem ligação. Espera um instante.");
  $("texto").value = "";
  $("texto").style.height = "auto";
  som.enviada();
  try {
    socket.emit("mensagem", { code: activa, ct: await cifrar({ n: nome, txt }, s.chave) },
      (r) => erro("e-sala", r?.ok ? "" : r?.erro));
  } catch {
    erro("e-sala", "Não foi possível enviar.");
  }
}

escutar("b-enviar", "click", enviar);
escutar("texto", "keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); }
});
escutar("texto", "input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
});

/* ---------- Criar ---------- */

document.querySelectorAll(".opcao").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".opcao").forEach((o) => {
      o.classList.remove("activa"); o.setAttribute("aria-checked", "false");
    });
    b.classList.add("activa"); b.setAttribute("aria-checked", "true");
    ttl = b.dataset.ttl;
  })
);

async function criarSala() {
  const n = ($("nome-criar").value.trim() || lerNome()).trim();
  if (!n) return erro("e-criar", "Escreve o teu nome primeiro.");
  $("b-criar").disabled = true;
  $("b-criar").textContent = "A criar…";
  try {
    nome = n; guardarNome(n);
    const chave = await gerarChave();
    const k = await exportarChave(chave);
    const r = await fetch("/api/salas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttl, limite: 2, anfitriao: await cifrar({ nome: n }, chave) }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro);

    vivas.set(d.code, { chave, k, para: "", expira: d.expiraEm, msgs: [], novas: 0, dono: true });
    guardarSala({ code: d.code, k, para: "", expira: d.expiraEm, dono: true });
    entrarNaConversa(d.code);

    convite = d.code;
    $("cod-convite").textContent = d.code;
    $("link-sala").textContent = linkDe(d.code);
    erro("e-criar", "");
    mostrar("v-convite");
  } catch (e) {
    erro("e-criar", e.message || "Não foi possível criar a conversa.");
  } finally {
    $("b-criar").disabled = false;
    $("b-criar").textContent = "Criar a conversa";
  }
}

escutar("b-criar", "click", criarSala);
escutar("nome-criar", "keydown", (e) => e.key === "Enter" && criarSala());

/* ---------- Convite ---------- */

async function partilharOuCopiar(code) {
  const link = linkDe(code);
  if (navigator.share) {
    try { await navigator.share({ title: "Sala", text: "Conversa privada. Este link expira.", url: link }); return; } catch { return; }
  }
  try { await navigator.clipboard.writeText(link); avisar("Link copiado"); }
  catch { prompt("Copia este link:", link); }
}

escutar("b-partilhar", "click", () => partilharOuCopiar(convite));
escutar("b-copiar", "click", () => partilharOuCopiar(convite));
escutar("b-entrar-minha", "click", () => abrirConversa(convite));
escutar("b-lista", "click", () => { mostrar("v-app"); abrirPalco(false); desenharLista(); history.replaceState(null, "", "/"); });
escutar("b-convidar", "click", () => partilharOuCopiar(activa));
if (navigator.share) $("b-partilhar").classList.remove("oculto");

/* ---------- Entrar por convite ---------- */

async function prepararEntrada() {
  const code = (location.pathname.split("/s/")[1] || "").toUpperCase().slice(0, 6);
  const k = new URLSearchParams(location.hash.slice(1)).get("k") || "";
  mostrar("v-entrada");

  if (!code || !k) {
    $("titulo-entrada").textContent = "Link incompleto";
    $("info-entrada").textContent = "Falta a parte depois do #. Pede o link inteiro a quem te convidou.";
    return;
  }

  let chave;
  try { chave = await importarChave(k); } catch {
    $("titulo-entrada").textContent = "Chave inválida";
    $("info-entrada").textContent = "Este link está danificado.";
    return;
  }

  try {
    const r = await fetch(`/api/salas/${code}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro);
    let dono = "";
    if (d.anfitriao) { try { dono = (await decifrar(d.anfitriao, chave)).nome || ""; } catch {} }

    convite = { code, k, chave, expira: d.expiraEm, dono };
    $("avatar-anfitriao").textContent = inicial(dono || code);
    $("avatar-anfitriao").style.background = corDe(dono || code);
    $("titulo-entrada").textContent = dono ? `Bem-vindo à conversa do ${dono}` : `Conversa ${code}`;
    $("info-entrada").textContent = `Desaparece daqui a ${restante(d.expiraEm)}. Escreve o teu nome para entrar.`;
    $("nome-entrada").value = lerNome();
    $("form-entrada").classList.remove("oculto");
  } catch (e) {
    $("titulo-entrada").textContent = "Conversa terminada";
    $("info-entrada").textContent = e.message || "Não foi possível confirmar esta conversa.";
  }
}

function entrarPorConvite() {
  const n = $("nome-entrada").value.trim();
  if (!n) return erro("e-entrada", "Escreve o teu nome para continuar.");
  if (!convite?.code) return;
  nome = n; guardarNome(n); erro("e-entrada", "");

  const { code, k, chave, expira, dono } = convite;
  vivas.set(code, { chave, k, para: dono, expira, msgs: [], novas: 0, dono: false });
  guardarSala({ code, k, para: dono, expira, dono: false });
  entrarNaConversa(code);
  modoConvidado();
  abrirConversa(code);
}

escutar("b-entrar", "click", entrarPorConvite);
escutar("nome-entrada", "keydown", (e) => e.key === "Enter" && entrarPorConvite());

/* ---------- Chamada (WebRTC ponto a ponto) ---------- */
/* O audio vai directamente de um browser para o outro. A sinalizacao passa pelo
   servidor mas vai cifrada com a chave da conversa. Para redes fechadas seria
   preciso um servidor TURN: acrescentar aqui. */

const ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // { urls: "turn:...", username: "...", credential: "..." },
];

const chamada = { estado: "parado", code: "", pc: null, stream: null, pendentes: [], oferta: null, inicio: 0, relogio: null, mudo: false };

function ecraChamada(estado, texto) {
  const s = vivas.get(chamada.code);
  const outro = s?.para || "alguém";
  const emCurso = estado === "em-curso";
  $("chamada").classList.toggle("oculto", estado === "parado");
  $("chamada").classList.toggle("a-tocar", estado === "a-tocar" || estado === "a-chamar");
  $("chamada-nome").textContent = emCurso ? `Em chamada com ${outro}` : outro;
  $("chamada-estado").textContent = texto || "";
  $("b-atender").classList.toggle("oculto", estado !== "a-tocar");
  $("b-silencio").classList.toggle("oculto", !emCurso);
  $("b-desligar").textContent = estado === "a-tocar" ? "Recusar" : "Desligar";
}

function contarTempo() {
  clearInterval(chamada.relogio);
  chamada.inicio = Date.now();
  const passo = () => {
    const s = Math.floor((Date.now() - chamada.inicio) / 1000);
    $("chamada-estado").textContent =
      `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  passo();
  chamada.relogio = setInterval(passo, 1000);
}

async function enviarSinal(objeto) {
  const s = vivas.get(chamada.code);
  if (!socket?.connected || !s) return;
  try { socket.emit("sinal", { code: chamada.code, ct: await cifrar(objeto, s.chave) }); } catch {}
}

async function criarLigacaoRTC() {
  chamada.pc = new RTCPeerConnection({ iceServers: ICE });
  chamada.pc.onicecandidate = (e) => { if (e.candidate) enviarSinal({ tipo: "ice", cand: e.candidate }); };
  chamada.pc.ontrack = (e) => { $("audio-remoto").srcObject = e.streams[0]; };
  chamada.pc.onconnectionstatechange = () => {
    const st = chamada.pc?.connectionState;
    if (st === "connected" && chamada.estado !== "em-curso") {
      chamada.estado = "em-curso";
      pararToque(); som.atendida();
      ecraChamada("em-curso", "");
      contarTempo();
    }
    if (["failed", "disconnected"].includes(st) && chamada.estado === "em-curso") terminar("A ligação caiu.");
  };
  chamada.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  chamada.stream.getTracks().forEach((t) => chamada.pc.addTrack(t, chamada.stream));
}

async function ligarPara() {
  if (chamada.estado !== "parado" || !activa) return;
  if (!socket?.connected) return avisar("Sem ligação");
  chamada.code = activa;
  try {
    chamada.estado = "a-chamar";
    ecraChamada("a-chamar", "A chamar…");
    tocarChamada("saida");
    await criarLigacaoRTC();
    const oferta = await chamada.pc.createOffer();
    await chamada.pc.setLocalDescription(oferta);
    await enviarSinal({ tipo: "oferta", sdp: chamada.pc.localDescription });
  } catch (e) {
    terminar(e.name === "NotAllowedError" ? "Precisas de dar acesso ao microfone." : "Não foi possível ligar.");
  }
}

function limparChamada() {
  pararToque();
  clearInterval(chamada.relogio);
  chamada.stream?.getTracks().forEach((t) => t.stop());
  try { chamada.pc?.close(); } catch {}
  Object.assign(chamada, { estado: "parado", pc: null, stream: null, pendentes: [], oferta: null, mudo: false });
  $("b-silencio").textContent = "Silenciar";
  $("b-silencio").classList.remove("silenciado");
  $("audio-remoto").srcObject = null;
  ecraChamada("parado");
}

function terminar(motivo) {
  if (chamada.estado !== "parado") som.desligada();
  const houve = chamada.estado === "em-curso";
  const dur = houve ? Math.floor((Date.now() - chamada.inicio) / 1000) : 0;
  const onde = chamada.code;
  limparChamada();
  if (motivo) avisar(motivo);
  if (houve && onde === activa) sistema(`Chamada terminada · ${Math.floor(dur / 60)}m ${dur % 60}s`);
}

function desligar() {
  if (chamada.estado === "parado") return;
  enviarSinal({ tipo: "fim" });
  terminar(null);
}

function alternarSilencio() {
  if (!chamada.stream) return;
  chamada.mudo = !chamada.mudo;
  chamada.stream.getAudioTracks().forEach((t) => (t.enabled = !chamada.mudo));
  $("b-silencio").textContent = chamada.mudo ? "Ligar o microfone" : "Silenciar";
  $("b-silencio").classList.toggle("silenciado", chamada.mudo);
}

async function receberSinal({ code, ct }) {
  const s = vivas.get(code);
  if (!s) return;
  let sinal;
  try { sinal = await decifrar(ct, s.chave); } catch { return; }

  if (sinal.tipo === "oferta") {
    if (chamada.estado !== "parado") {
      const antes = chamada.code;
      chamada.code = code;
      await enviarSinal({ tipo: "ocupado" });
      chamada.code = antes;
      return;
    }
    chamada.code = code;
    chamada.estado = "a-tocar";
    chamada.pendentes = [];
    chamada.oferta = sinal.sdp;
    if (code !== activa) abrirConversa(code);
    ecraChamada("a-tocar", "Está a ligar…");
    tocarChamada("entrada");
    return;
  }
  if (code !== chamada.code) return;

  if (sinal.tipo === "resposta" && chamada.pc) {
    try { await chamada.pc.setRemoteDescription(sinal.sdp); } catch {}
    return;
  }
  if (sinal.tipo === "ice") {
    if (chamada.pc?.remoteDescription) { try { await chamada.pc.addIceCandidate(sinal.cand); } catch {} }
    else chamada.pendentes.push(sinal.cand);
    return;
  }
  if (sinal.tipo === "fim") { terminar(null); return; }
  if (sinal.tipo === "ocupado") { terminar("A pessoa está ocupada."); return; }
}

escutar("b-chamar", "click", ligarPara);
escutar("b-desligar", "click", desligar);
escutar("b-silencio", "click", alternarSilencio);
escutar("b-atender", "click", async () => {
  if (!chamada.oferta) return;
  const oferta = chamada.oferta;
  chamada.oferta = null;
  pararToque();
  try {
    ecraChamada("em-curso", "A ligar…");
    await criarLigacaoRTC();
    await chamada.pc.setRemoteDescription(oferta);
    for (const c of chamada.pendentes) { try { await chamada.pc.addIceCandidate(c); } catch {} }
    chamada.pendentes = [];
    const resposta = await chamada.pc.createAnswer();
    await chamada.pc.setLocalDescription(resposta);
    await enviarSinal({ tipo: "resposta", sdp: chamada.pc.localDescription });
  } catch (e) {
    await enviarSinal({ tipo: "fim" });
    terminar(e.name === "NotAllowedError" ? "Precisas de dar acesso ao microfone." : "Não foi possível atender.");
  }
});

/* ---------- Navegação ---------- */

function irParaCriar() {
  if (ehConvidado()) {
    const minha = primeiraViva();
    if (minha) { abrirConversa(minha.code); return; }
    mostrar("v-entrada");
    $("form-entrada").classList.add("oculto");
    $("titulo-entrada").textContent = "Conversa terminada";
    $("info-entrada").textContent =
      "Esta conversa chegou ao fim. Pede um novo link a quem te convidou.";
    return;
  }
  const meu = lerNome();
  $("campo-eu").classList.toggle("oculto", !!meu);
  $("nome-criar").value = meu;
  $("b-voltar").classList.toggle("oculto", !lerArquivo().length);
  erro("e-criar", "");
  mostrar("v-criar");
  $("nome-criar").focus();
}

escutar("b-nova", "click", irParaCriar);
escutar("b-voltar", "click", () => { mostrar("v-app"); abrirPalco(!!activa); desenharLista(); });
escutar("b-sair", "click", voltarAoPainel);
escutar("b-voltar-lista", "click", voltarAoPainel);
escutar("b-eu", "click", () => {
  const novo = prompt("O teu nome:", lerNome());
  if (novo && novo.trim()) { nome = novo.trim().slice(0, 20); guardarNome(nome); desenharLista(); }
});

const menu = $("menu");
escutar("b-menu", "click", (e) => { e.stopPropagation(); menu.classList.toggle("oculto"); });
document.addEventListener("click", () => menu.classList.add("oculto"));
escutar("b-fechar", "click", () => {
  if (!activa || !confirm("Isto apaga a conversa para as duas partes. Continuar?")) return;
  const alvo = activa;
  socket?.emit("fechar", { code: alvo });
  vivas.delete(alvo);
  esquecerSala(alvo);
  voltarAoPainel();
});

setInterval(() => { if (activa) actualizarSub(); }, 30000);

/* ---------- Arranque ---------- */

function nadaVisivel() {
  return document.querySelectorAll(".ecra:not(.oculto), .app:not(.oculto)").length === 0;
}

function mostrarAlgo() {
  if (!nadaVisivel()) return;
  if (ehConvidado()) {
    mostrar("v-entrada");
    $("form-entrada").classList.add("oculto");
    $("titulo-entrada").textContent = "Conversa terminada";
    $("info-entrada").textContent = "Pede um novo link a quem te convidou.";
  } else {
    desenharLista();
    mostrar("v-app");
    abrirPalco(false);
  }
}

window.addEventListener("error", (e) => {
  if (document.querySelectorAll(".ecra:not(.oculto), .app:not(.oculto)").length === 0) {
    $("v-criar").classList.remove("oculto");
    $("e-criar").textContent = "Algo falhou ao carregar: " + (e.message || "erro desconhecido");
  }
});

async function restaurar() {
  nome = lerNome();
  const guardadas = lerArquivo().filter((x) => Date.now() < x.expira);
  for (const g of guardadas) {
    try {
      vivas.set(g.code, {
        chave: await importarChave(g.k), k: g.k, para: g.para || "",
        expira: g.expira, msgs: [], novas: 0, dono: !!g.dono,
      });
    } catch {}
  }
  if (vivas.size && nome) { garantirSocket(); for (const c of vivas.keys()) entrarNaConversa(c); }
}

async function arrancar() {
  const noLink = location.pathname.startsWith("/s/");
  const codeLink = noLink ? (location.pathname.split("/s/")[1] || "").toUpperCase().slice(0, 6) : "";
  const jaTenho = lerArquivo().some((x) => x.code === codeLink);

  await restaurar();

  modoConvidado();

  if (noLink && jaTenho && nome) { desenharLista(); abrirConversa(codeLink); return; }
  if (noLink) { await prepararEntrada(); return; }

  if (ehConvidado()) { desenharLista(); irParaCriar(); return; }
  if (lerArquivo().length && nome) { desenharLista(); mostrar("v-app"); abrirPalco(false); return; }
  irParaCriar();
}

arrancar()
  .catch((e) => { console.error(e); mostrarAlgo(); if (nadaVisivel()) irParaCriar(); })
  .finally(() => setTimeout(mostrarAlgo, 400));
