import { HUB_LIMITS } from "@mex/hub-contracts";
import { invalidRequest } from "./errors.js";

export async function readBoundedJson(
  request: Request,
  maximumBytes: number = HUB_LIMITS.maxMutationBodyBytes,
): Promise<unknown> {
  const limitDescription = maximumBytes === HUB_LIMITS.maxMutationBodyBytes ? "64 KiB" : `${maximumBytes} byte`;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw invalidRequest("Mutations require an application/json request body.");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw invalidRequest("The Content-Length header is invalid.");
    }
    if (Number(contentLength) > maximumBytes) {
      throw invalidRequest(`The request body exceeds the ${limitDescription} limit.`);
    }
  }

  if (request.body === null) {
    throw invalidRequest("A JSON request body is required.");
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        throw invalidRequest(`The request body exceeds the ${limitDescription} limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidRequest("The JSON request body must be valid UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidRequest("The request body is not valid JSON.");
  }
}

export function readStrictQuery(
  request: Request,
  allowedKeys: readonly string[],
): Record<string, string> {
  const allowed = new Set(allowedKeys);
  const result: Record<string, string> = {};
  const search = new URL(request.url).search;
  if (Buffer.byteLength(search, "utf8") > HUB_LIMITS.maxQueryStringBytes) {
    throw invalidRequest("The encoded query string exceeds the 16 KiB limit.");
  }
  const parameters = new URLSearchParams(search);
  for (const [key, value] of parameters) {
    if (!allowed.has(key)) {
      throw invalidRequest(`Unknown query parameter: ${key}.`);
    }
    if (Object.hasOwn(result, key)) {
      throw invalidRequest(`Query parameter ${key} may appear only once.`);
    }
    result[key] = value;
  }
  return result;
}
