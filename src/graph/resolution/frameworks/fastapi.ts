import { canonicalNodeIdentity, generateNodeId } from "../../extraction/node-id.js";
import type { GraphNode } from "../../types.js";
import {
  blankCommentsAndDocstrings,
  mergeLogicalLines,
  readBalanced,
} from "./python-source.js";
import type {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolvedRef,
  UnresolvedRef,
} from "../types.js";

// Receiver creation: `app = FastAPI()`, `app: FastAPI = FastAPI()`,
// `router = APIRouter(prefix="/users")`, `app = fastapi.FastAPI()`.
const FRAMEWORK_INSTANCE = /^\s*([A-Za-z_]\w*)\s*(?::\s*[\w.\[\]"]+)?\s*=\s*(?:fastapi\.)?(?:FastAPI|APIRouter)\s*\(/;
const FROM_IMPORT = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/;
const IMPORTED_NAME = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?/;
const ROUTE_DECORATOR = /^(\s*)@([A-Za-z_]\w*)\.(get|post|put|patch|delete|options|head|trace|api_route)\s*\(/;
const PATH_ARG = /^\s*([fFbBuU]{0,2})?(["'])((?:[^"'\\]|\\.)*)\2/;
const HANDLER = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const FASTAPI_IMPORT = /(?:^|\r?\n)\s*(?:from\s+fastapi(?:\.[\w.]+)?\s+import\s|import\s+fastapi\b)/;
const PREFIX_ARG = /(?:^|[,({\s])prefix\s*=\s*(["'])((?:[^"'\\]|\\.)*)\1/;
// `methods=` written as a list or a tuple; the value must close on the same
// logical line and hold only quoted names (or it is unreadable).
const METHODS_VALUE = /(?:^|[,({\s])methods\s*=\s*([[(])([^)\]]*)[\])]/;

/** A route decorator parsed before its handler was seen. */
interface PendingRoute {
  method: string;
  path: string;
  line: number;
  endColumn: number;
}

export const fastAPIResolver: FrameworkResolver = {
  name: "fastapi",
  languages: ["python"],
  detect(context) {
    // Detection runs against the staged corpus, and dependency manifests are
    // not staged files — only source is, so reading pyproject.toml or
    // requirements.txt here never fires and a real build produced no routes
    // (#113 review). A FastAPI project always has a Python module importing
    // fastapi, which is the reliable observable; the word boundary keeps
    // `fastapi_utils` and friends out.
    return context.getAllFiles().some((filePath) => {
      if (!filePath.toLowerCase().endsWith(".py")) return false;
      const content = context.readFile(filePath);
      return content ? FASTAPI_IMPORT.test(content) : false;
    });
  },
  claimsReference: (name) => /^[A-Za-z_]\w*$/.test(name),
  extract(filePath, content): FrameworkExtractionResult {
    if (!filePath.toLowerCase().endsWith(".py")) {
      return { nodes: [], references: [] };
    }

    const nodes: GraphNode[] = [];
    const references: UnresolvedRef[] = [];
    const pendingRoutes: PendingRoute[] = [];
    // Route ordinals count per FILE: a versioned router declaring the same
    // path twice, an if/else redefinition, or two routers carrying the same
    // path in one module would otherwise share a node id and fail the whole
    // build with "duplicate node id" (#113 review). Express and Flask key
    // their ordinal the same way.
    const occurrences = new Map<string, number>();

    // A decorator shown inside a docstring example is documentation, not a
    // route; comments between a decorator and its `def` are legal. Blanking
    // keeps every offset and line number valid.
    const scannable = blankCommentsAndDocstrings(content);
    const logical = mergeLogicalLines(scannable);

    // Route receivers: names assigned FastAPI/APIRouter in THIS file, plus
    // names imported with `from <module> import name` — a FastAPI project of
    // any size declares its routers in one module and its routes in another,
    // and detection has already proved this is a FastAPI project. Names
    // imported FROM fastapi are framework classes, not instances. An
    // APIRouter keeps its static constructor `prefix`.
    const receivers = new Map<string, string>();
    const importedNames: string[] = [];
    for (const entry of logical) {
      const instance = FRAMEWORK_INSTANCE.exec(entry.text);
      if (instance) {
        receivers.set(instance[1]!, parsePrefix(entry.text, instance[0].length));
        continue;
      }
      const imported = FROM_IMPORT.exec(entry.text);
      if (imported && !imported[1]!.split(".")[0]!.startsWith("fastapi")) {
        for (const raw of imported[2]!.split(",")) {
          const nameMatch = IMPORTED_NAME.exec(raw.trim().replace(/[()]/g, ""));
          if (nameMatch) importedNames.push(nameMatch[2] ?? nameMatch[1]!);
        }
      }
    }
    for (const name of importedNames) {
      if (!receivers.has(name)) receivers.set(name, "");
    }

    for (const entry of logical) {
      const line = entry.text;
      const decorator = ROUTE_DECORATOR.exec(line);
      if (decorator && receivers.has(decorator[2]!)) {
        const receiverPrefix = receivers.get(decorator[2]!)!;
        const open = line.indexOf("(", decorator[1]!.length + decorator[2]!.length + 1);
        const args = readBalanced(line, open);
        const routes = args === null
          ? null
          : parseRoutes(decorator[3]!, args, entry.line, receiverPrefix);
        if (routes) pendingRoutes.push(...routes);
        continue;
      }

      if (pendingRoutes.length === 0) continue;
      // Stacked decorators (`@router.get(...)` above `@deprecated`) and blank
      // lines are legal between a route decorator and its def; only a real
      // statement ends the wait.
      if (/^\s*@/.test(line)) continue;
      if (/^\s*(?:#.*)?$/.test(line)) continue;

      const handler = HANDLER.exec(line);
      if (handler) {
        emitRoutes(filePath, handler[1]!, pendingRoutes, nodes, references, occurrences);
      }
      pendingRoutes.length = 0;
    }

    return { nodes, references };
  },
  resolve(ref, context): ResolvedRef | null {
    if (ref.referenceKind !== "function_ref") return null;
    const candidates = context.getNodesInFile(ref.filePath).filter((node) => (
      (node.kind === "function" || node.kind === "method")
      && node.name === ref.referenceName
    ));
    // The decorator proves the handler name, not a repository-global target;
    // same-file is the only context that binds it unambiguously.
    if (candidates.length !== 1) return null;

    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.8,
      resolvedBy: "fastapi-route-handler",
    };
  },
};

/**
 * Turn one decorator's arguments into 1..n routes.
 *
 * A shortcut decorator carries its method in the name. `@app.api_route()`
 * fans out to one route per declared method; a `methods=` that is present but
 * not a literal list/tuple of strings skips the route rather than guessing.
 * Paths that are not fully static — f-strings, `%`-format — are skipped
 * rather than emitted verbatim, but FastAPI path parameters (`/items/{id}`,
 * `/files/{path:path}`) are preserved exactly as written: braces are the
 * framework's own syntax here, not a format placeholder. An APIRouter's
 * static constructor `prefix` composes in front of the decorated path;
 * composing prefixes across `include_router()` calls stays out of scope.
 */
function parseRoutes(
  decoratorName: string,
  argsText: string,
  lineIndex: number,
  receiverPrefix: string,
): PendingRoute[] | null {
  const pathMatch = PATH_ARG.exec(argsText);
  if (!pathMatch) return null;
  const stringPrefix = pathMatch[1] ?? "";
  const rawPath = pathMatch[3]!;
  if (/[fF]/.test(stringPrefix)) return null;
  if (rawPath.includes("%")) return null;
  const path = composePath(receiverPrefix, rawPath);

  if (decoratorName === "api_route") {
    const methods = declaredMethods(argsText);
    if (methods === "unreadable" || methods === null) return null;
    return methods.map((method) => ({
      method,
      path,
      line: lineIndex,
      endColumn: argsText.length,
    }));
  }
  return [{
    method: decoratorName.toUpperCase(),
    path,
    line: lineIndex,
    endColumn: argsText.length,
  }];
}

/** `/users` + `/{id}` → `/users/{id}`; "" and `/` fold correctly. */
function composePath(prefix: string, decoratedPath: string): string {
  let head = prefix.replace(/\/+$/, "");
  if (head && !head.startsWith("/")) head = "/" + head;
  let path = decoratedPath;
  if (path && !path.startsWith("/")) path = "/" + path;
  const full = head + path;
  return full === "" ? "/" : full;
}

/**
 * Methods from `methods=[...]` or `methods=(...)`. Null when the key is
 * absent — `api_route` without methods has no default worth guessing — the
 * literal set when readable, and "unreadable" when the key exists but its
 * value is not a literal list/tuple of plain strings.
 */
function declaredMethods(argsText: string): string[] | "unreadable" | null {
  const match = METHODS_VALUE.exec(argsText);
  if (!match) {
    return /(?:^|[,({\s])methods\s*=/.test(argsText) ? "unreadable" : null;
  }
  const inner = match[2]!;
  const methods: string[] = [];
  for (const part of inner.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const literal = /^(["'])([A-Za-z]+)\1$/.exec(trimmed);
    if (!literal) return "unreadable";
    methods.push(literal[2]!.toUpperCase());
  }
  return methods.length > 0 ? methods : "unreadable";
}

/** The static `prefix="…"` of an APIRouter constructor, if any. */
function parsePrefix(line: string, callStart: number): string {
  const open = line.indexOf("(", callStart - 1);
  const args = open < 0 ? null : readBalanced(line, open);
  if (args === null) return "";
  const match = PREFIX_ARG.exec(args);
  return match ? match[2]! : "";
}

function emitRoutes(
  filePath: string,
  handler: string,
  routes: PendingRoute[],
  nodes: GraphNode[],
  references: UnresolvedRef[],
  occurrences: Map<string, number>,
): void {
  for (const route of routes) {
    const name = `${route.method} ${route.path}`;
    const signature = `${name} -> ${handler}`;
    // The ordinal keeps ids distinct when one module declares the same route
    // twice, so a duplicate cannot fail the whole build (#113 review).
    const ordinal = occurrences.get(name) ?? 0;
    occurrences.set(name, ordinal + 1);
    const role = `fastapi-route:${ordinal}`;
    const id = generateNodeId(filePath, "route", name, name, role, signature);
    nodes.push({
      id,
      identityKey: canonicalNodeIdentity(filePath, "route", name, role, signature),
      kind: "route",
      name,
      qualifiedName: name,
      filePath,
      language: "python",
      startLine: route.line + 1,
      endLine: route.line + 1,
      startColumn: 0,
      endColumn: route.endColumn,
      signature,
      isExported: false,
      updatedAt: 0,
    });
    references.push({
      fromNodeId: id,
      referenceName: handler,
      referenceKind: "function_ref",
      filePath,
      language: "python",
      line: route.line,
      column: 0,
    });
  }
}
