/* Sala — cliente.
   Uma unica ligacao serve todas as conversas ao mesmo tempo.
   A chave AES-GCM de cada conversa vive no fragmento do link (#k=...),
   que os browsers nunca enviam ao servidor. */

const $ = (id) => document.getElementById(id) || document.createElement("span");
const escutar = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);
const ECRAS = ["v-app", "v-criar", "v-convite", "v-entrada", "v-fechado"];
const CORES = ["#293552", "#2f3350", "#26384e", "#332e4c", "#2b3a45", "#353046"];

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
const lerChaveDono = () => { try { return localStorage.getItem("sala:dono") || ""; } catch { return ""; } };
const guardarChaveDono = (v) => { try { localStorage.setItem("sala:dono", v); } catch {} };
let espacoFechado = false;

const souDono = () => Boolean(lerChaveDono()) || lerArquivo().some((x) => x.dono === true);
const ehConvidado = () => !lerChaveDono();
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

/* ---------- Aviso na aba e barra de vida ---------- */

const ICONE_BASE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%234F46E5'/%3E%3Crect x='11' y='10' width='10' height='12' rx='3' fill='%23fff'/%3E%3C/svg%3E";
const ICONE_AVISO =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%234F46E5'/%3E%3Crect x='11' y='10' width='10' height='12' rx='3' fill='%23fff'/%3E%3Ccircle cx='25' cy='7' r='7' fill='%230B1120'/%3E%3Ccircle cx='25' cy='7' r='4.5' fill='%23fff'/%3E%3C/svg%3E";

function porLer() {
  let total = 0;
  for (const s of vivas.values()) total += s.novas || 0;
  return total;
}

function actualizarAba() {
  const n = porLer();
  document.title = n > 0 ? `(${n}) Sala` : "Sala";
  const icone = document.querySelector("link[rel='icon']");
  if (icone) icone.href = n > 0 ? ICONE_AVISO : ICONE_BASE;
}

/* Se a aba estiver escondida, também a conversa aberta acumula por ler. */
const abaEscondida = () => document.visibilityState === "hidden";

document.addEventListener("visibilitychange", () => {
  if (abaEscondida() || !activa) return;
  const s = vivas.get(activa);
  if (s?.novas) { s.novas = 0; desenharLista(); }
  actualizarAba();
  avisarQueVi(activa);
});

