# Project Specification: 내가 쓰는 대로 (As I Write)

**Subtitle:** A RimWorld-Inspired 2D Top-Down Narrative God-Sandbox Powered by Local Semantic Embeddings & Generative AI

---

## 1. Project Context & Course Constraints (CRITICAL)

This project is developed as a university final project (_Topic 2: Development of a Generative AI-Based Application_). Every architectural decision MUST adhere to these hard constraints:

1. **Source Code Size Limit ($\le$ 10 MB):** The zipped source code directory (excluding `node_modules`, `dist`, `.git`) MUST be strictly under **10 MB** (target **< 2 MB**).
   - **Zero Heavy Static Assets:** Do NOT include PNG sprite sheets, audio files (MP3/WAV), or precomputed float embedding arrays in the repository. All visuals must be procedurally rendered on HTML5 Canvas, and all sound effects must be synthesized via the Web Audio API.
   - **Text-Only Saves & Presets:** Save files and starter world presets must store pure text (`name`, `appearance`, `traits` strings, `logs`) and recompute embedding vectors at runtime.
2. **Zero-Cost, Zero-Key Grader Execution (Hybrid AI Architecture):**
   - **Default Mode (Zero API Key / Zero Cost):** Must run out-of-the-box without requiring the grader to sign up or enter any API key, and without crashing low-spec office laptops (e.g., 8GB RAM, integrated GPU).
     - _Semantic Embedding:_ `@huggingface/transformers` running `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (quantized, ~80MB, CPU/WASM compatible) to encode free-text traits, world contexts, and commands into 384-d vectors.
     - _Lightweight Generative LLM:_ `@huggingface/transformers` (ONNX) or `@mlc-ai/web-llm` running an ultra-lightweight open model (`Qwen/Qwen2.5-0.5B-Instruct` or `HuggingFaceTB/SmolLM2-360M-Instruct`, ~300–400MB quantized) with a visible download progress indicator and graceful degradation fallback if WebGPU/WASM memory is constrained.
   - **Optional Cloud Boost Mode (Free Tier API):** Provide an optional input field in the Settings modal for a free **Google Gemini (`gemini-2.5-flash`)** or **Groq** API key (stored only in `localStorage`, never hardcoded) for faster, richer narrative generation during demos and personal play.

---

## 2. Recommended Tech Stack

- **Framework:** React 18 + TypeScript + Vite + Tailwind CSS
- **Simulation & Rendering:** Custom 60fps HTML5 Canvas 2D Engine (`requestAnimationFrame`) with **Spatial Grid** ($O(1)$ neighbor queries) and **Time-Sliced AI Updates**.
- **AI Libraries:** `@huggingface/transformers` (for local embeddings and lightweight text generation) + standard `fetch` REST adapter (0 KB overhead) for optional Gemini/Groq API calls.
- **Graph Visualization:** Interactive SVG/Canvas radial node-link graph for the 2-Stage Relationship & Chronicle viewer.

---

## 3. Core Game Systems & Functional Requirements

### 3.1. Minimalist 'Prompt-First' Title Screen & Blackout Docking Transition

- **Visual Layout:** A clean, atmospheric dark/parchment screen featuring ONLY the title **"내가 쓰는 대로"** and a single glowing command input box directly beneath it. Subtle muted hint keywords (`빛이 있으라`, `시작`, `설정`, `불러오기`, `종료`) appear faintly below the input.
- **Semantic Boot Trigger:** Entering creation/start phrases (e.g., `"빛이 있으라"`, `"시작"`, `"start"`, `"새로운 세상"`, or a full world prompt like `"비 오는 현대 서울에 고양이 한 마리와 시작"`) classifies the intent as `START_GAME` and extracts any initial `WorldContext` or entities. Entering `"설정"`, `"불러오기"`, or `"종료"` opens the respective modal/action.
- **Transition Choreography:**
  1. Upon submitting a start command, the entire screen fades to pitch black (`opacity: 0` $\rightarrow$ blackout) **EXCEPT the command input box**, which remains illuminated.
  2. Over `600ms` (`cubic-bezier(0.22, 1, 0.36, 1)`), the input box smoothly translates and scales from screen center into the **Top-Center Omnipotent Command HUD**.
  3. Once docked at the top, the blackout fades away to reveal the living 2D top-down world underneath.

### 3.2. Omnipotent Top Command Bar (Natural Language God Control)

- Players can perform **every action** in the game via natural language in the top command bar (as well as optional direct click/drag tools):
  - _Spawning:_ `"고양이를 좋아하는 샐러리맨 소환"`, `"골목 어귀에 아늑한 노래방 배치"`
  - _World & Weather Shifts:_ `"세계관을 중세 판타지로 변경"`, `"지금부터 여기는 좀비 아포칼립스야"`, `"갑자기 소나기가 내리게 해줘"`
  - _Intervention & Events:_ `"우울해하는 철수 옆에 작고 노란 길고양이 소환"`, `"민수와 영희가 마주치게 해줘"`, `"선택한 건물에 번개 내리기"`
- **Semantic Command-to-JSON Parser:** Translates free-form Korean commands into strict JSON schemas (`SPAWN_ENTITY`, `MODIFY_ENTITY`, `SET_WORLD_CONTEXT`, `SET_WEATHER`, `TRIGGER_EVENT`, `DELETE_ENTITY`).

### 3.3. World Setting Prompt (`WorldContext`) & Lazy Reactive Tag Mutation

- **Global World Context:** Defaults to `"현대 한국 일상"`. Changing it (e.g., to `"중세 판타지"`, `"사이버펑크"`, `"아포칼립스"`) alters the AI generation prompt so newly spawned entities receive context-appropriate roles, appearances, and ~10 sentence-based traits.
- **Reactive Tag Mutation (Event-Storming Prevention):**
  - When `WorldContext` shifts or a high-impact entity (e.g., dragon, celebrity, monster) spawns nearby, existing entities evaluate their trait embeddings against the new stimulus and mutate/gain reactive tags (e.g., `"카페 투어를 좋아함"` $\rightarrow$ `"무너진 카페 폐허를 보며 과거를 그리워함"`).
  - **CRITICAL OPTIMIZATION (Lazy Mutation):** NEVER fire 40 simultaneous LLM requests when `WorldContext` changes. Queue mutations and process **only entities inside the active camera viewport sequentially (max 1–2 entities/sec)**; off-screen entities mutate lazily when panned into view or clicked.

### 3.4. Multi-Person Conversation Clusters & Emergent Factions (4+ Members)

- **Dual-Speed Lively Dialogue (No Awkward Freezing):**
  - Characters must NEVER stand frozen for 5–10 seconds waiting for an LLM response.
  - _Layer 1 (Instant 0ms):_ Floating emotion icons (`🎵`, `💢`, `❤️`, `❓`, `💭`), procedural body bounce/slump animations, and fast embedding-matched template banter keep interactions immediately lively.
  - _Layer 2 (Async Background LLM):_ Enriches ongoing conversations with deep narrative lines, inner-thought contrasts, and chronicle summaries without blocking movement or rendering.
- **Conversation Clusters & Triadic Closure:**
  - When `A` and `B` are conversing, nearby `C` automatically joins the `ConversationCluster` (up to 5 participants) if `C` has high affinity ($\ge +30$) with `A` or `B`, OR high cosine similarity ($\ge 0.65$) between `C`'s trait vectors and the active conversation topic.
  - Group conversations build affinity across all pairs in the cluster (triadic closure).
- **Emergent Group / Faction Formation:**
  - When a subset of **$\ge 4$ characters** participates in **$\ge 3$ multi-person conversations together** and maintains an average pairwise affinity $> +50$, an async LLM call inspects their shared trait vectors and favorite hangout spots to coin a **Group Name** (e.g., `#심야_노래방_결사대`, `#길고양이_수호단`) and a **Group Color**, rendering a shared colored aura ring beneath members on the map.

