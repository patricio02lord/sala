/* Sala — cliente.
   A chave AES-GCM vive no fragmento do URL (#k=...). Os browsers nunca enviam
   fragmentos ao servidor, por isso o servidor so ve texto cifrado. */

const $ = (id) => document.getElementById(id);
const ECRAS = ["v-criar", "v-convite", "v-entrada", "v-sala"];

let chave = null;
let chaveTexto = "";
let codigo = "";
let nome = "";
let ttl = "24h";
let socket = null;
let expiraEm = 0;
let jaEntrou = false;

/* ---------- Utilidades ---------- */

function mostrar(id) {
  ECRAS.forEach((e) => $(e).classList.toggle("oculto", e !== id));
}

const erro = (id, txt) => ($(id).textContent = txt || "");

const horas = (t) =>
  new Date(t).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });

function restante(ate) {
  const s = Math.max(0, ate - Date.now()) / 1000;
  if (s < 60) return "menos de um minuto";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
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

const guardarNome = (n) => {
  try { sessionStorage.setItem("sala:nome", n); } catch {}
};
const lerNome = () => {
  try { return sessionStorage.getItem("sala:nome") || ""; } catch { return ""; }
};

const linkDaSala = () => `${location.origin}/s/${codigo}#k=${chaveTexto}`;

/* ---------- Cifra ---------- */

const b64u = {
  para: (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  de: (s) => {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  },
};

const gerarChave = () =>
  crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

const exportarChave = async (k) => b64u.para(await crypto.subtle.exportKey("raw", k));

const importarChave = (s) =>
  crypto.subtle.importKey("raw", b64u.de(s), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

async function cifrar(objeto) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, chave, new TextEncoder().encode(JSON.stringify(objeto))
  );
  const junto = new Uint8Array(iv.length + ct.byteLength);
  junto.set(iv);
  junto.set(new Uint8Array(ct), iv.length);
  return b64u.para(junto);
}

async function decifrar(texto) {
  const bytes = b64u.de(texto);
  const claro = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) }, chave, bytes.slice(12)
  );
  return JSON.parse(new TextDecoder().decode(claro));
}

/* ---------- 1. Criar ---------- */

document.querySelectorAll(".opcao").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".opcao").forEach((o) => {
      o.classList.remove("activa");
      o.setAttribute("aria-checked", "false");
    });
    b.classList.add("activa");
    b.setAttribute("aria-checked", "true");
    ttl = b.dataset.ttl;
  })
);

