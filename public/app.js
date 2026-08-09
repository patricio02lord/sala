/* Sala — cliente.
   A chave AES-GCM vive no fragmento do URL (#k=...). Os browsers nunca enviam
   fragmentos ao servidor, por isso o servidor so ve texto cifrado. */

const $ = (id) => document.getElementById(id) || document.createElement("span");
const escutar = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);
const ECRAS = ["v-app", "v-criar", "v-convite", "v-entrada"];
const CORES = ["#5a765f", "#7a6b59", "#5c6b80", "#785f76", "#6b7752", "#82665a"];

let chave = null, chaveTexto = "", codigo = "", nome = "", anfitriao = "";
let ttl = "24h", socket = null, expiraEm = 0, jaEntrou = false, para = "";
let ultimoAutor = null, ultimoElemento = null;

/* ---------- Utilidades ---------- */

const mostrar = (id) => ECRAS.forEach((e) => $(e).classList.toggle("oculto", e !== id));
const erro = (id, txt) => ($(id).textContent = txt || "");
const inicial = (n) => (n || "?").trim().charAt(0).toUpperCase() || "?";
const horas = (t) => new Date(t).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });

function corDe(nomeAutor) {
  let h = 0;
  for (let i = 0; i < nomeAutor.length; i++) h = (h * 31 + nomeAutor.charCodeAt(i)) >>> 0;
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
  avisoTimer = setTimeout(() => el.classList.add("oculto"), 2200);
}

const guardarNome = (n) => { try { localStorage.setItem("sala:nome", n); } catch {} };
const lerNome = () => { try { return localStorage.getItem("sala:nome") || ""; } catch { return ""; } };
const linkDaSala = () => `${location.origin}/s/${codigo}#k=${chaveTexto}`;

/* Altura real com o teclado do telemovel aberto */
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

async function cifrar(objeto) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, chave,
    new TextEncoder().encode(JSON.stringify(objeto)));
  const junto = new Uint8Array(iv.length + ct.byteLength);
  junto.set(iv); junto.set(new Uint8Array(ct), iv.length);
  return b64u.para(junto);
}

async function decifrar(texto) {
  const b = b64u.de(texto);
  const claro = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, chave, b.slice(12));
  return JSON.parse(new TextDecoder().decode(claro));
}

/* ---------- Arquivo local das minhas salas ---------- */

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

function desenharLista() {
  const v = lerArquivo();
  const alvo = $("lista");
  alvo.textContent = "";
  $("meu-nome").textContent = lerNome() || "sem nome";

  if (!v.length) {
    const p = document.createElement("p");
    p.className = "vazio-lista";
    p.textContent = "Ainda não abriste nenhuma conversa. Cria uma e manda o link à pessoa.";
    alvo.append(p);
    return;
  }

  for (const sala of v) {
    const morta = Date.now() > sala.expira;
    const item = document.createElement("div");
    item.className = "item" + (morta ? " morta" : "") + (sala.code === codigo ? " activa" : "");

    const av = document.createElement("div");
    av.className = "item-avatar";
    av.style.background = corDe(sala.para || sala.code);
    av.textContent = inicial(sala.para || sala.code);

    const txt = document.createElement("button");
    txt.className = "item-texto";
    txt.style.background = "none";
    txt.style.border = "none";
    txt.style.padding = "0";
    const n = document.createElement("p");
    n.className = "item-nome";
    n.textContent = sala.para || "À espera de alguém";
    const sub = document.createElement("p");
    sub.className = "item-sub";
    sub.textContent = morta
      ? "terminada"
      : (sala.para ? "" : `${sala.code} · `) + `termina daqui a ${restante(sala.expira)}`;
    txt.append(n, sub);
    txt.addEventListener("click", () => (morta ? null : abrirGuardada(sala)));

    const acao = document.createElement("button");
    acao.className = "item-acao";
    acao.setAttribute("aria-label", morta ? "Esquecer" : "Copiar link");
    acao.textContent = morta ? "\u00d7" : "\u29c9";
    acao.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (morta) {
        esquecerSala(sala.code);
        desenharLista();
        return;
      }
      codigo = sala.code; chaveTexto = sala.k;
      if (navigator.share) { await partilhar(); } else { await copiar(); }
    });

    item.append(av, txt, acao);
    alvo.append(item);
  }
}