function desenharVida() {
  const s = vivas.get(activa);
  const barra = $("vida-barra");
  const caixa = $("vida");
  if (!s || !s.expira) { barra.style.width = "0%"; return; }
  const total = s.expira - (s.criada || s.expira - 86400000);
  const resta = Math.max(0, s.expira - Date.now());
  const parte = total > 0 ? Math.min(1, resta / total) : 0;
  barra.style.width = (parte * 100).toFixed(2) + "%";
  caixa.classList.toggle("fim", resta < 3600000);
  caixa.title = `Esta conversa desaparece em ${restante(s.expira)}`;
}

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
    p.textContent = "Sem conversas. Gera um link para começar.";
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
    n.textContent = sala.para || "A aguardar convidado";
    const sub = document.createElement("p");
    sub.className = "item-sub";
    sub.textContent = morta ? "Terminada" : `Expira em ${restante(sala.expira)}`;
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
    acao.innerHTML = morta
      ? '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>'
      : '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M6.5 9.5a2.5 2.5 0 003.5 0l2-2a2.5 2.5 0 10-3.5-3.5l-.7.7M9.5 6.5a2.5 2.5 0 00-3.5 0l-2 2a2.5 2.5 0 103.5 3.5l.7-.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>';
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

  socket.on("alterada", async ({ code, id, ct, editada }) => {
    const s = vivas.get(code);
    if (!s) return;
    const item = s.msgs.find((m) => m.id === id);
    if (!item) return;
    try {
      const claro = await decifrar(ct, s.chave);
      item.txt = String(claro.txt || "");
      item.resp = claro.resp || null;
      item.ilegivel = false;
    } catch { item.ilegivel = true; }
    item.editada = editada;
    if (code === activa) desenharConversa();
  });

  socket.on("removida", ({ code, id }) => {
    const s = vivas.get(code);
    if (!s) return;
    const item = s.msgs.find((m) => m.id === id);
    if (!item) return;
    item.apagada = Date.now();
    item.txt = "";
    if (code === activa) desenharConversa();
  });

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
    if (r.criadaEm) s.criada = r.criadaEm;
    if (code === activa) desenharVida();
    const jaTinha = s.iniciada;
    s.iniciada = true;
    s.msgs = [];
    for (const m of r.historico) await receber(code, m, true);
    if (code === activa) { desenharConversa(); avisarQueVi(code); }
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

  if (claro?.tipo === "vista") {
    if (claro.n !== nome) {
      s.visto = Math.max(s.visto || 0, Number(claro.ate) || 0);
      if (code === activa) marcarVistas(s);
    }
    return;
  }

  const item = {
    id: msg.id, t: msg.t,
    autor: claro ? String(claro.n || "?").slice(0, 20) : "—",
    txt: claro ? String(claro.txt || "") : "",
    tipo: claro?.tipo || "",
    ilegivel: !claro,
    editada: msg.editada || 0,
    apagada: msg.apagada || 0,
    resp: claro?.resp || null,
  };
  s.msgs.push(item);
  if (s.msgs.length > 300) s.msgs.shift();

  if (item.tipo === "entrada" && item.autor !== nome) {
    if (!s.para) { s.para = item.autor; etiquetar(code, item.autor); desenharLista(); }
    if (code === activa) desenharCabecalho();
    if (!doHistorico) som.entrou();
  }

  const nova = !doHistorico && item.autor !== nome && item.tipo !== "entrada";

  if (code === activa) {
    pintar(item, s);
    if (nova) {
      avisarQueVi(code);
      som.recebida();
      if (abaEscondida()) { s.novas = (s.novas || 0) + 1; actualizarAba(); }
    }
  } else if (nova) {
    s.novas = (s.novas || 0) + 1;
    som.recebida();
    desenharLista();
    actualizarAba();
  }
}

/* ---------- Confirmação de leitura ---------- */
/* Vai cifrada como qualquer mensagem: o servidor não sabe quem leu o quê. */

async function avisarQueVi(code) {
  const s = vivas.get(code);
  if (!s || !socket?.connected || abaEscondida()) return;
  const ultima = [...s.msgs].reverse().find((m) => m.autor !== nome && m.tipo !== "entrada");
  if (!ultima || (s.avisado || 0) >= ultima.t) return;
  s.avisado = ultima.t;
  try {
    socket.emit("mensagem", { code, ct: await cifrar({ n: nome, tipo: "vista", ate: ultima.t }, s.chave) });
  } catch {}
}

function marcarVistas(s) {
  const ate = s.visto || 0;
  let ultimaVista = null;
  document.querySelectorAll("#mensagens .msg.minha").forEach((el) => {
    const visto = Number(el.dataset.t) <= ate;
    el.classList.toggle("vista", visto);
    el.classList.remove("ultima-vista");
    if (visto) ultimaVista = el;
  });
  if (ultimaVista) ultimaVista.classList.add("ultima-vista");
}

/* ---------- Responder a uma mensagem ---------- */
/* A citação viaja cifrada dentro da própria mensagem: o servidor não a vê. */

let aResponder = null;   // { id, autor, txt }

function comecarResposta(item) {
  if (item.apagada) return;
  aResponder = {
    id: item.id,
    autor: item.autor,
    txt: (item.txt || "").slice(0, 140),
  };
  $("resp-autor").textContent = item.autor === nome ? "Tu" : item.autor;
  $("resp-texto").textContent = aResponder.txt;
  $("resposta").classList.remove("oculto");
  $("texto").focus();
}

