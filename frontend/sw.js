/* Service Worker — cache do app shell para funcionar offline (SPEC §9 edge).
   Estratégia network-first: durante desenvolvimento ativo, a versão mais nova dos
   arquivos SEMPRE vence quando há rede; o cache só é usado se a rede falhar (uso
   offline real). Isso evita servir JS antigo em cache depois de um deploy/edição
   (ex.: uma versão velha de gemma-web.js com lógica de mock já removida do código-fonte). */
const CACHE = "bioamazon-v2";
const SHELL = ["./", "./index.html", "./config.js", "./gemma-web.js", "./app.js", "./manifest.webmanifest"];

self.addEventListener("install", (e) =>
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));

self.addEventListener("activate", (e) =>
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim())));

self.addEventListener("fetch", (e) => {
  // Nunca interceptar chamadas de API (POST /api/...) — devem ir direto à rede
  // e propagar erro real, não cair silenciosamente pro index.html em cache.
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
  );
});