async function abrirGuardada(sala) {
  if (!sala) return;
  if (codigo && codigo !== sala.code) largarSala();
  else if (codigo === sala.code) { abrirPalco(true); return; }
  codigo = sala.code;
  chaveTexto = sala.k;
  para = sala.para || "";
  nome = lerNome() || "Eu";
  try { chave = await importarChave(chaveTexto); } catch { return avisar("Chave inválida"); }
  try {
    const r = await fetch(`/api/salas/${codigo}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro);
    expiraEm = d.expiraEm;
  } catch (e) {
    avisar(e.message || "Esta conversa já não existe");
    esquecerSala(codigo);
    desenharLista();
    return;
  }
  anfitriao = para;
  history.replaceState(null, "", `/s/${codigo}#k=${chaveTexto}`);
  ligar();
  desenharLista();
}

/* ---------- 1. Criar ---------- */

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
  $("b-criar").textContent = "A abrir…";
  try {
    chave = await gerarChave();
    chaveTexto = await exportarChave(chave);
    nome = n; anfitriao = n; guardarNome(n);

    const r = await fetch("/api/salas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttl, limite: 2, anfitriao: await cifrar({ nome: n }) }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro);

    codigo = d.code; expiraEm = d.expiraEm; para = "";
    guardarSala({ code: codigo, k: chaveTexto, para: "", expira: expiraEm });
    $("cod-convite").textContent = codigo;
    $("link-sala").textContent = linkDaSala();
    history.replaceState(null, "", `/s/${codigo}#k=${chaveTexto}`);
    erro("e-criar", "");
    mostrar("v-convite");
  } catch (e) {
    erro("e-criar", e.message || "Não foi possível abrir a sala.");
  } finally {
    $("b-criar").disabled = false;
    $("b-criar").textContent = "Criar a conversa";
  }
}

escutar("b-criar", "click", criarSala);
escutar("nome-criar", "keydown", (e) => e.key === "Enter" && criarSala());

/* ---------- 2. Convite ---------- */

async function partilhar() {
  try {
    await navigator.share({ title: "Sala", text: "Conversa privada. Este link expira.", url: linkDaSala() });
  } catch {}
}

async function copiar() {
  try {
    await navigator.clipboard.writeText(linkDaSala());
    avisar("Link copiado");
  } catch {
    const sel = window.getSelection(), r = document.createRange();
    r.selectNodeContents($("link-sala"));
    sel.removeAllRanges(); sel.addRange(r);
    avisar("Copia o link selecionado");
  }
}

if (navigator.share) $("b-partilhar").classList.remove("oculto");
escutar("b-partilhar", "click", partilhar);
escutar("b-copiar", "click", copiar);
escutar("b-entrar-minha", "click", () => ligar());

/* ---------- 3. Boas-vindas ---------- */

async function prepararEntrada() {
  codigo = (location.pathname.split("/s/")[1] || "").toUpperCase().slice(0, 6);
  chaveTexto = new URLSearchParams(location.hash.slice(1)).get("k") || "";
  mostrar("v-entrada");

  if (!codigo || !chaveTexto) {
    $("titulo-entrada").textContent = "Link incompleto";
    $("info-entrada").textContent =
      "Falta a parte depois do #. Pede à pessoa que te convidou para reenviar o link inteiro.";
    return;
  }

  try {
    chave = await importarChave(chaveTexto);
  } catch {
    $("titulo-entrada").textContent = "Chave inválida";
    $("info-entrada").textContent = "Este link está danificado.";
    return;
  }

  try {
    const r = await fetch(`/api/salas/${codigo}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro);
    expiraEm = d.expiraEm;

    if (d.anfitriao) {
      try { anfitriao = (await decifrar(d.anfitriao)).nome || ""; } catch {}
    }

    $("avatar-anfitriao").textContent = inicial(anfitriao || codigo);
    $("titulo-entrada").textContent = anfitriao
      ? `Bem-vindo à sala do ${anfitriao}`
      : `Bem-vindo à sala ${codigo}`;
    $("info-entrada").textContent = `A conversa desaparece daqui a ${restante(expiraEm)}. Escreve o teu nome para entrar.`;
    $("nome-entrada").value = lerNome();
    $("form-entrada").classList.remove("oculto");
  } catch (e) {
    $("titulo-entrada").textContent = "Sala fechada";
    $("info-entrada").textContent = e.message || "Não foi possível confirmar esta sala.";
  }
}

function entrarPorConvite() {
  const n = $("nome-entrada").value.trim();
  if (!n) return erro("e-entrada", "Escreve o teu nome para continuar.");
  nome = n; guardarNome(n); erro("e-entrada", "");
  para = anfitriao;
  guardarSala({ code: codigo, k: chaveTexto, para: anfitriao, expira: expiraEm });
  $("b-entrar").disabled = true;
  $("b-entrar").textContent = "A ligar…";
  ligar();
}

escutar("b-entrar", "click", entrarPorConvite);
escutar("nome-entrada", "keydown", (e) => e.key === "Enter" && entrarPorConvite());

/* ---------- 4. Sala ---------- */

function aoFundo(suave) {
  $("fim").scrollIntoView({ behavior: suave ? "smooth" : "auto", block: "end" });
}

function sistema(txt) {
  const p = document.createElement("p");
  p.className = "sistema";
  p.textContent = txt;
  $("mensagens").append(p);
  ultimoAutor = null;
  aoFundo(true);
}

async function acrescentar(msg) {
  const div = document.createElement("div");
  div.className = "msg";
  let autor = "—", corpo = "", ilegivel = false, claroTipo = "";
  try {
    const claro = await decifrar(msg.ct);
    autor = String(claro.n || "?").slice(0, 20);
    corpo = String(claro.txt || "");
    claroTipo = claro.tipo || "";
  } catch {
    ilegivel = true;
    corpo = "mensagem cifrada com outra chave";
  }

  if (!ilegivel && claroTipo === "entrada") {
    if (autor !== nome) {
      if (!para) { para = autor; etiquetar(codigo, autor); }
      desenharCabecalho();
    }
    sistema(`${autor} entrou.`);
    if (autor !== nome) som.entrou();
    return;
  }

  const minha = !ilegivel && autor === nome;
  if (minha) div.classList.add("minha");
  if (ilegivel) div.classList.add("ilegivel");

  const novoGrupo = autor !== ultimoAutor;
  if (novoGrupo) div.classList.add("inicio-grupo");
  else if (ultimoElemento) ultimoElemento.classList.remove("fim-grupo");
  div.classList.add("fim-grupo");

  const balao = document.createElement("div");
  balao.className = "balao";
  if (novoGrupo && !minha) {
    const a = document.createElement("span");
    a.className = "autor";
    a.textContent = autor;
    a.style.color = corDe(autor);
    balao.append(a);
  }
  const p = document.createElement("p");
  p.className = "corpo";
  p.textContent = corpo;
  const h = document.createElement("span");
  h.className = "hora";
  h.textContent = horas(msg.t);
  balao.append(p, h);
  div.append(balao);
  div.dataset.t = msg.t;

  $("mensagens").append(div);
  if (!ilegivel && jaEntrou && !minha) som.recebida();
  ultimoAutor = autor;
  ultimoElemento = div;
  aoFundo(true);
}

function abrirPalco(aberta) {
  $("v-app").classList.toggle("com-sala", aberta);
  $("v-sala").classList.toggle("oculto", !aberta);
  $("v-nada").classList.toggle("oculto", aberta);
}

function largarSala() {
  limparChamada();
  socket?.removeAllListeners?.();
  socket?.disconnect();
  socket = null;
  jaEntrou = false;
  ultimoAutor = null;
  ultimoElemento = null;
  $("mensagens").textContent = "";
  $("texto").value = "";
  $("texto").disabled = false;
  $("b-enviar").disabled = false;
  erro("e-sala", "");
  codigo = ""; chave = null; chaveTexto = "";
  para = ""; anfitriao = ""; expiraEm = 0;
  history.replaceState(null, "", "/");
}

function desenharCabecalho() {
  const outro = para || anfitriao;
  $("titulo-sala").textContent = outro ? `Conversa com ${outro}` : "À espera de alguém";
  $("avatar-sala").textContent = outro ? inicial(outro) : "·";
  $("avatar-sala").style.background = corDe(outro || codigo);
}

function actualizarSub(n) {
  const pessoas = n === undefined ? "" : n === 1 ? "só tu · " : `${n} pessoas · `;
  $("conta").textContent = `${pessoas}desaparece daqui a ${restante(expiraEm)}`;
}

function ligar() {
  if (!chave || !codigo) return;
  mostrar("v-app");
  abrirPalco(true);
  desenharCabecalho();
  actualizarSub();
  ajustarAltura();

  if (socket) return;
  socket = io({ transports: ["websocket", "polling"] });

  socket.on("connect", () => {
    socket.emit("entrar", { code: codigo }, async (r) => {
      if (!r?.ok) {
        socket.disconnect(); socket = null;
        mostrar("v-entrada");
        $("form-entrada").classList.add("oculto");
        $("titulo-entrada").textContent = "Sala fechada";
        $("info-entrada").textContent = r?.erro || "Não foi possível entrar.";
        $("b-entrar").disabled = false;
        $("b-entrar").textContent = "Entrar na conversa";
        return;
      }
      expiraEm = r.expiraEm;
      $("mensagens").textContent = "";
      ultimoAutor = null; ultimoElemento = null;
      for (const m of r.historico) await acrescentar(m);
      if (jaEntrou) {
        sistema("Ligação recuperada.");
      } else {
        jaEntrou = true;
        try {
          socket.emit("mensagem", { ct: await cifrar({ n: nome, tipo: "entrada" }) });
        } catch {}
      }
      actualizarSub();
      aoFundo(false);
    });
  });

  socket.on("mensagem", acrescentar);
  socket.on("sinal", receberSinal);
  socket.on("saiu", () => { if (estadoChamada !== "parado") terminar("A pessoa saiu."); });
  socket.on("presenca", ({ n }) => actualizarSub(n));
  socket.on("sala:fechada", ({ motivo }) => {
    sistema(motivo);
    $("texto").disabled = true;
    $("b-enviar").disabled = true;
  });
  socket.on("disconnect", () => ($("conta").textContent = "sem ligação · a tentar voltar"));

  setInterval(() => {
    const agora = Date.now();
    document.querySelectorAll(".msg").forEach((m) => {
      const vida = expiraEm - Number(m.dataset.t);
      if (vida > 0) m.style.opacity = String(Math.max(0.45, 1 - ((agora - Number(m.dataset.t)) / vida) * 0.55));
    });
    actualizarSub();
  }, 30000);
}

async function enviar() {
  const txt = $("texto").value.trim();
  if (!txt) return;
  if (!socket?.connected) return erro("e-sala", "Sem ligação. Espera um instante.");
  $("texto").value = "";
  $("texto").style.height = "auto";
  som.enviada();
  try {
    socket.emit("mensagem", { ct: await cifrar({ n: nome, txt }) }, (r) => erro("e-sala", r?.ok ? "" : r?.erro));
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
escutar("texto", "focus", () => setTimeout(() => aoFundo(false), 250));

/* Menu */
const menu = $("menu");
escutar("b-menu", "click", (e) => { e.stopPropagation(); menu.classList.toggle("oculto"); });
document.addEventListener("click", () => menu.classList.add("oculto"));
escutar("b-convidar", "click", () => (navigator.share ? partilhar() : copiar()));
escutar("b-sair", "click", irParaLista);
escutar("b-voltar-lista", "click", voltarAoPainel);

escutar("b-fechar", "click", () => {
  if (!confirm("Isto apaga a conversa para toda a gente. Continuar?")) return;
  const alvo = codigo;
  socket?.emit("fechar");
  setTimeout(() => { esquecerSala(alvo); irParaLista(); }, 350);
});

/* ---------- Som ---------- */
/* Tons gerados no proprio browser: sem ficheiros, sem descargas, sem bibliotecas. */

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
  const osc = ac.createOscillator();
  const g = ac.createGain();
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
  if (tipo === "entrada") {
    const padrao = () => {
      tom(700, 0.22, 0.075);
      tom(940, 0.26, 0.07, 0.24);
      podeVibrar([250, 180, 250]);
    };
    padrao();
    tocando = setInterval(padrao, 2400);
  } else {
    const padrao = () => { tom(430, 0.32, 0.035); };
    padrao();
    tocando = setInterval(padrao, 2600);
  }
}

function pararToque() {
  clearInterval(tocando);
  tocando = null;
  podeVibrar(0);
}

/* toque discreto em qualquer botao */
document.addEventListener("pointerdown", (e) => {
  if (e.target.closest("button")) { som.toque(); podeVibrar(8); }
}, { passive: true });

/* ---------- Chamada (WebRTC ponto a ponto) ---------- */
/* O audio vai directamente de um browser para o outro. A sinalizacao passa pelo
   servidor mas vai cifrada com a chave da sala, por isso ele nao a consegue ler.
   Para redes mais fechadas seria preciso um servidor TURN; ver nota no fim. */

const ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // { urls: "turn:...", username: "...", credential: "..." },
];

let pc = null, streamLocal = null, estadoChamada = "parado";
let pendentes = [], relogio = null, inicioChamada = 0, silenciado = false, ofertaGuardada = null;

function ecraChamada(estado, texto) {
  const outro = para || anfitriao || "alguém";
  $("chamada").classList.toggle("oculto", estado === "parado");
  $("chamada").classList.toggle("a-tocar", estado === "a-tocar" || estado === "a-chamar");
  $("chamada-avatar").textContent = inicial(outro);
  $("chamada-avatar").style.background = corDe(outro || codigo);
  $("chamada-nome").textContent = outro;
  $("chamada-estado").textContent = texto || "";
  $("b-atender").classList.toggle("oculto", estado !== "a-tocar");
  $("b-silencio").classList.toggle("oculto", estado !== "em-curso");
}

function contarTempo() {
  clearInterval(relogio);
  inicioChamada = Date.now();
  const passo = () => {
    const s = Math.floor((Date.now() - inicioChamada) / 1000);
    $("chamada-estado").textContent =
      `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  passo();
  relogio = setInterval(passo, 1000);
}

async function enviarSinal(objeto) {
  if (!socket?.connected) return;
  try { socket.emit("sinal", { ct: await cifrar(objeto) }); } catch {}
}

async function criarLigacao() {
  pc = new RTCPeerConnection({ iceServers: ICE });
  pc.onicecandidate = (e) => { if (e.candidate) enviarSinal({ tipo: "ice", cand: e.candidate }); };
  pc.ontrack = (e) => { $("audio-remoto").srcObject = e.streams[0]; };
  pc.onconnectionstatechange = () => {
    if (pc?.connectionState === "connected" && estadoChamada !== "em-curso") {
      estadoChamada = "em-curso";
      pararToque();
      som.atendida();
      ecraChamada("em-curso", "");
      contarTempo();
    }
    if (["failed", "disconnected"].includes(pc?.connectionState) && estadoChamada === "em-curso") {
      terminar("A ligação caiu.");
    }
  };
  streamLocal = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  streamLocal.getTracks().forEach((t) => pc.addTrack(t, streamLocal));
}

async function ligarPara() {
  if (estadoChamada !== "parado") return;
  if (!socket?.connected) return avisar("Sem ligação");
  try {
    estadoChamada = "a-chamar";
    ecraChamada("a-chamar", "A chamar…");
    tocarChamada("saida");
    await criarLigacao();
    const oferta = await pc.createOffer();
    await pc.setLocalDescription(oferta);
    await enviarSinal({ tipo: "oferta", sdp: pc.localDescription });
  } catch (e) {
    terminar(e.name === "NotAllowedError" ? "Precisas de dar acesso ao microfone." : "Não foi possível ligar.");
  }
}

function limparChamada() {
  pararToque();
  clearInterval(relogio);
  streamLocal?.getTracks().forEach((t) => t.stop());
  streamLocal = null;
  try { pc?.close(); } catch {}
  pc = null;
  pendentes = [];
  silenciado = false;
  $("b-silencio").textContent = "Silenciar";
  $("b-silencio").classList.remove("silenciado");
  $("audio-remoto").srcObject = null;
  estadoChamada = "parado";
  ecraChamada("parado");
}

function terminar(motivo) {
  if (estadoChamada !== "parado") som.desligada();
  const houve = estadoChamada === "em-curso";
  const dur = houve ? Math.floor((Date.now() - inicioChamada) / 1000) : 0;
  limparChamada();
  if (motivo) avisar(motivo);
  if (houve) sistema(`Chamada terminada · ${Math.floor(dur / 60)}m ${dur % 60}s`);
}

function desligar() {
  if (estadoChamada === "parado") return;
  enviarSinal({ tipo: "fim" });
  terminar(null);
}

function alternarSilencio() {
  if (!streamLocal) return;
  silenciado = !silenciado;
  streamLocal.getAudioTracks().forEach((t) => (t.enabled = !silenciado));
  $("b-silencio").textContent = silenciado ? "Ligar o microfone" : "Silenciar";
  $("b-silencio").classList.toggle("silenciado", silenciado);
}

async function receberSinal({ ct }) {
  let sinal;
  try { sinal = await decifrar(ct); } catch { return; }

  if (sinal.tipo === "oferta") {
    if (estadoChamada !== "parado") { await enviarSinal({ tipo: "ocupado" }); return; }
    estadoChamada = "a-tocar";
    pendentes = [];
    pc = null;
    ofertaGuardada = sinal.sdp;
    ecraChamada("a-tocar", "Está a ligar…");
    tocarChamada("entrada");
    return;
  }

  if (sinal.tipo === "resposta" && pc) {
    try { await pc.setRemoteDescription(sinal.sdp); } catch {}
    return;
  }

  if (sinal.tipo === "ice") {
    if (pc?.remoteDescription) { try { await pc.addIceCandidate(sinal.cand); } catch {} }
    else pendentes.push(sinal.cand);
    return;
  }

  if (sinal.tipo === "fim") { terminar(null); return; }
  if (sinal.tipo === "ocupado") { terminar("A pessoa está ocupada."); return; }
}


escutar("b-chamar", "click", ligarPara);
escutar("b-desligar", "click", desligar);
escutar("b-silencio", "click", alternarSilencio);
escutar("b-atender", "click", async () => {
  if (!ofertaGuardada) return;
  estadoChamada = "em-curso";
  const oferta = ofertaGuardada;
  ofertaGuardada = null;
  pararToque();
  try {
    ecraChamada("em-curso", "A ligar…");
    await criarLigacao();
    await pc.setRemoteDescription(oferta);
    for (const c of pendentes) { try { await pc.addIceCandidate(c); } catch {} }
    pendentes = [];
    const resposta = await pc.createAnswer();
    await pc.setLocalDescription(resposta);
    await enviarSinal({ tipo: "resposta", sdp: pc.localDescription });
  } catch (e) {
    await enviarSinal({ tipo: "fim" });
    terminar(e.name === "NotAllowedError" ? "Precisas de dar acesso ao microfone." : "Não foi possível atender.");
  }
});

/* ---------- Navegação ---------- */

function irParaLista() {
  largarSala();
  desenharLista();
  mostrar("v-app");
  abrirPalco(false);
}

function voltarAoPainel() {
  $("v-app").classList.remove("com-sala");
  desenharLista();
}

function irParaCriar() {
  if (codigo) largarSala();
  const meu = lerNome();
  $("campo-eu").classList.toggle("oculto", !!meu);
  $("nome-criar").value = meu;
  $("b-voltar").classList.toggle("oculto", !lerArquivo().length);
  erro("e-criar", "");
  mostrar("v-criar");
  $("nome-criar").focus();
}

escutar("b-nova", "click", irParaCriar);
escutar("b-voltar", "click", irParaLista);
escutar("b-lista", "click", irParaLista);
escutar("b-eu", "click", () => {
  const novo = prompt("O teu nome:", lerNome());
  if (novo && novo.trim()) { guardarNome(novo.trim().slice(0, 20)); desenharLista(); }
});

/* ---------- Arranque ---------- */

window.addEventListener("error", (e) => {
  const alvo = document.getElementById("v-criar");
  if (alvo && document.querySelectorAll(".ecra:not(.oculto), .sala:not(.oculto)").length === 0) {
    alvo.classList.remove("oculto");
    const p = document.getElementById("e-criar");
    if (p) p.textContent = "Algo falhou ao carregar: " + (e.message || "erro desconhecido");
  }
});

try {
  arrancar();
} catch (e) {
  console.error(e);
  document.getElementById("v-criar")?.classList.remove("oculto");
}

function arrancar() {
if (location.pathname.startsWith("/s/")) {
  const meu = location.hash.includes("k=") && lerArquivo().some(
    (x) => x.code === (location.pathname.split("/s/")[1] || "").toUpperCase()
  );
  if (meu) {
    const guardada = lerArquivo().find(
      (x) => x.code === (location.pathname.split("/s/")[1] || "").toUpperCase()
    );
    abrirGuardada(guardada);
  } else {
    prepararEntrada();
  }
} else if (lerArquivo().length) {
  desenharLista();
  mostrar("v-app");
  abrirPalco(false);
} else {
  irParaCriar();
}
}