function cancelarResposta() {
  aResponder = null;
  $("resposta").classList.add("oculto");
}

function irParaMensagem(id) {
  const alvo = document.querySelector(`#mensagens .msg[data-id="${CSS.escape(id)}"]`);
  if (!alvo) return;
  alvo.scrollIntoView({ behavior: "smooth", block: "center" });
  alvo.classList.remove("realce");
  void alvo.offsetWidth;
  alvo.classList.add("realce");
  setTimeout(() => alvo.classList.remove("realce"), 1600);
}

escutar("resp-fechar", "click", cancelarResposta);

/* ---------- Editar e apagar (janela de 20 minutos) ---------- */
/* O servidor impõe o mesmo limite: esconder o botão não chegaria. */

const JANELA_EDICAO = 20 * 60 * 1000;
let aEditar = null;   // { code, id }

const podeMexer = (item) => !item.apagada && Date.now() - item.t <= JANELA_EDICAO;

function fecharAcoes() {
  document.querySelectorAll(".acoes-msg").forEach((el) => el.remove());
  document.querySelectorAll(".msg.a-tocar").forEach((el) => el.classList.remove("a-tocar"));
}

function abrirAcoes(div, item, completo) {
  fecharAcoes();
  const cx = document.createElement("div");
  cx.className = "acoes-msg";

  const opcao = (texto, classe, accao) => {
    const b = document.createElement("button");
    b.textContent = texto;
    if (classe) b.className = classe;
    b.addEventListener("click", (e) => { e.stopPropagation(); fecharAcoes(); accao(); });
    return b;
  };

  const minha = item.autor === nome && !item.ilegivel;
  if (completo) cx.append(opcao("Responder", "", () => comecarResposta(item)));
  if (minha && podeMexer(item)) {
    cx.append(opcao("Editar", "", () => comecarEdicao(item)));
    cx.append(opcao("Apagar", "perigo", () => apagarMensagem(item)));
  }
  if (completo) cx.append(opcao("Cancelar", "", () => {}));
  if (!cx.children.length) return;

  div.append(cx);
  div.classList.add("a-tocar");
  setTimeout(() => div.classList.remove("a-tocar"), 2500);
}

function comecarEdicao(item) {
  if (!podeMexer(item)) return avisar("Já passaram os 20 minutos");
  cancelarResposta();
  aEditar = { code: activa, id: item.id, resp: item.resp || null };
  $("texto").value = item.txt;
  $("texto").focus();
  $("texto").style.height = "auto";
  $("texto").style.height = Math.min($("texto").scrollHeight, 140) + "px";
  $("v-sala").classList.add("a-editar");
}

function cancelarEdicao() {
  aEditar = null;
  $("texto").value = "";
  $("texto").style.height = "auto";
  $("v-sala").classList.remove("a-editar");
}

async function guardarEdicao() {
  const txt = $("texto").value.trim();
  const s = vivas.get(aEditar.code);
  if (!s || !socket?.connected) return;
  if (!txt) { cancelarEdicao(); return; }
  const alvo = aEditar;
  cancelarEdicao();
  const corpo = { n: nome, txt };
  if (alvo.resp) corpo.resp = alvo.resp;
  try {
    socket.emit("alterar", { code: alvo.code, id: alvo.id, ct: await cifrar(corpo, s.chave) },
      (r) => { if (!r?.ok) avisar(r?.erro || "Não foi possível editar."); });
  } catch { avisar("Não foi possível editar."); }
}

function apagarMensagem(item) {
  if (!podeMexer(item)) return avisar("Já passaram os 20 minutos");
  if (!confirm("Apagar esta mensagem para as duas partes?")) return;
  socket?.emit("remover", { code: activa, id: item.id },
    (r) => { if (!r?.ok) avisar(r?.erro || "Não foi possível apagar."); });
}

