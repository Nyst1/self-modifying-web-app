import { useEffect, useRef, useState } from "react";
import type { Event, Job, Json, StudioState, Version } from "../shared/types";
import { api, bootstrap } from "./api";
import { Preview } from "./Preview";

interface Diagnostics {
  online: boolean;
  installed: boolean;
  model: string;
  context: number;
  message: string;
  models: { name: string; size: number }[];
  running?: unknown;
}
const running = (job: Job | null) =>
  !!job && ["queued", "generating", "validating"].includes(job.status);
const date = (value: string) =>
  new Date(value).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
const elapsed = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const eventLabels: Record<string, string> = {
  prompt: "Change requested",
  selected: "Version applied",
  reset: "Reset to original",
  undo: "Previous version restored",
  thumbs_up: "Liked",
  instructions_saved: "Instructions saved",
  instruction_request: "Instruction change requested",
  instruction_proposal: "Instructions proposed",
  proposal_created: "Proposal created",
  generation_error: "Repair needed",
  generation_failed: "Generation failed",
  generation_cancelled: "Generation cancelled",
  generation_interrupted: "Interrupted by restart",
};

export function Studio() {
  const [state, setState] = useState<StudioState | null>(null),
    stateRef = useRef<StudioState | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"app" | "instructions">("app"),
    [count, setCount] = useState<1 | 3>(1);
  const [busy, setBusy] = useState(false),
    [instructionBusy, setInstructionBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null),
    [showSetup, setShowSetup] = useState(false);
  const [panel, setPanel] = useState<
    "history" | "versions" | "instructions" | null
  >(null);
  const [proposalIds, setProposalIds] = useState<string[]>([]),
    [inspect, setInspect] = useState<Version | null>(null);
  const [inspirationIds, setInspirationIds] = useState<string[]>([]),
    [confirmReset, setConfirmReset] = useState(false);
  const [instructionDraft, setInstructionDraft] = useState<{
    text: string;
    revision: number;
    instructionId: string;
  } | null>(null);
  const [instructionEditBaseId, setInstructionEditBaseId] = useState("");
  const [instructionText, setInstructionText] = useState(""),
    [history, setHistory] = useState<Event[]>([]),
    [search, setSearch] = useState("");
  const [feedback, setFeedback] = useState<Version | null>(null),
    [feedbackNote, setFeedbackNote] = useState("");
  const [clock, setClock] = useState(Date.now());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const protectedBrowser = !!(
    window as unknown as { __studioProtected?: boolean }
  ).__studioProtected;

  function applyState(next: StudioState) {
    if (stateRef.current && next.revision < stateRef.current.revision) return;
    stateRef.current = next;
    setState(next);
  }
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.current.then(task);
    queue.current = result.catch(() => {});
    return result;
  }
  async function refresh() {
    applyState(await api<StudioState>("state"));
  }
  async function health() {
    setDiagnostics(await api<Diagnostics>("diagnostics"));
  }
  useEffect(() => {
    if (!protectedBrowser) return;
    let disposed = false;
    bootstrap()
      .then((s) => {
        if (!disposed) {
          applyState(s);
          setInstructionEditBaseId(s.currentInstructionId);
          setInstructionText(
            s.instructions.find((i) => i.id === s.currentInstructionId)?.text ??
              "",
          );
          if (s.job?.versionIds.length) setProposalIds(s.job.versionIds);
          void health().catch((e) => setError(e.message));
        }
      })
      .catch((e) => setError(e.message));
    const timer = setInterval(() => {
      if (stateRef.current) void refresh().catch((e) => setError(e.message));
      setClock(Date.now());
    }, 1200);
    const healthTimer = setInterval(() => {
      if (stateRef.current) void health().catch(() => {});
    }, 30000);
    return () => {
      disposed = true;
      clearInterval(timer);
      clearInterval(healthTimer);
    };
  }, [protectedBrowser]);
  useEffect(() => {
    if (state?.job?.versionIds.length) setProposalIds(state.job.versionIds);
  }, [state?.job?.versionIds.join(",")]);
  useEffect(() => {
    if (panel === "history")
      api<Event[]>(`history?q=${encodeURIComponent(search)}`)
        .then(setHistory)
        .catch((e) => setError(e.message));
  }, [panel, search, state?.events[0]?.id]);

  async function action(fn: () => Promise<void>, serializeOperation = true) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (serializeOperation) await serialize(fn);
      else {
        await queue.current;
        await fn();
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveData(data: Json, versionId: string, previousData: Json) {
    await serialize(async () => {
      const current = stateRef.current!;
      if (current.active.id !== versionId)
        throw new Error("This preview is no longer the active app.");
      if (JSON.stringify(current.active.data) !== JSON.stringify(previousData))
        throw new Error(
          "App data changed in another window. Reload this preview before saving.",
        );
      const result = await api<{ revision: number }>("data", {
        id: current.active.id,
        data,
        revision: current.revision,
      });
      applyState({
        ...stateRef.current!,
        active: { ...current.active, data },
        revision: result.revision,
      });
    });
  }
  function generate() {
    if (!prompt.trim()) return;
    void action(async () => {
      if (mode === "instructions") {
        setInstructionBusy(true);
        try {
          const result = await api<{
            text: string;
            revision: number;
            instructionId: string;
          }>("instructions/propose", {
            request: prompt,
            revision: stateRef.current!.revision,
          });
          setInstructionDraft(result);
        } finally {
          setInstructionBusy(false);
        }
      } else {
        const job = await api<Job>("generate", {
          prompt,
          count,
          revision: stateRef.current!.revision,
          inspirationIds,
        });
        setProposalIds([]);
        applyState({ ...stateRef.current!, job });
        setInspirationIds([]);
      }
    }, mode !== "instructions");
  }
  function activate(version: Version) {
    if (version.baseRevision !== stateRef.current!.revision) {
      revisit(version);
      setNotice(
        "The app has changed since this proposal was created. Create a fresh proposal to adapt it to your current data.",
      );
      return;
    }
    void action(async () => {
      applyState(
        await api<StudioState>("activate", {
          id: version.id,
          revision: stateRef.current!.revision,
        }),
      );
      setInspect(null);
      setProposalIds([]);
      setNotice(
        `Applied “${version.code.title}”. Your previous app is available through Undo.`,
      );
    });
  }
  function inspire(version: Version) {
    setInspirationIds((ids) =>
      ids.includes(version.id)
        ? ids.filter((id) => id !== version.id)
        : [...ids.filter((id) => id !== version.id), version.id].slice(-2),
    );
    setMode("app");
    setNotice("Describe which part you want to bring into your current app.");
  }
  function revisit(version: Version) {
    setInspirationIds([version.id]);
    setPrompt(
      `Adapt the saved proposal “${version.code.title}” to my current app and data. Preserve its defining ideas.`,
    );
    setMode("app");
    setPanel(null);
    setInspect(null);
  }
  function openInstructions() {
    setInstructionEditBaseId(stateRef.current!.currentInstructionId);
    setInstructionText(
      stateRef.current?.instructions.find(
        (i) => i.id === stateRef.current?.currentInstructionId,
      )?.text ?? "",
    );
    setPanel("instructions");
  }
  if (!protectedBrowser)
    return (
      <div className="launch-gate">
        <div className="brand-mark">e</div>
        <h1>Open your protected studio</h1>
        <p>
          Start the app with <code>Start Studio.cmd</code> or{" "}
          <code>npm.cmd run dev</code>.
        </p>
        <p>
          The studio opens its own Chromium window so generated apps cannot
          access the network.
        </p>
        <p className="muted">
          This ordinary browser window does not run generated code.
        </p>
      </div>
    );
  if (!state)
    return (
      <div className="launch-gate">
        <div className="brand-mark">e</div>
        <h1>Opening your studio…</h1>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  const job = state.job,
    generating = running(job),
    pending = busy || generating;
  const proposals = proposalIds
    .map((id) => state.versions.find((v) => v.id === id))
    .filter((v): v is Version => !!v);
  const instructions =
    state.instructions.find((i) => i.id === state.currentInstructionId)?.text ??
    "";
  const liked = state.events.some(
    (e) => e.type === "thumbs_up" && e.versionId === state.active.id,
  );
  const jobElapsed =
    generating && job
      ? clock - new Date(job.startedAt).getTime()
      : (job?.elapsedMs ?? 0);

  return (
    <div className="studio">
      <header className="header">
        <div className="brand">
          <div className="brand-mark">e</div>
          <div>
            evolution<span>LOCAL APP STUDIO</span>
          </div>
        </div>
        <div className="header-right">
          <button
            className={`model-chip ${diagnostics?.online && diagnostics.installed ? "online" : ""}`}
            onClick={() => setShowSetup(!showSetup)}
          >
            <span className="status-dot" />
            {diagnostics?.model || "Local AI"}<span className="chevron">⌄</span>
          </button>
          <span className="local-label">
            <span>◉</span> On this computer
          </span>
        </div>
      </header>
      {showSetup && (
        <section className="diagnostics">
          <div>
            <h2>Local model connection</h2>
            <p>{diagnostics?.message || "Checking Ollama…"}</p>
            <p>
              <code>{diagnostics?.model || "Checking model…"}</code> ·{" "}
              {diagnostics?.context || 8192} token context · one request at a
              time
            </p>
            {diagnostics?.model && !diagnostics.installed && (
              <p>
                Install Ollama, then run{" "}
                <code>ollama pull {diagnostics.model}</code>.
              </p>
            )}
            <p className="muted">
              Speed depends on your model and available GPU and system memory.
              Generation can take several minutes.
            </p>
          </div>
          <button
            onClick={() => void health().catch((e) => setError(e.message))}
          >
            Check connection
          </button>
        </section>
      )}
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-top">
            <p className="eyebrow">A WORK IN PROGRESS</p>
            <h1>
              Make it
              <br />
              <em>your own.</em>
            </h1>
            <p className="intro">
              Describe what comes next.
              <br />
              Your app grows with you.
            </p>
          </div>
          <div className="mode-switch" role="group" aria-label="Prompt mode">
            <button
              className={mode === "app" ? "selected" : ""}
              onClick={() => setMode("app")}
            >
              Change app
            </button>
            <button
              className={mode === "instructions" ? "selected" : ""}
              onClick={() => setMode("instructions")}
            >
              AI instructions
            </button>
          </div>
          <label className="prompt-label" htmlFor="prompt">
            {mode === "app"
              ? "What would you like to change?"
              : "How should your AI work?"}
          </label>
          <div className="prompt-box">
            <textarea
              id="prompt"
              value={prompt}
              maxLength={mode === "app" ? 4000 : 2000}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                mode === "app"
                  ? "Build something useful, playful, or a little unexpected…"
                  : "I want your proposals to be more adventurous…"
              }
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !pending)
                  generate();
              }}
            />
            <div className="prompt-footer">
              <span>
                {mode === "app"
                  ? "Ideas become working apps"
                  : "Saved preferences guide future proposals"}
              </span>
              <span>⌘ ↵</span>
            </div>
          </div>
          {!!inspirationIds.length && (
            <div className="inspirations">
              <span>Taking inspiration from</span>
              {inspirationIds.map((id) => (
                <button
                  key={id}
                  onClick={() =>
                    setInspirationIds((ids) =>
                      ids.filter((value) => value !== id),
                    )
                  }
                >
                  {state.versions.find((v) => v.id === id)?.code.title || id} ×
                </button>
              ))}
            </div>
          )}
          {mode === "app" && (
            <div className="variant-option">
              <div>
                <span>Explore three directions</span>
                <small>Compare, choose, combine.</small>
              </div>
              <button
                className={`toggle ${count === 3 ? "on" : ""}`}
                role="switch"
                aria-checked={count === 3}
                aria-label="Explore three directions"
                onClick={() => setCount(count === 1 ? 3 : 1)}
              >
                <span />
              </button>
            </div>
          )}
          <button
            className="generate-button"
            disabled={pending || !prompt.trim()}
            onClick={generate}
          >
            <span>
              {pending
                ? "Working locally…"
                : mode === "app"
                  ? count === 3
                    ? "Explore 3 directions"
                    : "Create a proposal"
                  : "Propose instructions"}
            </span>
            <span>{pending ? "◌" : "↗"}</span>
          </button>
          {pending && (
            <button
              className="cancel-button"
              onClick={() =>
                void api("cancel", {}).catch((e) => setError(e.message))
              }
            >
              Cancel generation
            </button>
          )}
          {!pending && !prompt && (
            <div className="suggestions">
              <span>A starting point, perhaps</span>
              {[
                "Make a simple calendar",
                "Invent a small game",
                "Surprise me with something delightful",
              ].map((text) => (
                <button
                  key={text}
                  onClick={() => {
                    setMode("app");
                    setPrompt(text);
                  }}
                >
                  {text}
                  <span>↗</span>
                </button>
              ))}
            </div>
          )}
          <div className="sidebar-bottom">
            <button onClick={() => setPanel("history")}>
              <span>◷</span> History{" "}
              <small>
                {state.events.length === 100 ? "100+" : state.events.length}
              </small>
            </button>
            <button onClick={() => setPanel("versions")}>
              <span>▧</span> Saved directions{" "}
              <small>{state.versions.length - 1}</small>
            </button>
            <button onClick={openInstructions}>
              <span>☷</span> Working instructions
            </button>
            <p>
              <span className="tiny-dot" /> Your ideas stay on this computer.
            </p>
          </div>
        </aside>
        <main className="main">
          <div className="canvas-heading">
            <div className="canvas-title">
              <span className="eyebrow">YOUR APP</span>
              <h2>
                {state.active.code.title}
                <span className="version-badge">
                  {state.active.id === "original" ? "Original" : "Current"}
                </span>
              </h2>
            </div>
            <div className="canvas-actions">
              <button
                title="Like this version"
                aria-label="Like this version"
                className={liked ? "liked" : ""}
                onClick={() => {
                  setFeedback(state.active);
                  setFeedbackNote("");
                }}
              >
                ♡<span>{liked ? "Liked" : "Like"}</span>
              </button>
              <span className="divider" />
              <button
                aria-label="Undo"
                disabled={!state.canUndo || busy}
                onClick={() =>
                  void action(async () => {
                    applyState(
                      await api<StudioState>("undo", {
                        revision: stateRef.current!.revision,
                      }),
                    );
                    setNotice("Restored the previous app and its saved data.");
                  })
                }
              >
                ↶<span>Undo</span>
              </button>
              <button
                aria-label="Reset"
                disabled={busy}
                onClick={() => setConfirmReset(true)}
              >
                ↺<span>Reset</span>
              </button>
            </div>
          </div>
          <div className="canvas">
            <div className="browser-bar">
              <div className="window-dots">
                <i />
                <i />
                <i />
              </div>
              <span>◉ &nbsp; local / your-app</span>
              <span className="sandbox-label">Protected preview</span>
            </div>
            <Preview
              key={state.active.id}
              version={state.active}
              active
              onSave={(data, previousData) =>
                saveData(data, state.active.id, previousData)
              }
            />
          </div>
          <div className="canvas-caption">
            <span>✦ &nbsp; A canvas that changes. A home for your ideas.</span>
            <span>Your previous versions stay within reach.</span>
          </div>
          {error && (
            <div className="message error" role="alert">
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="message notice" role="status">
              <span>{notice}</span>
              <button onClick={() => setNotice("")} aria-label="Dismiss notice">
                ×
              </button>
            </div>
          )}
          {job &&
            (generating ||
              job.status === "failed" ||
              job.status === "cancelled") && (
              <div
                className={`job-card ${job.status === "failed" ? "failure" : ""}`}
                role="status"
              >
                <div className={generating ? "spinner" : "job-symbol"}>
                  {generating ? "" : "·"}
                </div>
                <div>
                  <strong>{job.message}</strong>
                  <p>
                    {job.error ||
                      (generating
                        ? "The current app stays available. Each proposal has its own data snapshot."
                        : "Saved proposals remain in Saved directions.")}
                  </p>
                </div>
                <span className="job-time">
                  {elapsed(jobElapsed)}
                  {job.tokensPerSecond && (
                    <small>{job.tokensPerSecond.toFixed(1)} tokens/s</small>
                  )}
                </span>
              </div>
            )}
          {instructionBusy && (
            <div className="job-card">
              <div className="spinner" />
              <div>
                <strong>Rethinking your working instructions…</strong>
                <p>You will review and save them before anything changes.</p>
              </div>
            </div>
          )}
          {!!proposals.length && (
            <section className="proposal-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">POSSIBLE NEXT CHAPTERS</p>
                  <h2>
                    {proposals.length === 1
                      ? "A new direction"
                      : "Which direction feels like you?"}
                  </h2>
                </div>
                <button
                  className="text-button"
                  onClick={() => setProposalIds([])}
                >
                  Hide proposals
                </button>
              </div>
              <div
                className={`proposal-grid ${proposals.length === 1 ? "single" : ""}`}
              >
                {proposals.map((version) => (
                  <article className="proposal-card" key={version.id}>
                    <div className="proposal-mini">
                      <Preview version={version} />
                    </div>
                    <div className="proposal-info">
                      <span className="eyebrow">
                        DIRECTION {String(version.variant).padStart(2, "0")}
                      </span>
                      <h3>{version.code.title}</h3>
                      <p>{version.code.description}</p>
                      <div className="proposal-actions">
                        <button onClick={() => setInspect(version)}>
                          Explore
                        </button>
                        <button
                          className="primary"
                          disabled={busy || generating}
                          onClick={() => activate(version)}
                        >
                          {version.baseRevision === state.revision
                            ? "Apply"
                            : "Apply (needs refresh)"}
                        </button>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => inspire(version)}
                      >
                        {inspirationIds.includes(version.id)
                          ? "✓ Inspiration added"
                          : "+ Take inspiration"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              <p className="proposal-note">
                All directions are saved. Preview edits are temporary; applying
                starts from the proposal’s validated data.
              </p>
            </section>
          )}
        </main>
      </div>
      {panel && (
        <div className="drawer-shade" onClick={() => setPanel(null)}>
          <aside
            className="drawer"
            onClick={(e) => e.stopPropagation()}
            aria-label={panel}
          >
            <div className="drawer-heading">
              <h2>
                {panel === "history"
                  ? "Your app’s story"
                  : panel === "versions"
                    ? "Saved directions"
                    : "Working instructions"}
              </h2>
              <button onClick={() => setPanel(null)} aria-label="Close panel">
                ×
              </button>
            </div>
            {panel === "history" && (
              <>
                <p className="muted">
                  Requests, choices and reactions. Undo and Reset record what
                  happened, without guessing why.
                </p>
                <input
                  className="search"
                  aria-label="Search history"
                  placeholder="Search your history…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="timeline">
                  {history.map((event) => (
                    <article key={event.id}>
                      <div className="timeline-dot" />
                      <small>
                        #{event.id} · {date(event.createdAt)}
                      </small>
                      <h3>{eventLabels[event.type] || event.type}</h3>
                      <p>
                        {String(
                          event.payload.prompt ||
                            event.payload.request ||
                            event.payload.note ||
                            event.payload.title ||
                            event.payload.message ||
                            event.payload.text ||
                            event.payload.error ||
                            "",
                        )}
                      </p>
                      {event.versionId && (
                        <span className="event-version">
                          {state.versions.find((v) => v.id === event.versionId)
                            ?.code.title || event.versionId}
                        </span>
                      )}
                    </article>
                  ))}
                </div>
                {history.length > 0 && !search && (
                  <button
                    onClick={() =>
                      void api<Event[]>(
                        `history?before=${history[history.length - 1].id}`,
                      )
                        .then((items) => {
                          if (items.length)
                            setHistory((old) => [...old, ...items]);
                          else
                            setNotice(
                              "You have reached the beginning of the history.",
                            );
                        })
                        .catch((e) => setError(e.message))
                    }
                  >
                    Load older events
                  </button>
                )}
              </>
            )}
            {panel === "versions" && (
              <>
                <p className="muted">
                  Keep the roads you didn’t take. Revisit one, or bring a detail
                  into your current app.
                </p>
                {state.versions.filter((v) => v.id !== "original").length ===
                  0 && (
                  <div className="empty-panel">
                    Your first proposal will appear here.
                  </div>
                )}
                {state.versions
                  .filter((v) => v.id !== "original")
                  .map((version) => (
                    <article className="saved-version" key={version.id}>
                      <small>
                        {date(version.createdAt)} · Direction {version.variant}
                      </small>
                      <h3>{version.code.title}</h3>
                      <p>{version.code.description}</p>
                      <div className="saved-actions">
                        <button
                          onClick={() => {
                            setInspect(version);
                            setPanel(null);
                          }}
                        >
                          Explore
                        </button>
                        <button
                          onClick={() => {
                            inspire(version);
                            setPanel(null);
                          }}
                        >
                          Take inspiration
                        </button>
                        <button onClick={() => revisit(version)}>
                          Revisit
                        </button>
                      </div>
                    </article>
                  ))}
              </>
            )}
            {panel === "instructions" && (
              <>
                <p className="muted">
                  These preferences guide the AI’s next proposals. They survive
                  Undo and Reset.
                </p>
                <label htmlFor="instruction-edit" className="prompt-label">
                  Current working instructions
                </label>
                <textarea
                  id="instruction-edit"
                  className="instruction-edit"
                  value={instructionText}
                  maxLength={4000}
                  onChange={(e) => setInstructionText(e.target.value)}
                />
                <button
                  className="primary"
                  disabled={busy || !instructionText.trim()}
                  onClick={() =>
                    void action(async () => {
                      const next = await api<StudioState>("instructions/save", {
                        text: instructionText,
                        revision: stateRef.current!.revision,
                        instructionId: instructionEditBaseId,
                      });
                      applyState(next);
                      setInstructionEditBaseId(next.currentInstructionId);
                      setNotice("Working instructions saved.");
                    })
                  }
                >
                  Save instructions
                </button>
                <h3 className="past-heading">Previous instructions</h3>
                {state.instructions
                  .filter((item) => item.id !== state.currentInstructionId)
                  .map((item) => (
                    <article className="instruction-history" key={item.id}>
                      <small>{date(item.createdAt)}</small>
                      <p>{item.text}</p>
                      <button onClick={() => setInstructionText(item.text)}>
                        Load into editor
                      </button>
                    </article>
                  ))}
              </>
            )}
          </aside>
        </div>
      )}
      {inspect && (
        <div className="modal-shade">
          <section
            className="inspect-modal"
            role="dialog"
            aria-modal="true"
            aria-label={inspect.code.title}
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">SAVED DIRECTION {inspect.variant}</p>
                <h2>{inspect.code.title}</h2>
              </div>
              <button
                aria-label="Close preview"
                onClick={() => setInspect(null)}
              >
                ×
              </button>
            </div>
            <div className="inspect-preview">
              <Preview key={inspect.id} version={inspect} />
            </div>
            <div className="inspect-footer">
              <p>{inspect.validation}</p>
              <div>
                <button
                  onClick={() => {
                    inspire(inspect);
                    setInspect(null);
                  }}
                >
                  Take inspiration
                </button>
                <button onClick={() => revisit(inspect)}>Revisit</button>
                <button
                  className="primary"
                  disabled={busy || generating}
                  onClick={() => activate(inspect)}
                >
                  Apply this version
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
      {confirmReset && (
        <div className="modal-shade">
          <section
            className="small-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-title"
          >
            <span className="modal-symbol">↺</span>
            <h2 id="reset-title">A fresh beginning?</h2>
            <p>
              Reset restores the original blank canvas and its empty data. Your
              history, directions and AI instructions stay saved. You can Undo
              this reset.
            </p>
            <div className="modal-actions">
              <button onClick={() => setConfirmReset(false)}>
                Keep working
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    applyState(
                      await api<StudioState>("reset", {
                        revision: stateRef.current!.revision,
                      }),
                    );
                    setConfirmReset(false);
                    setNotice(
                      "Back to the original canvas. Undo restores the app you left.",
                    );
                  })
                }
              >
                Reset to original
              </button>
            </div>
          </section>
        </div>
      )}
      {instructionDraft && (
        <div className="modal-shade">
          <section
            className="small-modal wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="draft-title"
          >
            <p className="eyebrow">A CHANGE IN APPROACH</p>
            <h2 id="draft-title">Review your AI instructions</h2>
            <label className="prompt-label">Before</label>
            <p className="before-instructions">{instructions}</p>
            <label className="prompt-label" htmlFor="draft-instructions">
              Proposed instructions · editable
            </label>
            <textarea
              id="draft-instructions"
              className="instruction-edit"
              maxLength={4000}
              value={instructionDraft.text}
              onChange={(e) =>
                setInstructionDraft({
                  ...instructionDraft,
                  text: e.target.value,
                })
              }
            />
            <div className="modal-actions">
              <button onClick={() => setInstructionDraft(null)}>Discard</button>
              <button
                className="primary"
                disabled={busy || !instructionDraft.text.trim()}
                onClick={() =>
                  void action(async () => {
                    applyState(
                      await api<StudioState>(
                        "instructions/save",
                        instructionDraft,
                      ),
                    );
                    setInstructionDraft(null);
                    setNotice(
                      "Your AI will use these instructions for future proposals.",
                    );
                  })
                }
              >
                Save instructions
              </button>
            </div>
          </section>
        </div>
      )}
      {feedback && (
        <div className="modal-shade">
          <section
            className="small-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="like-title"
          >
            <span className="modal-symbol">♡</span>
            <h2 id="like-title">What feels right?</h2>
            <p>
              A like helps the AI understand your taste. An optional note tells
              it which part to carry forward.
            </p>
            <textarea
              className="feedback-note"
              aria-label="Optional feedback note"
              value={feedbackNote}
              maxLength={1000}
              onChange={(e) => setFeedbackNote(e.target.value)}
              placeholder="The calm colours, the way it works…"
            />
            <div className="modal-actions">
              <button onClick={() => setFeedback(null)}>Cancel</button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    applyState(
                      await api<StudioState>("feedback", {
                        id: feedback.id,
                        note: feedbackNote,
                      }),
                    );
                    setFeedback(null);
                    setNotice("Saved your feedback for future proposals.");
                  })
                }
              >
                Save like
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
