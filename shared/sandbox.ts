import type { AppCode } from "./types.ts";

const inline = (text: string) => text.replace(/<\//g, "<\\/");
export function sandboxDocument(
  code: AppCode,
  nonce: string,
  token: string,
  mode: "app" | "migration" = "app",
): string {
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  // The immutable bridge is installed before any generated content can execute.
  const bridge = `(() => {
    const token = ${JSON.stringify(token)};
    let port; let sequence = 0; const pending = new Map();
    const send = (type, payload = {}) => { if (port) port.postMessage({ token, type, ...payload }); };
    const request = (type, payload = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('The studio did not respond.')); }, 10000);
      pending.set(id, { resolve, reject, timer }); send(type, { id, ...payload });
    });
    const ready = new Promise(resolve => {
      addEventListener('message', function init(event) {
        if (event.source !== parent || event.data?.type !== 'studio:init' || event.data?.token !== token || !event.ports[0] || port) return;
        port = event.ports[0];
        port.onmessage = event => {
          const msg = event.data; if (msg?.token !== token) return;
          const item = pending.get(msg.id); if (!item) return;
          clearTimeout(item.timer); pending.delete(msg.id);
          if (msg.error) item.reject(new Error(msg.error)); else item.resolve(msg.data);
        };
        port.start(); resolve(); send('ready');
        removeEventListener('message', init);
      });
    });
    Object.defineProperty(window, 'app', { value: Object.freeze({
      ready,
      readData: async () => { await ready; return request('read'); },
      saveData: async data => { await ready; return request('save', { data }); }
    }), writable: false, configurable: false });
    addEventListener('error', event => send('error', { message: String(event.message).slice(0, 500) }));
    addEventListener('unhandledrejection', event => send('error', { message: String(event.reason).slice(0, 500) }));
    setInterval(() => send('heartbeat'), 1000);
    if (${JSON.stringify(mode)} === 'migration') {
      ready.then(() => {
        const source = ${JSON.stringify(`self.onmessage = event => { try { const migrate = function(data) {\n${code.migrate}\n}; const result = migrate(event.data); if (result && typeof result.then === 'function') throw new Error('Migration must be synchronous.'); self.postMessage({ ok: true, data: result }); } catch(error) { self.postMessage({ ok: false, error: String(error.message || error) }); } };`)};
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const worker = new Worker(url); const timer = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(url); send('migration:error', { message: 'Data transformation exceeded 2 seconds.' }); }, 2000);
        worker.onmessage = event => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); const result = event.data; if(result.ok) send('migration:result', { data: result.data }); else send('migration:error', { message: result.error }); };
        worker.onerror = event => { clearTimeout(timer); worker.terminate(); send('migration:error', { message: event.message }); };
        request('read').then(data => worker.postMessage(data)).catch(error => send('migration:error', { message: error.message }));
      });
    }
  })();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><script nonce="${nonce}">${inline(bridge)}</script><style>${inline(code.css)}</style></head><body>${mode === "app" ? code.html : ""}${mode === "app" ? `<script nonce="${nonce}">window.app.ready.then(async () => {\n${inline(code.js)}\n}).catch(error => { throw error; });</script>` : ""}</body></html>`;
}
