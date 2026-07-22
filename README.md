# BioAmazon IA — MVP (Edge / Offline-First)

Jornada digital do açaí: o produtor **fala**, o **Gemma** extrai a ficha técnica
estruturada e gera a narrativa, o operador confirma, e nasce uma **página pública + QR**.

Arquitetura **Offline-First + Edge AI**: no alvo final (Android/LiteRT-LM, navegador/WebGPU)
a inteligência roda **no aparelho**. No laptop de desenvolvimento, o mesmo contrato
(`gemma_generate`) fala com o Gemma real hospedado via **Gemini API** — sem baixar pesos,
sem GPU — para provar o fluxo ponta a ponta hoje.

## Estrutura
```
backend/
  gemma/gemma_generate.py   # ÚNICO ponto de contato com o Gemma (mock | gemini | ollama | LiteRT)
  extraction/               # Passagem 1: prompt + schema JSON da ficha
  narrative/                # Passagem 2: prompt da narrativa (só fatos confirmados)
  pipeline.py               # orquestra as 2 passagens
cli/run_poc.py              # PoC de linha de comando (input -> JSON -> narrativa)
server/app.py               # servidor Flask: serve a PWA + medeia o Gemma (/api/extrair,
                             # /api/narrar) + publica página pública e QR (/api/publicar, /p/<slug>)
frontend/                   # PWA offline-first (captura + IndexedDB + fila de sync)
android/README_LITERT.md    # Gemma on-device: AI Edge Gallery + LiteRT-LM
docs/EDGE_RESEARCH.md       # pesquisa técnica (4 perguntas respondidas)
seed/                       # exemplo de açaí (fallback do demo)
publicados/                 # lotes publicados (JSON por slug), gerado em runtime
```

## Configuração

```bash
pip3 install -r requirements.txt
cp .env.example .env
# edite .env e cole sua GEMINI_API_KEY (grátis, sem cartão: aistudio.google.com/app/apikey)
```

## Rodar a aplicação completa (frontend + backend real, um único servidor)
```bash
python3 server/app.py            # abre http://localhost:8000
```
O navegador grava a fala do produtor (transcrita ao vivo pela **Web Speech API** nativa —
o Gemma hospedado via Gemini API não recebe áudio, só texto+imagem) e a foto, manda tudo pro
Gemma real via `/api/extrair`, o operador confirma/edita cada campo, `/api/narrar` gera a
jornada, e `/api/publicar` cria a página pública + QR. Sem servidor no ar, a PWA cai
automaticamente para o modo mock (o cabeçalho mostra qual modo está ativo).

## Rodar só a PoC do pipeline via CLI
```bash
# sem rede, sem pesos, sem API key (prova o fluxo + schema + proveniência):
GEMMA_BACKEND=mock python3 cli/run_poc.py --text-file seed/transcript_acai.txt

# com Gemma REAL (Gemini API), a mesma PoC:
GEMMA_BACKEND=gemini python3 cli/run_poc.py --text-file seed/transcript_acai.txt --image seed/foto_acai.jpg

# com Ollama local (100% offline, precisa instalar Ollama + baixar o modelo):
ollama run gemma3n:e2b
GEMMA_BACKEND=ollama python3 cli/run_poc.py --text-file seed/transcript_acai.txt
```
> No **Android** (alvo final), o mesmo pipeline roda via **LiteRT-LM**, 100% on-device,
> inclusive com áudio — ver `android/`.

## Plano incremental (validar etapa por etapa)
1. ✅ Gemma real responde (Gemini API; Ollama/LiteRT = alternativas)
2. ✅ inferência → **JSON estruturado** com proveniência
3. ✅ **narrativa** só de fatos confirmados
4. ✅ integrado à PWA — servidor medeia o Gemma real (`server/app.py`)
5. ✅ confirmação editável por campo (loop de confiança de verdade)
6. ✅ **publicar** página pública + QR (`/api/publicar`, `/p/<slug>`)
7. ✅ **offline** ponta a ponta (IndexedDB + Service Worker); cai pra mock sem servidor
8. 🔶 **sincronizar** ao reconectar (botão manual pronto; automático = depois do MVP)
9. ⬜ app Android nativo com LiteRT-LM (hoje só o plano em `android/`)

## Regra de ouro
Toda a inteligência passa por `gemma_generate`. Trocar mock → Gemini API → Ollama → LiteRT é
**configuração**, não reescrita. O Gemma é o cérebro; nada de Whisper/Llama como IA principal
(a Web Speech API só transcreve a fala em texto — quem extrai e narra é sempre o Gemma).