### 3.5. Procedural Top-Down Appearance System & Structured Text Sheet Editor

- **Top-Down Visual Distinctiveness (6 Procedural Layers):**
  - Because the camera is 2D top-down, dozens of characters must be recognizable at a glance without relying solely on floating nameplates.
  - Every entity has an `appearance` text description. An AI/parser maps this text into 6 procedural Canvas rendering layers tailored for top-down silhouettes:
    1. `hairShape & hairColor` (short bob, long flowing, ponytail, twin-tails, messy, bald)
    2. `headgear` (beret, crown, hood, cat ears, helmet, star hairpin, cap)
    3. `outfitStyle & outfitColor` (suit, school uniform, cloak, armor, raincoat, hoodie)
    4. `faceAcc` (thick-rimmed glasses, sunglasses, eyepatch, blush, beard)
    5. `backOrHeldProp` (guitar case, greatsword, backpack, umbrella, book, magic staff)
    6. `bodyScale & gait` (build size and mood-driven bounce/slouch animation)
- **Structured Text Sheet Editor (External Character Importer):**
  - Clicking any entity opens an Inspector Panel with a **"텍스트 양식 편집" (Structured Text Edit)** mode.
  - Displays a clean, copy-pasteable template so users can easily import characters from other fictional works:
    ```text
    [이름]
    [분류]
    [외형]
    [성향 및 특성]
    -
    [초기 무드] 95
    ```
  - Saving parses the sheet, recomputes the 384-d embeddings for each trait bullet, and immediately updates the character's 2D top-down Canvas sprite.