document.addEventListener("click", fecharAcoes);

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
  div.dataset.id = item.id;
  const minha = !item.ilegivel && item.autor === nome;
  if (item.apagada) div.classList.add("apagada");
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
    balao.append(a);
  }
  if (item.resp && !item.apagada) {
    const cit = document.createElement("button");
    cit.className = "citacao";
    const quem = document.createElement("span");
    quem.className = "citacao-autor";
    quem.textContent = item.resp.autor === nome ? "Tu" : item.resp.autor;
    const txt = document.createElement("span");
    txt.className = "citacao-texto";
    txt.textContent = item.resp.txt;
    cit.append(quem, txt);
    cit.addEventListener("click", (e) => { e.stopPropagation(); irParaMensagem(item.resp.id); });
    balao.append(cit);
  }

  const p = document.createElement("p");
  p.className = "corpo";
  p.textContent = item.apagada
    ? "Mensagem apagada"
    : item.ilegivel
      ? "mensagem cifrada com outra chave"
      : item.txt;
  const h = document.createElement("span");
  h.className = "hora";
  h.textContent = horas(item.t);
  if (item.editada && !item.apagada) {
    const e = document.createElement("span");
    e.className = "editada";
    e.textContent = "editada";
    h.prepend(e);
  }
  if (minha && !item.apagada) {
    const v = document.createElement("span");
    v.className = "visto-marca";
    v.setAttribute("aria-label", "Vista");
    v.innerHTML =
      '<svg viewBox="0 0 16 11" width="13" height="9" aria-hidden="true">' +
      '<path d="M1 6l3.2 3.2L9.5 2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M6.4 6.9l1.3 1.3L13 2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>";
    h.append(v);
  }
  balao.append(p, h);
  div.append(balao);
  div.dataset.t = item.t;

  if (!item.apagada) {
    let temporizador = null, moveu = false;
    const cancelar = () => { clearTimeout(temporizador); temporizador = null; };
    div.addEventListener("touchstart", () => {
      moveu = false;
      temporizador = setTimeout(() => {
        if (moveu) return;
        podeVibrar(14);
        abrirAcoes(div, item, true);
      }, 480);
    }, { passive: true });
    div.addEventListener("touchmove", () => { moveu = true; cancelar(); }, { passive: true });
    div.addEventListener("touchend", cancelar);
    div.addEventListener("touchcancel", cancelar);
    div.addEventListener("contextmenu", (e) => {
      if (window.matchMedia("(pointer: coarse)").matches) e.preventDefault();
    });
  }

  if (!item.apagada) {
    const br = document.createElement("button");
    br.className = "responder";
    br.setAttribute("aria-label", "Responder");
    br.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M7 4L3 8l4 4M3.4 8H10a3 3 0 013 3v1.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    br.addEventListener("click", (e) => { e.stopPropagation(); comecarResposta(item); });
    div.append(br);
  }

  if (minha && !item.apagada) {
    const b = document.createElement("button");
    b.className = "abrir-acoes";
    b.setAttribute("aria-label", "Opções da mensagem");
    b.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="3.5" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="12.5" r="1.3" fill="currentColor"/></svg>';
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!podeMexer(item)) return avisar("Já passaram os 20 minutos");
      abrirAcoes(div, item, false);
    });
    div.append(b);
  }

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
  marcarVistas(s);
  $("fim").scrollIntoView({ block: "end" });
}

function desenharCabecalho() {
  const s = vivas.get(activa);
  const outro = s?.para || "";
  $("titulo-sala").textContent = outro || "A aguardar convidado";
  $("avatar-sala").textContent = outro ? inicial(outro) : "·";
  $("avatar-sala").style.background = corDe(outro || activa);
}

function actualizarSub() {
  const s = vivas.get(activa);
  if (!s) return;
  const p = s.pessoas === undefined ? "" : s.pessoas <= 1 ? "Só tu · " : "2 online · ";
  $("conta").textContent = `${p}expira em ${restante(s.expira)}`;
}

