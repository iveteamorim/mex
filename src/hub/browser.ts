import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

export interface BrowserLauncherDependencies {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
}

/**
 * Best-effort browser launch for the local Project Hub.
 *
 * The URL must already be bound to MEX's IPv4 loopback origin. Commands and
 * arguments are fixed per platform and are never passed through a shell.
 */
export function openHubBrowser(
  url: string,
  dependencies: BrowserLauncherDependencies = {},
): void {
  assertHubUrl(url);

  const currentPlatform = dependencies.platform ?? platform();
  const spawnProcess = dependencies.spawn ?? spawn;
  const [command, args] = browserCommand(currentPlatform, url);

  try {
    const child = spawnProcess(command, args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    ignoreLaunchFailure(child);
    child.unref();
  } catch {
    // Browser launch is convenience only. The command prints the bootstrap URL
    // so a missing graphical environment never prevents Hub startup.
  }
}

function browserCommand(currentPlatform: NodeJS.Platform, url: string): [string, string[]] {
  if (currentPlatform === "darwin") return ["open", [url]];
  if (currentPlatform === "win32") {
    return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  }
  return ["xdg-open", [url]];
}

function assertHubUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Hub browser URL is invalid.");
  }

  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.port === ""
  ) {
    throw new Error("Hub browser URL must use the bound 127.0.0.1 origin.");
  }
}

function ignoreLaunchFailure(child: ChildProcess): void {
  child.once("error", () => {
    // Intentionally ignored; the URL remains available in terminal output.
  });
}
