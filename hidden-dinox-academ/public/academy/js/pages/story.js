/* Страница «THE STORY BEHIND HIDDEN DINOX»: RU / EN / UA, общий выбор языка академии (localStorage hd_lang). */
(function () {
  "use strict";
  const S = window.HD_STORY, el = document.getElementById("story");
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let lang = "ru"; try { const x = localStorage.getItem("hd_lang"); if (S[x]) lang = x; } catch (e) {}
  function render() {
    const d = S[lang];
    document.documentElement.lang = lang === "ua" ? "uk" : lang; document.title = d.title;
    document.getElementById("backT").textContent = d.back;
    document.querySelectorAll(".st-langs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
    const title = esc(d.title).replace("HIDDEN DINOX", "<em>HIDDEN DINOX</em>");
    const ch = (c, i) => `<section class="st-ch" data-ch="${i}"><p class="st-label">${esc(c.label)}</p>${c.text.map(t => `<p>${esc(t)}</p>`).join("")}${c.quote ? `<p class="st-quote">${esc(c.quote)}</p>` : ""}</section>`;
    el.innerHTML = `
      <section class="st-hero"><div><span class="st-kicker">${esc(d.kicker)}</span><h1 class="st-title">${title}</h1><p class="st-lead">${esc(d.lead)}</p></div>
        <img src="assets/mascot/mascot-pointing-forward.webp" alt="HIDDEN DINOX" width="900" height="1200" fetchpriority="high"></section>
      <div class="st-line">${d.chapters.slice(0, 3).map(ch).join("")}</div>
      <div class="st-mid"><img src="assets/mascot/mascot-crouch.webp" alt="" loading="lazy" width="979" height="1000"><div class="st-line" style="margin:0">${d.chapters.slice(3, 5).map((c, i) => ch(c, i + 3)).join("")}</div></div>
      <div class="st-line">${d.chapters.slice(5).map((c, i) => ch(c, i + 5)).join("")}</div>
      <section class="st-final">${d.finale.map(t => `<p>${esc(t)}</p>`).join("")}<p class="st-slogan">${esc(d.slogan)}</p>
        <p class="st-disc">${esc(d.disclaimer)}</p><div class="st-cta"><a href="academy.html">${esc(d.cta)}<span aria-hidden="true">→</span></a></div></section>`;
    const io = "IntersectionObserver" in window ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.12 }) : null;
    el.querySelectorAll(".st-ch").forEach(s => (io ? io.observe(s) : s.classList.add("in")));
  }
  document.querySelectorAll(".st-langs button").forEach(b => (b.onclick = () => { lang = b.dataset.lang; try { localStorage.setItem("hd_lang", lang); } catch (e) {} render(); window.scrollTo(0, 0); }));
  render();
})();
