import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openHubBrowser } from "../browser.js";

describe("openHubBrowser", () => {
  it.each([
    ["darwin", "open", ["http://127.0.0.1:4317/#token"]],
    ["linux", "xdg-open", ["http://127.0.0.1:4317/#token"]],
    [
      "win32",
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", "http://127.0.0.1:4317/#token"],
    ],
  ] as const)("uses fixed argv on %s", (currentPlatform, expectedCommand, expectedArgs) => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawnProcess = vi.fn(() => child) as never;

    openHubBrowser("http://127.0.0.1:4317/#token", {
      platform: currentPlatform,
      spawn: spawnProcess,
    });

    expect(spawnProcess).toHaveBeenCalledWith(expectedCommand, expectedArgs, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it.each([
    "https://127.0.0.1:4317/",
    "http://localhost:4317/",
    "http://127.0.0.1/",
    "http://user@127.0.0.1:4317/",
    "not a URL",
  ])("rejects an unsafe launch URL: %s", (url) => {
    expect(() => openHubBrowser(url)).toThrow(/Hub browser URL/);
  });

  it("does not surface process launch failures", () => {
    const spawnProcess = vi.fn(() => {
      throw new Error("no display");
    }) as never;

    expect(() => openHubBrowser("http://127.0.0.1:4317/", {
      platform: "linux",
      spawn: spawnProcess,
    })).not.toThrow();
  });
});
