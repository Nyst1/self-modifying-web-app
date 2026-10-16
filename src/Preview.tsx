import { useEffect, useMemo, useRef, useState } from "react";
import { sandboxDocument } from "../shared/sandbox";
import type { Json, Version } from "../shared/types";

interface Props {
  version: Version;
  active?: boolean;
  onSave?: (data: Json, previousData: Json) => Promise<void>;
  onRuntimeError?: (message: string) => void;
}
export function Preview({
  version,
  active = false,
  onSave,
  onRuntimeError,
}: Props) {
  const frame = useRef<HTMLIFrameElement>(null),
    port = useRef<MessagePort | null>(null);
  const data = useRef(version.data),
    previousData = useRef(version.data),
    save = useRef(onSave),
    runtimeError = useRef(onRuntimeError);
  save.current = onSave;
  runtimeError.current = onRuntimeError;
  const [error, setError] = useState(""),
    [stopped, setStopped] = useState(false),
    [run, setRun] = useState(0);
  const heartbeat = useRef(Date.now());
  const credentials = useMemo(
    () => ({
      token: crypto.randomUUID(),
      nonce: crypto.randomUUID().replaceAll("-", ""),
    }),
    [version.id, run],
  );
  const document = useMemo(
    () => sandboxDocument(version.code, credentials.nonce, credentials.token),
    [version.id, credentials],
  );
  useEffect(() => {
    if (active) data.current = version.data;
  }, [version.data, active]);
  useEffect(() => {
    heartbeat.current = Date.now();
    setError("");
    const timer = setInterval(() => {
      if (!stopped && Date.now() - heartbeat.current > 6000) {
        setError("This app stopped responding. Stop or reload its preview.");
      }
    }, 1500);
    return () => {
      clearInterval(timer);
      port.current?.close();
      port.current = null;
    };
  }, [version.id, run, stopped]);
  function connect() {
    data.current = structuredClone(version.data);
    previousData.current = structuredClone(version.data);
    port.current?.close();
    const channel = new MessageChannel();
    port.current = channel.port1;
    heartbeat.current = Date.now();
    // Serial processing prevents simultaneous saves from racing each other.
    let chain = Promise.resolve();
    let messages = 0,
      bucket = Date.now();
    channel.port1.onmessage = (event) => {
      const msg = event.data;
      if (
        !msg ||
        msg.token !== credentials.token ||
        typeof msg.type !== "string"
      )
        return;
      if (Date.now() - bucket > 1000) {
        bucket = Date.now();
        messages = 0;
      }
      if (++messages > 80) {
        setError("This app sent too many messages. Preview stopped.");
        setStopped(true);
        channel.port1.close();
        return;
      }
      if (msg.type === "heartbeat" || msg.type === "ready") {
        heartbeat.current = Date.now();
        return;
      }
      if (msg.type === "error") {
        const message = String(msg.message).slice(0, 500);
        setError(message);
        runtimeError.current?.(message);
        return;
      }
      if (!["read", "save"].includes(msg.type) || !Number.isSafeInteger(msg.id))
        return;
      chain = chain.then(async () => {
        try {
          if (msg.type === "save") {
            if (JSON.stringify(msg.data).length > 2_000_000)
              throw new Error("App data exceeds the 2 MB limit.");
            if (active) await save.current?.(msg.data, previousData.current);
            data.current = structuredClone(msg.data);
            previousData.current = structuredClone(msg.data);
          }
          if (msg.type === "read")
            previousData.current = structuredClone(data.current);
          channel.port1.postMessage({
            token: credentials.token,
            id: msg.id,
            data: msg.type === "read" ? data.current : true,
          });
        } catch (error) {
          channel.port1.postMessage({
            token: credentials.token,
            id: msg.id,
            error: (error as Error).message,
          });
        }
      });
    };
    frame.current?.contentWindow?.postMessage(
      { type: "studio:init", token: credentials.token },
      "*",
      [channel.port2],
    );
  }
  return (
    <div className="preview-wrap">
      {error && (
        <div className="preview-error" role="alert">
          {error}
        </div>
      )}
      <div className="preview-tools">
        <button
          onClick={() => {
            setStopped(false);
            setRun((n) => n + 1);
          }}
          title="Reload only the preview"
        >
          ↻ Reload
        </button>
        <button
          onClick={() => {
            port.current?.close();
            setStopped(true);
          }}
          disabled={stopped}
        >
          ■ Stop
        </button>
      </div>
      {stopped ? (
        <div className="stopped">
          <p>Preview stopped.</p>
          <button
            onClick={() => {
              setStopped(false);
              setRun((n) => n + 1);
            }}
          >
            Reload preview
          </button>
        </div>
      ) : (
        <iframe
          key={`${version.id}-${run}`}
          ref={frame}
          title={version.code.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={document}
          onLoad={connect}
        />
      )}
    </div>
  );
}
