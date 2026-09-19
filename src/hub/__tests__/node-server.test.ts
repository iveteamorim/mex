import { Hono } from "hono";
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { isSafeRawRequestTarget, startHubNodeServer } from "../node-server.js";

describe("startHubNodeServer", () => {
  it("rejects raw, encoded, nested, and backslash traversal before URL normalization", () => {
    expect(isSafeRawRequestTarget("/health")).toBe(true);
    expect(isSafeRawRequestTarget("/search?q=../allowed-query")).toBe(true);
    for (const target of [
      "/../secret",
      "/%2e%2e/secret",
      "/%252e%252e/secret",
      "/safe\\..\\secret",
      "/%5csecret",
      "/%255csecret",
      "//example.test/secret",
      "http://example.test/secret",
    ]) {
      expect(isSafeRawRequestTarget(target), target).toBe(false);
    }
  });

  it("binds only IPv4 loopback and closes cleanly", async () => {
    const app = new Hono().get("/", (context) => context.text("ready"));
    const server = await startHubNodeServer({ app });
    try {
      expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
      const response = await fetch(server.origin);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ready");
      const traversal = await rawRequest(server.port, "/%2e%2e/secret");
      expect(traversal).toContain("HTTP/1.1 400 Bad Request");
      expect(traversal).toContain('"code":"INVALID_REQUEST"');
    } finally {
      await server.close();
    }
  });

  it("serves a replacement app on the same listener", async () => {
    const app = new Hono().get("/", (context) => context.text("setup"));
    const server = await startHubNodeServer({ app });
    try {
      expect(await (await fetch(server.origin)).text()).toBe("setup");
      server.replaceApp(new Hono().get("/", (context) => context.text("hub")));
      expect(await (await fetch(server.origin)).text()).toBe("hub");
    } finally {
      await server.close();
    }
  });

  it("rejects invalid explicit ports before opening a listener", async () => {
    const app = new Hono();
    await expect(startHubNodeServer({ app, port: 65_536 })).rejects.toThrow(/Hub port/);
  });
});

function rawRequest(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.setTimeout(2_000, () => socket.destroy(new Error("raw request timed out")));
    socket.once("connect", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