### 3.6. RimWorld-Style Mood, Indirect God Intervention & 2-Stage Relationship Graph

- **Mood (`0–100`) & Active Thoughts:**
  - Entities accumulate timed Thought buffs/debuffs (e.g., `"운명처럼 나타난 길고양이를 쓰다듬음 (+20)"`, `"좋아하는 노래방에서 열창함 (+15)"`, `"아포칼립스 세상에 대한 불안 (-15)"`).
  - **Indirect Care Loop:** When a player inspects a sad character's traits and creates favorable surroundings (e.g., spawning a cat or rain/jazz cafe nearby), the character autonomously discovers it, gains a major Mood boost, and logs gratitude in their diary.
  - **Mood Thresholds:** High mood ($\ge 80$) triggers cheerful humming, faster bouncy movement, and proactive socializing; low mood ($\le 20$) triggers RimWorld-style "Mental Breaks" (slumping on a bench sighing `💨`, picking arguments, or singing sad songs alone).
- **2-Stage Narrative Relationship Graph:**
  1. _Stage 1 (Keyword Network Overview):_ Clicking a character displays a radial node graph of connected people, animals, and favorite places. Edge color/thickness reflects affinity; edge pills show concise AI-summarized tags (`#고양이_동지`, `#짝사랑_중`, `#단골_아지트`).
  2. _Stage 2 (Chronicle Detail View):_ Clicking any relationship edge opens a chronological timeline of decisive shared memories, including RimWorld-style inner-thought vs. outward-action contrasts, plus a `"추적하기" (Follow)` button to smoothly pan the camera to that target.

---

## 4. Academic Evaluation & Telemetry Panel (For Final Report)

Include a toggleable **"연구/분석 메트릭" (Research Telemetry)** drawer so the developer can export real experimental data and screenshots for the 15-page final report:

1. **Embedding Cosine Similarity Matrix:** Live heatmap showing cosine similarity scores between a selected character's ~10 sentence traits and nearby entities/objects (proving semantic matching without hardcoded keyword rules).
2. **Performance & Optimization Benchmark:** Live FPS counter, entity count, Spatial Grid lookup time (ms), and LLM queue latency (comparing cached embeddings vs. raw inference).
3. **Emergent Narrative Export:** One-click JSON/Markdown export of a character's life diary, tag mutations, and faction formation logs for qualitative case studies.

---

## 5. Phased Implementation Roadmap

- **Phase 1: Core Engine, Title Transition & Procedural Top-Down Renderer**
  - Scaffold React + Vite + TypeScript + Tailwind CSS.
  - Implement the minimalist **"내가 쓰는 대로"** title screen and the `600ms` blackout-to-top-HUD docking transition.
  - Build the 60fps HTML5 Canvas 2D world, Spatial Grid, time-sliced simulation loop, procedural 6-layer top-down character renderer, and Mood/Thought state system.
- **Phase 2: Local Embedding Pipeline, Structured Editor & AI Command Adapter**
  - Integrate `@huggingface/transformers` (`paraphrase-multilingual-MiniLM-L12-v2`) with vector caching for trait-to-entity Cosine Similarity utility AI.
  - Build the Inspector UI with the **Structured Text Sheet Editor** (`[이름]`, `[외형]`, `[성향 및 특성]`) and real-time sprite preview.
  - Implement the Hybrid LLM Adapter (zero-key local lightweight model + optional Gemini/Groq API key in Settings + structured fallback) for top-bar natural language commands.
- **Phase 3: Multi-Person Clusters, WorldContext Mutations & 2-Stage Relationship Graph**
  - Implement multi-person `ConversationCluster` joining (up to 5), triadic closure, and emergent 4+ member faction naming with shared aura rings.
  - Implement `WorldContext` global shifts with viewport-prioritized **Lazy Tag Mutation**.
  - Build the interactive **2-Stage Relationship Graph** (keyword radial view $\rightarrow$ edge chronicle timeline) and the **Research Telemetry** export panel.