async function criarSala() {
  const n = $("nome-criar").value.trim();
  if (!n) return erro("e-criar", "Escreve um nome primeiro.");
  $("b-criar").disabled = true;
  $("b-criar").textContent = "A abrir…";
  try {
    const r = await fetch("/api/salas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttl }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro);

    nome = n;
    guardarNome(n);
    chave = await gerarChave();
    chaveTexto = await exportarChave(chave);
    codigo = d.code;
    expiraEm = d.expiraEm;

    $("cod-convite").textContent = codigo;
    $("link-sala").textContent = linkDaSala();
    history.replaceState(null, "", `/s/${codigo}#k=${chaveTexto}`);
    erro("e-criar", "");
    mostrar("v-convite");
  } catch (e) {
    erro("e-criar", e.message || "Não foi possível abrir a sala.");
  } finally {
    $("b-criar").disabled = false;
    $("b-criar").textContent = "Abrir uma sala";
  }
}

$("b-criar").addEventListener("click", criarSala);
$("nome-criar").addEventListener("keydown", (e) => e.key === "Enter" && criarSala());

/* ---------- 2. Convite ---------- */

async function partilhar() {
  const dados = {
    title: "Sala",
    text: "Entra nesta sala comigo. O link expira.",
    url: linkDaSala(),
  };
  try {
    await navigator.share(dados);
  } catch {
    /* cancelado pelo utilizador */
  }
}

async function copiar() {
  try {
    await navigator.clipboard.writeText(linkDaSala());
    avisar("Link copiado");
  } catch {
    const c = $("link-sala");
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(c);
    sel.removeAllRanges();
    sel.addRange(r);
    avisar("Copia o link selecionado");
  }
}

if (navigator.share) $("b-partilhar").classList.remove("oculto");
$("b-partilhar").addEventListener("click", partilhar);
$("b-copiar").addEventListener("click", copiar);
$("b-entrar-minha").addEventListener("click", () => ligar());
$("b-convidar").addEventListener("click", () => (navigator.share ? partilhar() : copiar()));

/* ---------- 3. Entrada por convite ---------- */

async function prepararEntrada() {
  codigo = (location.pathname.split("/s/")[1] || "").toUpperCase().slice(0, 6);
  chaveTexto = new URLSearchParams(location.hash.slice(1)).get("k") || "";
  $("cod-entrada").textContent = codigo || "?";
  mostrar("v-entrada");

  if (!codigo || !chaveTexto) {
    $("info-entrada").textContent =
      "Este link está incompleto. Pede o link inteiro a quem abriu a sala — tem de incluir a parte depois do #.";
    return;
  }

  try {
    chave = await importarChave(chaveTexto);
  } catch {
    $("info-entrada").textContent = "A chave deste link não é válida.";
    return;
  }

  try {
    const r = await fetch(`/api/salas/${codigo}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro);
    expiraEm = d.expiraEm;
    $("info-entrada").textContent = `A sala está aberta e desaparece daqui a ${restante(expiraEm)}. Escolhe um nome e entra.`;
    $("nome-entrada").value = lerNome();
    $("form-entrada").classList.remove("oculto");
    $("nome-entrada").focus();
  } catch (e) {
    $("info-entrada").textContent = e.message || "Não foi possível confirmar esta sala.";
  }
}

function entrarPorConvite() {
  const n = $("nome-entrada").value.trim();
  if (!n) return erro("e-entrada", "Escreve um nome primeiro.");
  nome = n;
  guardarNome(n);
  erro("e-entrada", "");
  $("b-entrar").disabled = true;
  $("b-entrar").textContent = "A ligar…";
  ligar();
}

$("b-entrar").addEventListener("click", entrarPorConvite);
$("nome-entrada").addEventListener("keydown", (e) => e.key === "Enter" && entrarPorConvite());

/* ---------- 4. Sala ---------- */

function sistema(txt) {
  const p = document.createElement("p");
  p.className = "sistema";
  p.textContent = txt;
  $("mensagens").append(p);
  $("fim").scrollIntoView({ block: "end" });
}

async function acrescentar(msg) {
  $("vazio").classList.add("oculto");
  const div = document.createElement("div");
  div.className = "msg";
  let autor = "—";
  let corpo = "";
  try {
    const claro = await decifrar(msg.ct);
    autor = String(claro.n || "?").slice(0, 20);
    corpo = String(claro.txt || "");
    if (autor === nome) div.classList.add("minha");
  } catch {
    div.classList.add("ilegivel");
    corpo = "mensagem cifrada com outra chave";
  }
  div.innerHTML = '<div class="cabeca"><span class="autor"></span><span class="hora"></span></div><p class="corpo"></p>';
  div.querySelector(".autor").textContent = autor;
  div.querySelector(".hora").textContent = horas(msg.t);
  div.querySelector(".corpo").textContent = corpo;
  div.dataset.t = msg.t;
  $("mensagens").append(div);
  $("fim").scrollIntoView({ behavior: "smooth", block: "end" });
}

function desvanecer() {
  const agora = Date.now();
  document.querySelectorAll(".msg").forEach((m) => {
    const nascida = Number(m.dataset.t);
    const vida = expiraEm - nascida;
    if (vida <= 0) return;
    m.style.opacity = String(Math.max(0.32, 1 - ((agora - nascida) / vida) * 0.8));
  });
}

function actualizarConta() {
  if (!expiraEm) return;
  $("conta").textContent = `desaparece daqui a ${restante(expiraEm)}`;
}

function ligar() {
  if (!chave || !codigo) return;
  mostrar("v-sala");
  $("cod-sala").textContent = codigo;
  $("estado").classList.add("fora");

  if (!socket) {
    socket = io({ transports: ["websocket", "polling"] });

    socket.on("connect", () => {
      socket.emit("entrar", { code: codigo }, async (r) => {
        if (!r?.ok) {
          socket.disconnect();
          socket = null;
          mostrar("v-entrada");
          $("form-entrada").classList.add("oculto");
          $("info-entrada").textContent = r?.erro || "Não foi possível entrar.";
          $("b-entrar").disabled = false;
          $("b-entrar").textContent = "Entrar na sala";
          return;
        }
        expiraEm = r.expiraEm;
        $("estado").classList.remove("fora");
        actualizarConta();
        $("mensagens").textContent = "";
        $("vazio").classList.toggle("oculto", r.historico.length > 0);
        for (const m of r.historico) await acrescentar(m);
        if (jaEntrou) sistema("Ligação recuperada.");
        jaEntrou = true;
        $("texto").focus();
      });
    });

    socket.on("mensagem", acrescentar);
    socket.on("presenca", ({ n }) => {
      $("conta").textContent = `${n === 1 ? "só tu" : n + " pessoas"} · desaparece daqui a ${restante(expiraEm)}`;
    });
    socket.on("sala:fechada", ({ motivo }) => {
      sistema(motivo);
      $("texto").disabled = true;
      $("b-enviar").disabled = true;
      $("estado").classList.add("fora");
    });
    socket.on("disconnect", () => {
      $("estado").classList.add("fora");
      $("conta").textContent = "sem ligação · a tentar voltar";
    });

    setInterval(() => { desvanecer(); actualizarConta(); }, 30000);
  }
}

async function enviar() {
  const txt = $("texto").value.trim();
  if (!txt) return;
  if (!socket?.connected) return erro("e-sala", "Sem ligação. Espera um instante.");
  $("texto").value = "";
  $("texto").style.height = "auto";
  try {
    socket.emit("mensagem", { ct: await cifrar({ n: nome, txt }) }, (r) =>
      erro("e-sala", r?.ok ? "" : r?.erro)
    );
  } catch {
    erro("e-sala", "Não foi possível cifrar a mensagem.");
  }
}

$("b-enviar").addEventListener("click", enviar);
$("texto").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    enviar();
  }
});
$("texto").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 130) + "px";
});

$("b-sair").addEventListener("click", () => {
  socket?.disconnect();
  location.href = "/";
});

$("b-fechar").addEventListener("click", () => {
  if (confirm("Fechar a sala apaga tudo para toda a gente. Continuar?")) {
    socket?.emit("fechar");
    setTimeout(() => (location.href = "/"), 400);
  }
});

/* ---------- Arranque ---------- */

if (location.pathname.startsWith("/s/")) {
  prepararEntrada();
} else {
  $("nome-criar").value = lerNome();
  mostrar("v-criar");
}
