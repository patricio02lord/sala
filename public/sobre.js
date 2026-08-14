/* Página de apresentação: revelar ao deslizar e sombra no topo. */

(() => {
  const alvos = document.querySelectorAll("[data-anima]");
  const reduzido = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reduzido || !("IntersectionObserver" in window)) {
    alvos.forEach((el) => el.classList.add("visivel"));
  } else {
    const observador = new IntersectionObserver(
      (entradas) => {
        for (const e of entradas) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("visivel");
          observador.unobserve(e.target);
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    alvos.forEach((el) => observador.observe(el));
  }

  const topo = document.querySelector(".topo");
  const aoRolar = () => topo.classList.toggle("rolado", window.scrollY > 8);
  aoRolar();
  window.addEventListener("scroll", aoRolar, { passive: true });
})();
