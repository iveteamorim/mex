import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { invalidRequest, notFound } from "../http/errors.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;

interface ViteManifestEntry {
  readonly file?: unknown;
  readonly css?: unknown;
  readonly assets?: unknown;
}

interface AssetIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAt: bigint;
  readonly changedAt: bigint;
}

interface HubAsset {
  readonly path: string;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly identity: AssetIdentity;
}

export interface HubAssetResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly cacheControl: string;
}

/** Immutable whitelist derived from Vite's build manifest. */
export class HubAssetManifest {
  readonly #root: string;
  readonly #rootIdentity: AssetIdentity;
  readonly #assets: ReadonlyMap<string, HubAsset>;

  constructor(assetRoot: string) {
    const root = canonicalDirectory(assetRoot);
    this.#root = root.path;
    this.#rootIdentity = root.identity;
    const manifestPath = findManifest(this.#root);
    const manifest = readManifest(manifestPath);
    const paths = new Set<string>(["index.html"]);
    for (const entry of Object.values(manifest)) {
      if (typeof entry !== "object" || entry === null) {
        throw new TypeError("The Hub asset manifest contains an invalid entry.");
      }
      collectManifestPath(paths, entry.file);
      collectManifestList(paths, entry.css);
      collectManifestList(paths, entry.assets);
    }

    const assets = new Map<string, HubAsset>();
    for (const path of [...paths].sort()) {
      const file = inspectAsset(this.#root, path);
      assets.set(`/${path}`, file);
    }
    this.#assertRootIdentity();
    this.#assets = assets;
  }

  has(requestPath: string): boolean {
    return this.#assets.has(requestPath);
  }

  read(requestPath: string): HubAssetResult {
    this.#assertRootIdentity();
    const asset = this.#assets.get(requestPath);
    if (asset === undefined) {
      throw notFound("The requested Hub asset does not exist.");
    }

    let descriptor: number | undefined;
    try {
      descriptor = openSync(asset.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const current = fstatSync(descriptor, { bigint: true });
      const identity: AssetIdentity = {
        device: current.dev,
        inode: current.ino,
        size: current.size,
        modifiedAt: current.mtimeNs,
        changedAt: current.ctimeNs,
      };
      if (!sameIdentity(identity, asset.identity) || !current.isFile()) {
        throw new Error("asset identity changed");
      }
      const bytes = readFileSync(descriptor);
      const afterRead = fstatSync(descriptor, { bigint: true });
      const afterIdentity: AssetIdentity = {
        device: afterRead.dev,
        inode: afterRead.ino,
        size: afterRead.size,
        modifiedAt: afterRead.mtimeNs,
        changedAt: afterRead.ctimeNs,
      };
      if (!sameIdentity(afterIdentity, asset.identity)) {
        throw new Error("asset changed during read");
      }
      return {
        bytes,
        contentType: asset.contentType,
        cacheControl: asset.cacheControl,
      };
    } catch {
      throw notFound("The requested Hub asset is no longer available.");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  #assertRootIdentity(): void {
    try {
      const current = lstatSync(this.#root, { bigint: true });
      const identity: AssetIdentity = {
        device: current.dev,
        inode: current.ino,
        size: current.size,
        modifiedAt: current.mtimeNs,
        changedAt: current.ctimeNs,
      };
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(identity, this.#rootIdentity)) {
        throw new Error("asset root identity changed");
      }
    } catch {
      throw notFound("The built Hub asset root is no longer available.");
    }
  }
}

/** Reject raw, encoded, and repeatedly encoded traversal before SPA fallback. */
export function validateHubRequestPath(rawUrl: string): string {
  const schemeIndex = rawUrl.indexOf("://");
  const pathStart = schemeIndex === -1 ? 0 : rawUrl.indexOf("/", schemeIndex + 3);
  const rawPath = (pathStart === -1 ? "/" : rawUrl.slice(pathStart)).split(/[?#]/, 1)[0] ?? "/";
  let candidate = rawPath || "/";
  for (let depth = 0; depth < 3; depth += 1) {
    if (hasUnsafePathSyntax(candidate)) {
      throw invalidRequest("The requested Hub path contains unsafe path syntax.");
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      throw invalidRequest("The requested Hub path is not valid URL encoding.");
    }
    if (decoded === candidate) break;
    candidate = decoded;
  }
  if (hasUnsafePathSyntax(candidate) || /%[0-9a-f]{2}/i.test(candidate)) {
    throw invalidRequest("The requested Hub path contains unsafe nested encoding.");
  }

  const normalized = new URL(rawUrl).pathname;
  return normalized === "" ? "/" : normalized;
}

function hasUnsafePathSyntax(path: string): boolean {
  if (path.includes("\0") || path.includes("\\")) return true;
  if (/%(?:00|2f|5c)/i.test(path)) return true;
  const segments = path.split("/");
  return segments.some((segment) => segment === "." || segment === "..");
}

function canonicalDirectory(path: string): { path: string; identity: AssetIdentity } {
  const requested = resolve(path);
  const entry = lstatSync(requested, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new TypeError("The Hub asset root must be a directory.");
  }
  const resolved = realpathSync(requested);
  const stats = statSync(resolved, { bigint: true });
  return {
    path: resolved,
    identity: {
      device: stats.dev,
      inode: stats.ino,
      size: stats.size,
      modifiedAt: stats.mtimeNs,
      changedAt: stats.ctimeNs,
    },
  };
}

function findManifest(root: string): string {
  const candidates = [join(root, ".vite", "manifest.json"), join(root, "manifest.json")];
  for (const candidate of candidates) {
    try {
      const manifestPath = relative(root, candidate).split(sep).join("/");
      assertNoSymlinkComponents(root, manifestPath);
      if (lstatSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next fixed manifest location.
    }
  }
  throw new TypeError("The built Hub asset manifest is missing.");
}

function readManifest(path: string): Record<string, ViteManifestEntry> {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > BigInt(MAX_MANIFEST_BYTES)) {
    throw new TypeError("The Hub asset manifest is not a safe regular file.");
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid manifest root");
    }
    return parsed as Record<string, ViteManifestEntry>;
  } catch {
    throw new TypeError("The Hub asset manifest is malformed.");
  }
}

function collectManifestPath(paths: Set<string>, value: unknown): void {
  if (typeof value === "string") paths.add(validateManifestPath(value));
  else if (value !== undefined) throw new TypeError("The Hub asset manifest path is invalid.");
}

function collectManifestList(paths: Set<string>, value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError("The Hub asset manifest list is invalid.");
  }
  for (const entry of value as string[]) paths.add(validateManifestPath(entry));
}

function validateManifestPath(path: string): string {
  if (
    path === ""
    || path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError("The Hub asset manifest contains an unsafe path.");
  }
  return path;
}

function inspectAsset(root: string, path: string): HubAsset {
  assertNoSymlinkComponents(root, path);
  const joined = join(root, ...path.split("/"));
  const entryStats = lstatSync(joined, { bigint: true });
  if (!entryStats.isFile() || entryStats.isSymbolicLink()) {
    throw new TypeError("A declared Hub asset is not a regular file.");
  }
  const realPath = realpathSync(joined);
  const relativePath = relative(root, realPath);
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || resolve(realPath) !== realPath
  ) {
    throw new TypeError("A declared Hub asset escapes the asset root.");
  }
  const stats = statSync(realPath, { bigint: true });
  return {
    path: realPath,
    contentType: contentTypeFor(path),
    cacheControl: isHashedAsset(path)
      ? "public, max-age=31536000, immutable"
      : "no-store",
    identity: {
      device: stats.dev,
      inode: stats.ino,
      size: stats.size,
      modifiedAt: stats.mtimeNs,
      changedAt: stats.ctimeNs,
    },
  };
}

function isHashedAsset(path: string): boolean {
  return /^assets\/.+[-.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(path);
}

function assertNoSymlinkComponents(root: string, path: string): void {
  let current = root;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) {
      throw new TypeError("A Hub asset path contains a symbolic link.");
    }
  }
}

function sameIdentity(left: AssetIdentity, right: AssetIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedAt === right.modifiedAt
    && left.changedAt === right.changedAt;
}

function contentTypeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".html") return "text/html; charset=UTF-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=UTF-8";
  if (extension === ".css") return "text/css; charset=UTF-8";
  if (extension === ".json") return "application/json; charset=UTF-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}