async function abrirConversa(code) {
  if (!vivas.has(code)) {
    const g = lerArquivo().find((x) => x.code === code && Date.now() < x.expira);
    if (g) {
      try {
        vivas.set(code, {
          chave: await importarChave(g.k), k: g.k, para: g.para || "",
          criada: g.criada, expira: g.expira, msgs: [], novas: 0, dono: !!g.dono,
        });
        entrarNaConversa(code);
      } catch {}
    }
  }
  const s = vivas.get(code);
  if (!s) { avisar("Não foi possível abrir esta conversa"); mostrarAlgo(); return; }
  if (aEditar && aEditar.code !== code) cancelarEdicao();
  if (activa !== code) cancelarResposta();
  activa = code;
  s.novas = 0;
  actualizarAba();
  $("texto").disabled = false;
  $("b-enviar").disabled = false;
  erro("e-sala", "");
  mostrar("v-app");
  abrirPalco(true);
  desenharCabecalho();
  actualizarSub();
  desenharVida();
  desenharConversa();
  avisarQueVi(code);
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
  if (aEditar) return guardarEdicao();
  const txt = $("texto").value.trim();
  const s = vivas.get(activa);
  if (!txt || !s) return;
  if (!socket?.connected) return erro("e-sala", "Sem ligação. Espera um instante.");
  $("texto").value = "";
  $("texto").style.height = "auto";
  som.enviada();
  const corpo = { n: nome, txt };
  if (aResponder) corpo.resp = aResponder;
  cancelarResposta();
  try {
    socket.emit("mensagem", { code: activa, ct: await cifrar(corpo, s.chave) },
      (r) => erro("e-sala", r?.ok ? "" : r?.erro));
  } catch {
    erro("e-sala", "Não foi possível enviar.");
  }
}

