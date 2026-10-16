const model = process.argv[2] || process.env.OLLAMA_MODEL || 'qwen3.8:27b-q4_K_M';
const response = await fetch('http://127.0.0.1:11434/api/pull', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, stream: true })
});
if (!response.ok || !response.body) throw new Error(`Ollama download failed: ${response.status}`);
const decoder = new TextDecoder(); let pending = '', last = 0, success = false;
for await (const part of response.body) {
  pending += decoder.decode(part, { stream: true });
  const lines = pending.split('\n'); pending = lines.pop();
  for (const line of lines) {
    if (!line) continue;
    const progress = JSON.parse(line);
    if (progress.error) throw new Error(progress.error);
    if (progress.status === 'success') success = true;
    if (Date.now() - last > 10000 || progress.status === 'success') {
      last = Date.now();
      console.log(progress.total ? `${progress.status}: ${(100 * (progress.completed || 0) / progress.total).toFixed(1)}%` : progress.status);
    }
  }
}
if (!success) throw new Error('The download ended without verification. Re-run setup to resume.');
