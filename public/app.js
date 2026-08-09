/* Sala — cliente.
   A chave AES-GCM vive no fragmento do URL (#k=...). Os browsers nunca enviam
   fragmentos ao servidor, por isso o servidor so ve texto cifrado. */

const $ = (id) => document.getElementById(id);
const ECRAS = ["v-criar", "v-convite", "v-entrada", "v-sala"];
const CORES = ["#8a5a2b", "#2f4a3a", "#7a3f6d", "#2b5c7a", "#8a3b3b", "#4a5a24"];

let chave = null, chaveTexto = "", codigo = "", nome = "", anfitriao = "";
let ttl = "24h", socket = null, expiraEm = 0, jaEntrou = false;
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

const guardarNome = (n) => { try { sessionStorage.setItem("sala:nome", n); } catch {} };
const lerNome = () => { try { return sessionStorage.getItem("sala:nome") || ""; } catch { return ""; } };
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
  const n = $("nome-criar").value.trim();
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
      body: JSON.stringify({ ttl, anfitriao: await cifrar({ nome: n }) }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro);

    codigo = d.code; expiraEm = d.expiraEm;
    $("cod-convite").textContent = codigo;
    $("link-sala").textContent = linkDaSala();
    history.replaceState(null, "", `/s/${codigo}#k=${chaveTexto}`);
    erro("e-criar", "");
    mostrar("v-convite");
  } catch (e) {
    erro("e-criar", e.message || "Não foi possível abrir a sala.");
  } finally {
    $("b-criar").disabled = false;
    $("b-criar").textContent = "Abrir a minha sala";
  }
}

$("b-criar").addEventListener("click", criarSala);
$("nome-criar").addEventListener("keydown", (e) => e.key === "Enter" && criarSala());

/* ---------- 2. Convite ---------- */

async function partilhar() {
  try {
    await navigator.share({ title: "Sala", text: `Entra na minha sala. O link expira.`, url: linkDaSala() });
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
$("b-partilhar").addEventListener("click", partilhar);
$("b-copiar").addEventListener("click", copiar);
$("b-entrar-minha").addEventListener("click", () => ligar());

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
  $("b-entrar").disabled = true;
  $("b-entrar").textContent = "A ligar…";
  ligar();
}

$("b-entrar").addEventListener("click", entrarPorConvite);
$("nome-entrada").addEventListener("keydown", (e) => e.key === "Enter" && entrarPorConvite());

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
  let autor = "—", corpo = "", ilegivel = false;
  try {
    const claro = await decifrar(msg.ct);
    autor = String(claro.n || "?").slice(0, 20);
    corpo = String(claro.txt || "");
  } catch {
    ilegivel = true;
    corpo = "mensagem cifrada com outra chave";
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
  ultimoAutor = autor;
  ultimoElemento = div;
  aoFundo(true);
}

function actualizarSub(n) {
  const pessoas = n === undefined ? "" : n === 1 ? "só tu · " : `${n} pessoas · `;
  $("conta").textContent = `${pessoas}desaparece daqui a ${restante(expiraEm)}`;
}

function ligar() {
  if (!chave || !codigo) return;
  mostrar("v-sala");
  const titulo = anfitriao ? `Sala do ${anfitriao}` : `Sala ${codigo}`;
  $("titulo-sala").textContent = titulo;
  $("avatar-sala").textContent = inicial(anfitriao || codigo);
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
      if (jaEntrou) sistema("Ligação recuperada.");
      jaEntrou = true;
      actualizarSub();
      aoFundo(false);
    });
  });

  socket.on("mensagem", acrescentar);
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
  try {
    socket.emit("mensagem", { ct: await cifrar({ n: nome, txt }) }, (r) => erro("e-sala", r?.ok ? "" : r?.erro));
  } catch {
    erro("e-sala", "Não foi possível enviar.");
  }
}

$("b-enviar").addEventListener("click", enviar);
$("texto").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); }
});
$("texto").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
});
$("texto").addEventListener("focus", () => setTimeout(() => aoFundo(false), 250));

/* Menu */
const menu = $("menu");
$("b-menu").addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("oculto"); });
document.addEventListener("click", () => menu.classList.add("oculto"));
$("b-convidar").addEventListener("click", () => (navigator.share ? partilhar() : copiar()));
$("b-sair").addEventListener("click", () => { socket?.disconnect(); location.href = "/"; });
$("b-fechar").addEventListener("click", () => {
  if (confirm("Isto apaga a sala para toda a gente. Continuar?")) {
    socket?.emit("fechar");
    setTimeout(() => (location.href = "/"), 400);
  }
});

/* ---------- Arranque ---------- */

if (location.pathname.startsWith("/s/")) prepararEntrada();
else { $("nome-criar").value = lerNome(); mostrar("v-criar"); }
