# Pesquisa técnica — Gemma on-device no Android (Edge/Offline)
_Fonte: documentação oficial Google AI Edge, Gemma developer guide, AI Edge Gallery. Data: 22/07/2026._

Resposta direta às 4 perguntas do plano, com nível de confiança e limitações honestas.

## 1. É tecnicamente possível rodar Gemma localmente no Android? **SIM.**

Dois caminhos oficiais, confirmados:

- **AI Edge Gallery** (app pronto do Google, na Play Store, beta aberto): roda **Gemma 3n 100% offline** no celular, com **texto + imagem + áudio** ("Audio Scribe": grava do microfone ou carrega clipe, ASR de alta qualidade e tradução, clipes até ~30s). "No internet connection required". É a prova instantânea de que o Gemma multimodal roda no Android — **zero código**.
- **LiteRT-LM** (framework de inferência on-device de produção do Google, open-source): é o caminho do **app customizado**. API **Kotlin estável** para Android. Suporta **Gemma 3n E2B/E4B** e **Gemma 4 E2B/E4B**, com **vision + audio**. Formato de modelo `.litertlm`. Aceleração por **GPU/NPU**.

> ⚠️ **MediaPipe `tasks-genai` foi DEPRECADO** — o Google recomenda migrar para **LiteRT-LM**. Construa no LiteRT-LM para não apoiar em algo morto.

**Requisitos (honestos):**
- Otimizado para **aparelhos bons** (Pixel 8, Galaxy S23 ou superiores). **Não roda de forma confiável em emulador** → precisa de celular físico para o demo.
- **Armazenamento:** Gemma(4)-E2B ≈ **2,58 GB**, E4B ≈ **3,65 GB**. Gemma 3n E2B roda com footprint de memória ~2 GB (E4B ~3 GB) graças ao PLE.
- **Pico de memória** medido no LiteRT-LM para E2B: ~**0,68–3,5 GB** dependendo do device e do backend (GPU/NPU baixa; CPU alta).
- **Desempenho:** em aparelho topo, de alguns a dezenas de tokens/s; em aparelho de entrada, lento ou inviável.

## 2. Forma mais simples num MVP de 24h? (ranking por viabilidade real)

| Opção | O que é | Esforço 24h | Recomendação |
|---|---|---|---|
| **AI Edge Gallery** | App pronto rodando Gemma 3n offline no celular | **Minutos, zero código** | ✅ Prova de conceito on-device + material de vídeo |
| **App Android nativo + LiteRT-LM (Kotlin)** | Nosso app real, Gemma 3n E2B `.litertlm` | Médio (precisa skill Android) | ✅ **Espinha do produto** se o time tiver Android Studio |
| **PWA + WebGPU** (MediaPipe Web / transformers.js) | Gemma no Chrome do Android | Alto/arriscado (áudio instável) | ⚠️ Só se quiser manter PWA e aceitar o risco |
| Ollama / laptop | Gemma local no notebook | Baixo | 🔧 Só ambiente de **dev/validação**, não é o produto |

**Decisão recomendada:** espinha = **app Android nativo LiteRT-LM (Gemma 3n E2B)**; prova instantânea/vídeo = **AI Edge Gallery**; laptop+mock = só desenvolvimento.

> **Implicação para a SPEC (decisão do Breno):** a inferência **nativa** no Android empurra o invólucro de "PWA" (§9) para **app Android** (ou PWA+WebGPU, mais arriscado). A **experiência** (falar → confirmar → QR) NÃO muda; muda a **casca** de UI. Se o time não domina Android nativo, a alternativa é: **AI Edge Gallery = demo on-device** + PWA só para publicação/QR/sync online.

## 3. Dá para rodar parte do pipeline 100% offline? **SIM.**

O trecho **captura → Gemma → JSON → narrativa → salva local** é 100% offline e comprovadamente viável — é literalmente o que a AI Edge Gallery já faz (texto+imagem+áudio no aparelho). O que **exige internet** é só a **publicação** (slug/página/QR), que entra na **fila de sync**. 

Esta PoC (`cli/run_poc.py`) já executa esse fluxo offline; com `GEMMA_BACKEND=ollama` (ou o backend LiteRT no app) ele roda no **Gemma real**.

**Áudio:** on-device, o **próprio Gemma 3n faz o ASR** (não precisamos de Whisper — o Gemma continua o cérebro). No Ollama de laptop o áudio é limitado; no **Android via LiteRT-LM/Gallery o áudio funciona**. Ou seja: áudio 100% offline é viável **no alvo (Android)**.

## 4. Limitações (análise sem filtro)

1. **Aparelho de entrada é o alvo mais difícil para LLM on-device.** Aqui mora a tensão real do projeto: o discurso é "celular fraco na floresta", mas rodar E2B pede aparelho intermediário-para-cima. **Mitigar:** mirar **E2B** (não E4B), quantização, e manter o **fallback nuvem** via a mesma `gemma_generate`.
2. **Áudio:** batch, **≤30s por clipe, sem streaming** ainda. Narração longa precisa ser **fatiada**.
3. **Multimodal simultâneo (áudio+imagem no mesmo prompt) on-device** é o caminho mais pesado. **Medir na H4.** Se pesar, **sequenciar** (áudio→texto, depois texto+imagem) — continua tudo Gemma.
4. **Build Android nativo em 24h** é risco de cronograma se ninguém domina Android. **Plano honesto:** se faltar skill/tempo, a espinha demonstrável vira **AI Edge Gallery (on-device real) + PWA para publicação**, e o app nativo custom fica "em andamento".
5. **Emulador não confiável** → depender de **aparelho físico** no demo.

## Veredito para o hackathon
Rodar Gemma no Android offline **é real e está ao nosso alcance**. O caminho de **menor risco que ainda prova o edge** é: **AI Edge Gallery no celular (prova on-device, hoje) + nosso pipeline (este repo) portado para LiteRT-LM**. Decidir o invólucro (app nativo vs PWA+WebGPU) na **H0** conforme o skill do time — essa é a única decisão que trava tudo o resto.