escutar("b-enviar", "click", enviar);
escutar("texto", "keydown", (e) => {
  if (e.key === "Escape" && aEditar) { e.preventDefault(); cancelarEdicao(); return; }
  if (e.key === "Escape" && aResponder) { e.preventDefault(); cancelarResposta(); return; }
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
  $("b-criar").textContent = "A gerar…";
  try {
    nome = n; guardarNome(n);
    const chave = await gerarChave();
    const k = await exportarChave(chave);
    const r = await fetch("/api/salas", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-dono": lerChaveDono() },
      body: JSON.stringify({ ttl, limite: 2, anfitriao: await cifrar({ nome: n }, chave) }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro);

    vivas.set(d.code, { chave, k, para: "", criada: d.criadaEm, expira: d.expiraEm, msgs: [], novas: 0, dono: true });
    guardarSala({ code: d.code, k, para: "", criada: d.criadaEm, expira: d.expiraEm, dono: true });
    entrarNaConversa(d.code);

    convite = d.code;
    $("cod-convite").textContent = d.code;
    $("link-sala").textContent = linkDe(d.code);
    desenharQR(linkDe(d.code), $("qr"));
    erro("e-criar", "");
    mostrar("v-convite");
  } catch (e) {
    erro("e-criar", e.message || "Não foi possível criar a conversa.");
  } finally {
    $("b-criar").disabled = false;
    $("b-criar").textContent = "Gerar link";
  }
}

escutar("b-criar", "click", criarSala);
escutar("nome-criar", "keydown", (e) => e.key === "Enter" && criarSala());

/* ---------- Código QR ---------- */
/* Gerado aqui dentro, de propósito: o link contém a chave de decifração
   e não pode ser enviado a nenhum serviço externo de QR.
   Codificador mínimo: modo byte, correção L, versões 1 a 6.
   Suficiente para links até 134 caracteres. Sem dependências. */

const CAP = [null, 19, 34, 55, 80, 108, 136];          // codewords de dados por versão
const ECC = [null, 7, 10, 15, 20, 26, 18];              // codewords de correção por bloco
const BLOCOS = [null, 1, 1, 1, 1, 1, 2];                // blocos por versão
const ALINHA = [null, null, 18, 22, 26, 30, 34];        // centro do padrão de alinhamento

/* --- aritmética do campo de Galois --- */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function gerador(grau) {
  let g = [1];
  for (let i = 0; i < grau; i++) {
    const novo = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      novo[j] ^= mul(g[j], 1);
      novo[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = novo;
  }
  return g;
}

function correcao(dados, n) {
  const g = gerador(n);
  const resto = new Array(n).fill(0);
  for (const d of dados) {
    const f = d ^ resto[0];
    resto.shift(); resto.push(0);
    if (f !== 0) for (let i = 0; i < n; i++) resto[i] ^= mul(g[i + 1], f);
  }
  return resto;
}

/* --- construção dos codewords --- */
function codewords(texto) {
  const bytes = new TextEncoder().encode(texto);
  let versao = 0;
  for (let v = 1; v <= 6; v++) if (bytes.length <= CAP[v] - 2) { versao = v; break; }
  if (!versao) throw new Error("Texto demasiado longo para este codificador.");

  const bits = [];
  const juntar = (valor, n) => { for (let i = n - 1; i >= 0; i--) bits.push((valor >> i) & 1); };
  juntar(0b0100, 4);
  juntar(bytes.length, 8);
  for (const b of bytes) juntar(b, 8);

  const totalBits = CAP[versao] * 8;
  for (let i = 0; i < 4 && bits.length < totalBits; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  const dados = [];
  for (let i = 0; i < bits.length; i += 8) {
    dados.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  const enchimento = [0xec, 0x11];
  let i = 0;
  while (dados.length < CAP[versao]) dados.push(enchimento[i++ % 2]);

  // repartir por blocos e intercalar
  const nb = BLOCOS[versao];
  const porBloco = CAP[versao] / nb;
  const blocosDados = [], blocosEcc = [];
  for (let b = 0; b < nb; b++) {
    const parte = dados.slice(b * porBloco, (b + 1) * porBloco);
    blocosDados.push(parte);
    blocosEcc.push(correcao(parte, ECC[versao]));
  }
  const saida = [];
  for (let j = 0; j < porBloco; j++) for (const bl of blocosDados) saida.push(bl[j]);
  for (let j = 0; j < ECC[versao]; j++) for (const bl of blocosEcc) saida.push(bl[j]);
  return { versao, saida };
}

/* --- desenho da matriz --- */
function novaMatriz(n) {
  return { m: Array.from({ length: n }, () => new Array(n).fill(null)), n };
}

function padroes(mz, versao) {
  const { m, n } = mz;
  const finder = (lin, col) => {
    for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
      const y = lin + i, x = col + j;
      if (y < 0 || y >= n || x < 0 || x >= n) continue;
      const borda = i >= 0 && i <= 6 && (j === 0 || j === 6) || j >= 0 && j <= 6 && (i === 0 || i === 6);
      const centro = i >= 2 && i <= 4 && j >= 2 && j <= 4;
      m[y][x] = borda || centro ? 1 : 0;
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);

  for (let i = 8; i < n - 8; i++) { m[6][i] = i % 2 === 0 ? 1 : 0; m[i][6] = i % 2 === 0 ? 1 : 0; }

  if (ALINHA[versao]) {
    const c = ALINHA[versao];
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      m[c + i][c + j] = Math.max(Math.abs(i), Math.abs(j)) !== 1 ? 1 : 0;
    }
  }
  m[n - 8][8] = 1; // módulo sempre escuro
}

function reservarFormato(mz) {
  const { m, n } = mz;
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 2;
    if (m[i][8] === null) m[i][8] = 2;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][n - 1 - i] === null) m[8][n - 1 - i] = 2;
    if (m[n - 1 - i][8] === null) m[n - 1 - i][8] = 2;
  }
}

function colocarDados(mz, cw) {
  const { m, n } = mz;
  const bits = [];
  for (const b of cw) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  let idx = 0, cima = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let passo = 0; passo < n; passo++) {
      const lin = cima ? n - 1 - passo : passo;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (m[lin][c] !== null) continue;
        m[lin][c] = idx < bits.length ? bits[idx] : 0;
        idx++;
      }
    }
    cima = !cima;
  }
}

