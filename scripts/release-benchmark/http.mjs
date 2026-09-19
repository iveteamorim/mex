const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

/** The deadline covers connection, headers, and body consumption. */
export async function requestJson(url, init = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 180_000) {
    throw new Error("Benchmark HTTP timeout must be within 1–180000 milliseconds.");
  }
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Benchmark HTTP request exceeded ${Math.ceil(timeoutMs)} ms.`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([expired, (async () => {
      const response = await fetch(url, { ...init, signal, redirect: "error" });
      if (!response.body) throw new Error("Benchmark HTTP response omitted its JSON body.");
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            controller.abort();
            throw new Error(`Benchmark HTTP response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      return { response, body: JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) };
    })()]);
  } finally {
    clearTimeout(timer);
  }
}
