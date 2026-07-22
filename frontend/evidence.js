/* evidence.js — primitivas de CAPTURA DE EVIDÊNCIA (câmera + GPS).
   Objetivo da Fase 2: cada foto vira uma evidência auditável, tirada aqui-e-agora,
   com GPS + horário carimbados no momento do clique. É a base da rastreabilidade.

   Decisão de arquitetura (ver conversa/README): NÃO usamos o atributo `capture` do
   <input file> (é ignorado no desktop, onde roda a demo). Usamos getUserMedia +
   canvas, que funciona no Mac e no celular e permite carimbar GPS/hora na hora.
   O upload de arquivo continua existindo como FALLBACK rotulado — a evidência
   registra a fonte ("camera" = ao vivo/verificada, "arquivo" = não verificada),
   transformando o nível de confiança em dado, em vez de suposição. */
(() => {
  // ---------------- GPS ----------------
  // Resolve SEMPRE (nunca rejeita): {ok:true, lat,lng,accuracy} ou {ok:false, motivo}.
  // Geolocalização exige contexto seguro (localhost/HTTPS).
  function captureGPS() {
    return new Promise((resolve) => {
      if (!("geolocation" in navigator)) {
        return resolve({ ok: false, motivo: "Geolocalização não suportada neste navegador" });
      }
      if (!window.isSecureContext) {
        return resolve({ ok: false, motivo: "GPS exige contexto seguro (use http://localhost, não o IP da rede)" });
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          ok: true,
          lat: +pos.coords.latitude.toFixed(6),
          lng: +pos.coords.longitude.toFixed(6),
          accuracy: pos.coords.accuracy != null ? Math.round(pos.coords.accuracy) : null,
        }),
        (err) => resolve({ ok: false, motivo: gpsErro(err) }),
        { enableHighAccuracy: true, timeout: 9000, maximumAge: 0 },
      );
    });
  }
  function gpsErro(err) {
    if (err.code === err.PERMISSION_DENIED) return "Permissão de localização negada";
    if (err.code === err.POSITION_UNAVAILABLE) return "Posição indisponível";
    if (err.code === err.TIMEOUT) return "Tempo esgotado ao obter GPS";
    return "Falha no GPS";
  }

  // ---------------- Câmera (getUserMedia + canvas) ----------------
  // Abre um overlay com vídeo ao vivo. Resolve com uma EVIDÊNCIA:
  //   { image(dataURL), fonte:"camera"|"arquivo", gps, timestamp }  ou  null (cancelou).
  // O GPS é disparado junto com a abertura (fica pronto quando a foto é tirada).
  function capturePhoto(labelText) {
    return new Promise((resolve) => {
      const gpsPromise = captureGPS();
      const ov = document.createElement("div");
      ov.className = "cam-overlay";
      ov.innerHTML = `
        <div class="cam-frame">
          <div class="cam-head"><span>${labelText || "Capturar foto"}</span>
            <button class="cam-x" aria-label="Fechar">✕</button></div>
          <div class="cam-body">
            <video class="cam-video" autoplay playsinline muted></video>
            <div class="cam-msg hide"></div>
          </div>
          <div class="cam-controls">
            <button class="cam-shot" disabled>📷 Capturar</button>
            <label class="cam-file">📎 Enviar arquivo (não verificada)
              <input type="file" accept="image/*" hidden/></label>
          </div>
          <p class="cam-gps hint"><span class="dot"></span>Obtendo GPS…</p>
        </div>`;
      document.body.appendChild(ov);
      const video = ov.querySelector(".cam-video");
      const shot = ov.querySelector(".cam-shot");
      const msg = ov.querySelector(".cam-msg");
      const gpsLine = ov.querySelector(".cam-gps");
      const fileInp = ov.querySelector(".cam-file input");
      let stream = null, done = false;

      gpsPromise.then((g) => {
        if (done) return;
        gpsLine.className = "hint" + (g.ok ? "" : " erro");
        gpsLine.innerHTML = g.ok
          ? `📍 GPS: ${g.lat}, ${g.lng} (±${g.accuracy ?? "?"} m)`
          : `⚠️ ${g.motivo}`;
      });

      function cleanup(result) {
        if (done) return; done = true;
        if (stream) stream.getTracks().forEach((t) => t.stop());
        ov.remove();
        resolve(result);
      }
      async function finish(image, fonte) {
        const gps = await gpsPromise;
        cleanup({ image, fonte, gps, timestamp: new Date().toISOString() });
      }

      ov.querySelector(".cam-x").onclick = () => cleanup(null);
      ov.onclick = (e) => { if (e.target === ov) cleanup(null); };

      shot.onclick = () => {
        const c = document.createElement("canvas");
        c.width = video.videoWidth; c.height = video.videoHeight;
        c.getContext("2d").drawImage(video, 0, 0);
        finish(c.toDataURL("image/jpeg", 0.85), "camera");
      };
      fileInp.onchange = (e) => {
        const f = e.target.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = () => finish(r.result, "arquivo");
        r.readAsDataURL(f);
      };

      navigator.mediaDevices?.getUserMedia({ video: { facingMode: "environment" } })
        .then((s) => {
          stream = s; video.srcObject = s;
          // só libera o obturador quando o vídeo tem dimensões (senão o canvas sai vazio)
          video.onloadedmetadata = () => { shot.disabled = false; };
        })
        .catch((err) => {
          msg.classList.remove("hide");
          msg.textContent = "Câmera indisponível (" + err.name +
            "). Use “Enviar arquivo” abaixo — a evidência será marcada como não verificada.";
          video.classList.add("hide");
        });
    });
  }

  window.Evidence = { captureGPS, capturePhoto };
})();