const MASCARAS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

function penalidade(m, n) {
  let p = 0;
  const linhaP = (get) => {
    for (let i = 0; i < n; i++) {
      let cor = -1, seguidos = 0;
      for (let j = 0; j < n; j++) {
        const v = get(i, j);
        if (v === cor) { seguidos++; if (seguidos === 5) p += 3; else if (seguidos > 5) p++; }
        else { cor = v; seguidos = 1; }
      }
    }
  };
  linhaP((i, j) => m[i][j]);
  linhaP((i, j) => m[j][i]);
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) {
    const v = m[i][j];
    if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) p += 3;
  }
  const alvo = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const procura = (get) => {
    for (let i = 0; i < n; i++) for (let j = 0; j + 11 <= n; j++) {
      let bate = true;
      for (let k = 0; k < 11; k++) if (get(i, j + k) !== alvo[k]) { bate = false; break; }
      if (bate) p += 40;
      bate = true;
      for (let k = 0; k < 11; k++) if (get(i, j + k) !== alvo[10 - k]) { bate = false; break; }
      if (bate) p += 40;
    }
  };
  procura((i, j) => m[i][j]);
  procura((i, j) => m[j][i]);
  let escuros = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) escuros += m[i][j];
  p += Math.floor(Math.abs((escuros * 100) / (n * n) - 50) / 5) * 10;
  return p;
}

function bitsFormato(mascara) {
  let dados = (0b01 << 3) | mascara;      // nível L = 01
  let v = dados << 10;
  for (let i = 4; i >= 0; i--) if (v & (1 << (i + 10))) v ^= 0x537 << i;
  return ((dados << 10) | v) ^ 0x5412;
}

function porFormato(m, n, mascara) {
  const f = bitsFormato(mascara) & 0x7fff;
  const bit = (k) => (f >> (14 - k)) & 1;   // k = 0 é o bit mais significativo

  // primeira cópia, junto ao localizador superior esquerdo
  const copia1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  copia1.forEach(([i, j], k) => { m[i][j] = bit(k); });

  // segunda cópia, repartida pelos outros dois cantos
  const copia2 = [];
  for (let i = 1; i <= 7; i++) copia2.push([n - i, 8]);
  for (let c = n - 8; c <= n - 1; c++) copia2.push([8, c]);
  copia2.forEach(([i, j], k) => { m[i][j] = bit(k); });
}

function gerarQR(texto) {
  const { versao, saida } = codewords(texto);
  const n = versao * 4 + 17;
  const base = novaMatriz(n);
  padroes(base, versao);
  reservarFormato(base);
  const reservado = base.m.map((l) => l.map((v) => v !== null));
  colocarDados(base, saida);

  let melhor = null, melhorP = Infinity;
  for (let k = 0; k < 8; k++) {
    const m = base.m.map((l) => l.slice());
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (!reservado[i][j] && MASCARAS[k](i, j)) m[i][j] ^= 1;
    }
    porFormato(m, n, k);
    const p = penalidade(m, n);
    if (p < melhorP) { melhorP = p; melhor = m; }
  }
  return { matriz: melhor, tamanho: n, versao };
}

