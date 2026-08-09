/* Sala — cliente.
   A chave AES-GCM vive no fragmento do URL (#k=...). O browser nunca envia
   fragmentos ao servidor, por isso o servidor só vê texto cifrado. */

const $ = (id) => document.getElementById(id);
const vistas = { porta: $("porta"), convite: $("convite"), sala: $("sala") };

let chave = null;
let codigo = null;
let nome = "";
let ttl = "24h";
let socket = null;
let expiraEm = 0;

/* ---------- Chave e cifra ---------- */

const b64u = {
  para: (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
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
  const dados = new TextEncoder().encode(JSON.stringify(objeto));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, chave, dados);
  const junto = new Uint8Array(iv.length + ct.byteLength);
  junto.set(iv);
  junto.set(new Uint8Array(ct), iv.length);
  return b64u.para(junto);
}

async function decifrar(texto) {
  const bytes = b64u.de(texto);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const claro = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, chave, ct);
  return JSON.parse(new TextDecoder().decode(claro));
}

/* ---------- Vistas ---------- */

function mostrar(qual) {
  for (const [n, el] of Object.entries(vistas)) el.classList.toggle("oculto", n !== qual);
}

const erro = (el, txt) => ($(el).textContent = txt || "");

const horas = (t) =>
  new Date(t).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });

function linkDaSala(code, chaveExportada) {
  return `${location.origin}/s/${code}#k=${chaveExportada}`;
}

/* ---------- Porta ---------- */

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

$("abrir").addEventListener("click", async () => {
  nome = $("nome").value.trim();
  if (!nome) return erro("erro-porta", "Escolhe um nome para esta sala.");
  $("abrir").disabled = true;
  try {
    const r = await fetch("/api/salas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttl }),
    });
    const dados = await r.json();
    if (!r.ok) throw new Error(dados.erro);

    chave = await gerarChave();
    const exportada = await exportarChave(chave);
    codigo = dados.code;
    expiraEm = dados.expiraEm;

    const link = linkDaSala(codigo, exportada);
    $("link-sala").textContent = link;
    history.replaceState(null, "", `/s/${codigo}#k=${exportada}`);
    erro("erro-porta", "");
    mostrar("convite");
  } catch (e) {
    erro("erro-porta", e.message || "Não foi possível abrir a sala.");
  } finally {
    $("abrir").disabled = false;
  }
});

$("entrar").addEventListener("click", () => {
  nome = $("nome").value.trim();
  if (!nome) return erro("erro-porta", "Escolhe um nome para esta sala.");
  const c = $("codigo").value.trim().toUpperCase();
  if (c.length !== 6) return erro("erro-porta", "O código tem 6 caracteres.");
  if (!location.hash.includes("k=")) {
    return erro(
      "erro-porta",
      "Só com o código não dá: precisas do link completo, com a chave depois do #."
    );
  }
  location.href = `/s/${c}${location.hash}`;
});

$("codigo").addEventListener("keydown", (e) => e.key === "Enter" && $("entrar").click());
$("nome").addEventListener("keydown", (e) => e.key === "Enter" && $("abrir").click());

/* ---------- Convite ---------- */

async function copiarLink(botao, textoOriginal) {
  const link = $("link-sala").textContent || linkDaSala(codigo, await exportarChave(chave));
  try {
    await navigator.clipboard.writeText(link);
    botao.textContent = "copiado";
    setTimeout(() => (botao.textContent = textoOriginal), 2000);
  } catch {
    prompt("Copia este link:", link);
  }
}

$("copiar").addEventListener("click", (e) => copiarLink(e.target, "Copiar link"));
$("copiar-topo").addEventListener("click", (e) => copiarLink(e.target, "copiar link"));
$("ir").addEventListener("click", () => ligar());

/* ---------- Sala ---------- */

function acrescentarSistema(texto) {
  const p = document.createElement("p");
  p.className = "sistema";
  p.textContent = texto;
  $("mensagens").append(p);
  $("fim").scrollIntoView({ behavior: "smooth" });
}

