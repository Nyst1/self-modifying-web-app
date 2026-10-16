# Evolution — local app studio

A local Windows app that lets you evolve another app through prompts. Describe a calendar, game or utility, review the generated proposal, and apply it. The English studio controls stay fixed while generated HTML, CSS, JavaScript and JSON data change together. You can explore three directions, combine ideas, save feedback, and undo changes to code and data together.

Connect your own local AI through **Ollama**. Prompts, apps and feedback are stored in SQLite on your computer. This repository contains the studio's source code and setup scripts. **No AI model, Ollama binary, private prompts, saved apps or local database is included.**

## Requirements

- Windows, the platform used for development and verification. The launcher and optional portable Ollama setup use Windows scripts; other operating systems have not been verified.
- [Node.js](https://nodejs.org/) **24 or later**, including npm. The server uses Node's built-in SQLite support.
- [Git](https://git-scm.com/downloads), or download and extract this repository from GitHub.
- [Ollama](https://ollama.com/download) and a locally downloaded coding/chat model with **tool calling** and **structured JSON output** support. The studio uses these for history lookup and complete app proposals. Model quality and compatibility vary; test your chosen model before relying on it.
- Enough disk space, RAM and GPU memory for your chosen model. Models are downloaded separately and can be many gigabytes. Larger models or contexts can make generation much slower.

## Install the studio

```powershell
git clone https://github.com/Nyst1/self-modifying-web-app.git
cd self-modifying-web-app
npm.cmd ci
npx.cmd playwright install chromium
npm.cmd run build
```

The Chromium download is required for validating generated apps, even when Microsoft Edge is installed. Dependency, browser and model installation need an internet connection. Normal use with a downloaded local model does not require a cloud AI account or API key.

## Connect a local AI

### 1. Start Ollama on this computer

Install Ollama from its [official download page](https://ollama.com/download). The studio connects to Ollama's native API at **`http://127.0.0.1:11434`**. This address is fixed in `server/model.ts`; `OLLAMA_HOST` configures the Ollama service, not the studio's connection URL. A server exposing only an OpenAI-compatible API, such as a default LM Studio setup, is not a drop-in replacement.

For local-only use, disable Ollama's cloud features and keep it bound to loopback. Quit any running Ollama tray application, then run this in a separate PowerShell window and leave it running:

```powershell
$env:OLLAMA_HOST = "127.0.0.1:11434"
$env:OLLAMA_NO_CLOUD = "1"
ollama serve
```

If you prefer the Ollama tray application, set those variables in your Windows user environment and restart Ollama. Setting them only in the studio's terminal does not reconfigure an already-running Ollama service. See [Ollama's environment and local-only configuration](https://docs.ollama.com/faq).

### 2. Choose and download your model

In another PowerShell window, in the project directory, replace `your-model:tag` with the exact name of your chosen **local** model from the [Ollama library](https://ollama.com/library). Choose a model whose supported capabilities include [tool calling](https://docs.ollama.com/capabilities/tool-calling); the studio also requests [structured output](https://docs.ollama.com/capabilities/structured-outputs).

```powershell
$env:OLLAMA_MODEL = "your-model:tag"
ollama pull $env:OLLAMA_MODEL
ollama list
Invoke-RestMethod "http://127.0.0.1:11434/api/tags"
```

If the model is already installed, skip `ollama pull` and copy its exact name, including its tag, from `ollama list`. The download stays in Ollama's local model storage. It is not added to this repository.

### 3. Start and verify the connection

In the **same PowerShell window** where you set `OLLAMA_MODEL`:

```powershell
$env:OLLAMA_CONTEXT = "8192"
npm.cmd start
```

The studio opens its protected browser window. Click the model name at the top and choose **Check connection**. Confirm that it shows the selected model as installed, then try a small request such as “Make a counter with a plus button and a saved count.” Review the preview before applying it.

The studio reads configuration from the process environment; it **does not automatically load `.env` files**. PowerShell `$env:` settings last for that terminal session. Set `OLLAMA_MODEL` again before starting in a new terminal, or save it in your Windows user environment for later launches. If no value is set, the original default is `qwen3.8:27b-q4_K_M`; this is a model name in source code, not a bundled model or an automatic download.

Once configured, double-click **Start Studio.cmd** to launch using your saved user environment. Windows prefers installed Microsoft Edge, then Chrome or bundled Chromium. Each protected window uses a fresh profile; your ordinary browser profile is not modified.

For development use `npm.cmd run dev`. The studio listens at `http://127.0.0.1:4317`. An ordinary browser displays a launch screen; generated apps require the protected Chromium-based window. Starting again opens another protected window for the existing server without modifying its running jobs. To change the model or other settings, stop the existing studio server first and start it again. Closing that server closes its original browser. Ollama is a separate process; it can remain running, and the studio requests model unloading after ten idle minutes.

### Optional: portable Ollama on Windows

Instead of installing the Ollama desktop application, you can use the included setup script. Run these commands from the project directory, replacing the model name:

```powershell
$env:OLLAMA_MODEL = "your-model:tag"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-ollama.ps1 -Model $env:OLLAMA_MODEL
npm.cmd start
```

The script downloads the official Windows x64 portable runtime, verifies its SHA-256 digest, and stores it in the ignored `tools/ollama` directory. It starts Ollama on loopback with cloud features disabled and stores models in the ignored `data/models` directory. If Ollama already runs on port 11434, the script reuses that service and its model storage; it does not change that service's configuration. Re-run with the same model to resume an interrupted model download. Without `-Model` or `OLLAMA_MODEL`, setup installs and starts only the runtime and downloads no model.

## Configuration

Set these environment variables before starting the studio:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_MODEL` | `qwen3.8:27b-q4_K_M` | Exact installed Ollama model name and tag. |
| `OLLAMA_CONTEXT` | `8192` | Context window requested per generation. Larger values need more memory. |
| `OLLAMA_NUM_GPU` | Ollama's automatic choice | Optional GPU layer offload setting. |
| `PORT` | `4317` | Studio's local HTTP port. The server still binds to `127.0.0.1`. |
| `STUDIO_DATA_DIR` | `data` | Local directory containing `studio.sqlite`. Keep custom data directories outside Git. |

The adapter uses an 8,192-token context by default, disables thinking, reserves up to 4,096 generated tokens, and processes one proposal at a time. It does not automatically choose another model or fall back to a cloud service. Increase context only after measuring available memory.

## Troubleshooting

- **Ollama unavailable:** check that Ollama runs at `127.0.0.1:11434` and that the `/api/tags` command above succeeds. Start the installed Ollama application or run `ollama serve`. For the portable runtime, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-ollama.ps1`.
- **Model not installed or the wrong model appears:** compare `OLLAMA_MODEL` with the exact entry in `ollama list`, including the tag. Stop and restart the studio after changing it; reopening a window reuses the existing server and its settings.
- **Tool calling or output-format errors:** verify that your chosen model supports the features used by the adapter. A successful connection check verifies availability, not generation quality or full model compatibility.
- **Very slow generation or memory errors:** try a smaller compatible local model or a smaller app request, and close other memory-heavy applications. More context consumes more memory. Use the benchmark below to measure your own setup.
- **Context limit reached:** shorten instructions or reduce app/data complexity. Increase `OLLAMA_CONTEXT` only if your model and hardware support it.
- **Browser executable missing:** run `npx.cmd playwright install chromium`, then restart. Always use the protected window for generated apps.

## Use

- **Change app:** describe a calendar, game, utility, redesign, or improvement. Review the proposed app, then Apply. “Improve yourself” creates one proposal; it does not start an autonomous loop.
- **Explore three directions:** produces practical, adventurous and alternative-interaction proposals from the same frozen base. User instructions override those style defaults. Explore each before choosing. All three remain in Saved directions.
- **Take inspiration:** attach up to two saved directions and describe which ideas to combine. **Revisit** adapts a saved app to your current data. Neither action silently swaps incompatible data.
- **Undo:** restores the app and data saved immediately before the previous version transition. It is not an undo for individual edits inside a calendar or game.
- **Reset:** restores the blank original and empty app data. Reset itself is undoable. History, alternatives and AI instructions remain.
- **Like:** saves approval of a version. An optional note identifies what you liked. Undo and Reset record observations with unknown reasons, not inferred dislikes.
- **AI instructions:** uses the prompt field to propose persistent preferences. Review/edit before saving. Working instructions also offers direct editing and loading previous instruction versions. Reset and Undo do not erase them.

Preview edits are temporary. Apply starts from a proposal’s validated data snapshot, not changes made while testing the preview. The active app saves data through the studio. If active data or instructions change after generation starts, a proposal becomes stale; Apply then prepares a fresh adaptation prompt instead of overwriting your work.

Active app data can still be saved while AI instructions are being proposed. Saving those instructions checks the instruction version separately, so unrelated data edits survive. If another studio window changes app data while a generated script holds an old copy, its next save fails visibly; reload that preview to use the newer data.

## Boundaries and data flow

The trusted React shell talks to a loopback Express API with a session cookie, CSRF protection and Host/Origin checks. The API owns SQLite, the model adapter and the generation queue. Generation never executes model-written code in Node.js.

The model returns `title`, `description`, `html`, `css`, `js` and `migrate`. JavaScript runs in an opaque-origin iframe with only `allow-scripts`. It reads and writes JSON through `window.app.readData()` and `window.app.saveData(data)`. The immutable bridge uses a separate MessageChannel for each preview. Only the active preview can persist data; other previews use temporary copies. Data is limited to 2 MB; code and prompt sizes are bounded.

The `migrate` field is the body of a synchronous browser-worker function that receives a copy of the base data and returns the new JSON state. It has a two-second limit. Syntax, migration output, startup errors and responsiveness are checked in headless Chromium. A failed validation permits at most two repairs. This is a startup smoke test, not proof that every generated feature works: review before applying.

Iframe CSP blocks network resources, storage access and nested frames. The controlled Chromium context also aborts requests and navigation from generated frames and workers, including local services. This second layer matters because CSP alone does not reliably prevent a frame from navigating itself. Generated code has no integration or package-installation capability. The browser sandbox is a practical prototype boundary, not an OS sandbox for executing arbitrary native code. Heavy generated code can consume CPU or memory; Stop/Reload and validation timeouts provide recovery.

Activation, Reset and Undo use SQLite transactions so code pointers and data move atomically. Accepted version sources and candidate data snapshots are immutable. Active data lives separately. Undo records exact data at transitions. Restart marks unfinished jobs interrupted and retains completed alternatives.

The AI receives current code/data, working instructions, recent/relevant history and an attributed summary of older events. A bounded `search_history` tool can retrieve older events by text. Context limits are explicit: the studio rejects requests that exceed its conservative budget instead of silently truncating app code or data. Large apps and large JSON datasets may require a larger measured context or a simpler app. Model preferences are prompt instructions, not fine-tuning or a guaranteed learned taste.

## Tests and benchmark

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:browser
npm.cmd run benchmark
```

The benchmark generates one small real app and then three alternatives from the same original. It records model loading, token rate, elapsed time, validation, system RAM and GPU memory in timestamped `data/benchmarks/*-report.json` files. It does not change your studio app or history. `npm.cmd run benchmark -- --single` measures only the first proposal; `--three` measures only three alternatives. Results from the test model are functional tests, not hardware benchmarks. History lookup allows one round of up to three searches, followed by a schema-constrained app response. With no older history, generation goes straight to the structured app response.

The build, unit/API tests and browser tests do not need a running AI model. Browser tests use an in-memory database and fixture model. The benchmark uses the real model selected by `OLLAMA_MODEL`; run it separately from studio generation to avoid competing requests. Benchmark reports contain generated examples and hardware details and remain local.

## Private data and Git

The [`.gitignore`](.gitignore) excludes `data/`, `tools/`, model directories and common model-weight formats, SQLite databases, local environment files, logs, dependencies, build output and test output. Keep downloaded model blobs and personal backups inside ignored directories or outside the repository. Review `git status` before committing files, especially if you change `STUDIO_DATA_DIR`.

Back up the complete `data` directory while the studio is stopped. It contains private prompts, feedback, instructions, app data and saved code. Models can be backed up separately from the much smaller `studio.sqlite` database. The app has no publication feature, and the studio server is not available to other computers on the network. Publishing this source repository does not publish your local studio data or model.