/* desenha o código como SVG, escalável e sem imagens */
function desenharQR(texto, alvo) {
  try {
    const { matriz, tamanho } = gerarQR(texto);
    const partes = [];
    for (let i = 0; i < tamanho; i++) {
      for (let j = 0; j < tamanho; j++) {
        if (matriz[i][j]) partes.push(`M${j} ${i}h1v1h-1z`);
      }
    }
    alvo.innerHTML =
      `<svg viewBox="0 0 ${tamanho} ${tamanho}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">` +
      `<path d="${partes.join("")}" fill="#0b1120"/></svg>`;
    alvo.classList.remove("oculto");
  } catch (e) {
    alvo.classList.add("oculto");
  }
}

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

    convite = { code, k, chave, criada: d.criadaEm, expira: d.expiraEm, dono };
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

  const { code, k, chave, criada, expira, dono } = convite;
  vivas.set(code, { chave, k, para: dono, criada, expira, msgs: [], novas: 0, dono: false });
  guardarSala({ code, k, para: dono, criada, expira, dono: false });
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
  $("chamada-nome").textContent = emCurso ? outro : `${outro} · chamada`;
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

/* ---------- Espaço fechado ---------- */

function mostrarFechado(msg) {
  mostrar("v-fechado");
  $("form-dono").classList.toggle("oculto", !lerChaveDono() && !msg);
  erro("e-fechado", msg || "");
}

escutar("b-sou-dono", "click", () => {
  $("form-dono").classList.remove("oculto");
  $("chave-dono").focus();
});

async function entrarComoDono() {
  const chave = $("chave-dono").value;
  if (!chave) return erro("e-fechado", "Escreve a palavra-passe.");
  $("b-entrar-dono").disabled = true;
  try {
    const r = await fetch("/api/dono", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chave }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro);
    guardarChaveDono(chave);
    $("chave-dono").value = "";
    erro("e-fechado", "");
    if (lerArquivo().length) { desenharLista(); mostrar("v-app"); abrirPalco(false); }
    else irParaCriar();
  } catch (e) {
    erro("e-fechado", e.message || "Não foi possível confirmar.");
  } finally {
    $("b-entrar-dono").disabled = false;
  }
}

escutar("b-entrar-dono", "click", entrarComoDono);
escutar("chave-dono", "keydown", (e) => e.key === "Enter" && entrarComoDono());

/* ---------- Navegação ---------- */

function irParaCriar() {
  if (espacoFechado && !lerChaveDono()) { mostrarFechado(""); return; }
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

setInterval(() => { if (activa) { actualizarSub(); desenharVida(); } }, 30000);

/* ---------- Arranque ---------- */

function nadaVisivel() {
  return document.querySelectorAll(".ecra:not(.oculto), .app:not(.oculto)").length === 0;
}

function mostrarAlgo() {
  if (!nadaVisivel()) return;
  if (ehConvidado()) {
    mostrarFechado("");
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
        criada: g.criada, expira: g.expira, msgs: [], novas: 0, dono: !!g.dono,
      });
    } catch {}
  }
  if (vivas.size && nome) { garantirSocket(); for (const c of vivas.keys()) entrarNaConversa(c); }
}

async function arrancar() {
  try {
    const est = await (await fetch("/estado")).json();
    espacoFechado = Boolean(est.fechado);
  } catch { espacoFechado = false; }

  const noLink = location.pathname.startsWith("/s/");
  const codeLink = noLink ? (location.pathname.split("/s/")[1] || "").toUpperCase().slice(0, 6) : "";
  const jaTenho = lerArquivo().some((x) => x.code === codeLink);

  await restaurar();

  modoConvidado();

  if (noLink && jaTenho && nome) { desenharLista(); abrirConversa(codeLink); return; }
  if (noLink) { await prepararEntrada(); return; }

  if (ehConvidado()) {
    const minha = primeiraViva();
    if (minha && nome) { desenharLista(); await abrirConversa(minha.code); return; }
    mostrarFechado("");
    return;
  }
  if (lerArquivo().length && nome) { desenharLista(); mostrar("v-app"); abrirPalco(false); return; }
  irParaCriar();
}

arrancar()
  .catch((e) => { console.error(e); mostrarAlgo(); })
  .finally(() => setTimeout(mostrarAlgo, 400));