async function acrescentar(msg) {
  $("vazio").classList.add("oculto");
  const div = document.createElement("div");
  div.className = "msg";
  let autor = "?";
  let corpo = "";
  try {
    const claro = await decifrar(msg.ct);
    autor = String(claro.n || "?").slice(0, 20);
    corpo = String(claro.txt || "");
    if (autor === nome) div.classList.add("minha");
  } catch {
    div.classList.add("ilegivel");
    autor = "—";
    corpo = "mensagem cifrada com outra chave";
  }
  div.innerHTML = `<div class="cabeca"><span class="autor"></span><span class="hora"></span></div><p class="corpo"></p>`;
  div.querySelector(".autor").textContent = autor;
  div.querySelector(".hora").textContent = horas(msg.t);
  div.querySelector(".corpo").textContent = corpo;
  div.dataset.t = msg.t;
  $("mensagens").append(div);
  $("fim").scrollIntoView({ behavior: "smooth" });
}

function desvanecer() {
  const agora = Date.now();
  document.querySelectorAll(".msg").forEach((m) => {
    const nascida = Number(m.dataset.t);
    const restante = expiraEm - nascida;
    if (restante <= 0) return;
    const idade = (agora - nascida) / restante;
    m.style.opacity = String(Math.max(0.3, 1 - idade * 0.8));
  });
}

async function ligar() {
  const params = new URLSearchParams(location.hash.slice(1));
  const k = params.get("k");
  codigo = location.pathname.split("/s/")[1]?.toUpperCase() || codigo;

  if (!k || !codigo) {
    mostrar("porta");
    return erro("erro-porta", "Este link está incompleto. Pede o link inteiro a quem abriu a sala.");
  }

  try {
    chave = await importarChave(k);
  } catch {
    mostrar("porta");
    return erro("erro-porta", "A chave deste link é inválida.");
  }

  if (!nome) {
    nome = (prompt("O teu nome aqui dentro:") || "").trim().slice(0, 20);
    if (!nome) {
      mostrar("porta");
      return;
    }
  }

  socket = io({ transports: ["websocket", "polling"] });

  socket.on("connect", () => {
    socket.emit("entrar", { code: codigo }, async (r) => {
      if (!r?.ok) {
        mostrar("porta");
        return erro("erro-porta", r?.erro || "Não foi possível entrar.");
      }
      expiraEm = r.expiraEm;
      $("codigo-sala").textContent = codigo;
      const d = new Date(expiraEm);
      $("expira").textContent = `desaparece ${d.toLocaleDateString("pt-PT")} às ${horas(expiraEm)}`;
      $("mensagens").textContent = "";
      $("vazio").classList.toggle("oculto", r.historico.length > 0);
      for (const m of r.historico) await acrescentar(m);
      mostrar("sala");
      $("texto").focus();
    });
  });

  socket.on("mensagem", (m) => acrescentar(m));
  socket.on("presenca", ({ n }) => ($("presenca").textContent = n === 1 ? "só tu" : `${n} pessoas`));
  socket.on("sala:fechada", ({ motivo }) => {
    acrescentarSistema(motivo);
    $("texto").disabled = true;
    $("enviar").disabled = true;
  });
  socket.on("disconnect", () => acrescentarSistema("Ligação perdida. A tentar voltar."));

  setInterval(desvanecer, 30_000);
}

async function enviar() {
  const txt = $("texto").value.trim();
  if (!txt || !socket?.connected) return;
  $("texto").value = "";
  try {
    const ct = await cifrar({ n: nome, txt });
    socket.emit("mensagem", { ct }, (r) => erro("erro-sala", r?.ok ? "" : r?.erro));
  } catch {
    erro("erro-sala", "Não foi possível cifrar a mensagem.");
  }
}

$("enviar").addEventListener("click", enviar);
$("texto").addEventListener("keydown", (e) => e.key === "Enter" && enviar());
$("sair").addEventListener("click", () => (location.href = "/"));
$("fechar").addEventListener("click", () => {
  if (confirm("Fechar a sala apaga tudo para toda a gente. Continuar?")) {
    socket?.emit("fechar");
    setTimeout(() => (location.href = "/"), 400);
  }
});

/* ---------- Arranque ---------- */

if (location.pathname.startsWith("/s/")) ligar();
else mostrar("porta");
