# Gemma on-device no Android — guia de integração

Duas frentes: (A) **prova instantânea** hoje, sem código; (B) **app real** com LiteRT-LM.

## A) Prova instantânea (minutos, zero código) — AI Edge Gallery
Serve para validar que o Gemma roda offline no celular do time e para gravar o vídeo.

1. Instale **Google AI Edge Gallery** (Play Store, beta aberto).
2. Baixe o modelo **Gemma 3n E2B** dentro do app (uma vez, com internet).
3. Ative o **modo avião**.
4. Teste **texto**, **imagem** (foto do açaí) e **áudio** ("Audio Scribe": grave a fala em português).
5. Grave a tela: é o "roda no celular, sem internet" do pitch.

## B) App real — LiteRT-LM (Kotlin, API estável)
Caminho do produto. `tasks-genai` do MediaPipe está **deprecado**; use **LiteRT-LM**.

**Passos:**
1. Modelo: baixe um `.litertlm` de Gemma 3n E2B (ex.: repositório `litert-community` no Hugging Face) e envie ao aparelho:
   ```
   adb push gemma-3n-E2B-it.litertlm /data/local/tmp/llm/
   ```
2. Dependência (Kotlin/Gradle) do LiteRT-LM (ver guia oficial `ai.google.dev/edge/litert-lm/android`).
3. Inferência (esqueleto):
   ```kotlin
   val engine = LlmInferenceEngine.create(
       context,
       LlmInferenceOptions.builder()
           .setModelPath("/data/local/tmp/llm/gemma-3n-E2B-it.litertlm")
           .setMaxTokens(1024)
           .setPreferredBackend(Backend.GPU)   // NPU/GPU quando disponível
           .build()
   )
   // Multimodal: adicionar imagem (bitmap) e/ou áudio (.wav mono, <=30s)
   val response = engine.generateResponse(prompt /*, image, audio */)
   ```
4. **Contrato:** o app implementa a MESMA `gemma_generate(prompt, image, audio) -> texto`
   usada no `backend/` deste repo. Os **prompts** de extração/narrativa e o **schema**
   JSON (`backend/extraction/`, `backend/narrative/`) são reaproveitados **sem mudança**.

**Fluxo on-device (offline):** captura → `gemma_generate` (LiteRT) → ficha JSON → confirmação → narrativa → **salva local (Room/SQLite)** → fila de sync → publica quando houver rede.

## Limitações a lembrar (ver docs/EDGE_RESEARCH.md)
- Aparelho intermediário-para-cima; emulador não confiável.
- Áudio ≤30s, batch (sem streaming); fatiar narração longa.
- E2B (não E4B) para caber em aparelho mais simples; fallback nuvem via mesma abstração.
