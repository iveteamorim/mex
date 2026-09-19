import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import { fastAPIResolver } from "../resolution/frameworks/fastapi.js";
import { FRAMEWORK_RESOLVERS } from "../resolution/frameworks/index.js";
import type { GraphNode } from "../types.js";
import type { ResolutionContext } from "../resolution/types.js";

const FILE_PATH = "src/fastapi-app.py";
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fastapi-app.py");
const source = readFileSync(fixturePath, "utf-8");

describe("FastAPI framework resolver", () => {
  let pythonNodes: GraphNode[];

  beforeAll(async () => {
    await loadGrammars(["python"]);
    pythonNodes = extractFile(FILE_PATH, source, "python")!.nodes.map((node) => ({
      ...node,
      updatedAt: 0,
    }));
  });

  // Detection reads the staged corpus, which holds source and never holds a
  // dependency manifest, so the import is the observable (#113 review).
  it.each([
    ["a from-import of the app class", { "src/app.py": "from fastapi import FastAPI\napp = FastAPI()\n" }],
    ["a plain module import", { "src/app.py": "import fastapi\n\napp = fastapi.FastAPI()\n" }],
    ["a submodule import", { "src/deps.py": "from fastapi.security import OAuth2PasswordBearer\n" }],
  ])("detects FastAPI from %s", (_name, files) => {
    expect(fastAPIResolver.detect(fakeContext([], files))).toBe(true);
  });

  it("does not detect similarly named packages or unrelated Python", () => {
    const context = fakeContext([], {
      "src/app.py": "import fastapi_utils\nfrom fastapi_utils.cbv import cbv\n",
      "src/other.py": "from flask import Flask\n",
    });
    expect(fastAPIResolver.detect(context)).toBe(false);
  });

  it("does not detect from a dependency manifest alone", () => {
    // A manifest is not a staged corpus file; if one ever is, a declared
    // dependency still says nothing about a module using it.
    const context = fakeContext([], {
      "pyproject.toml": "[project]\ndependencies = [\"fastapi>=0.115\"]\n",
      "requirements.txt": "fastapi[standard]>=0.115\n",
    });
    expect(fastAPIResolver.detect(context)).toBe(false);
  });

  it("extracts stable route nodes with path parameters preserved", () => {
    const result = fastAPIResolver.extract!(FILE_PATH, source);

    expect(result.nodes.map((node) => node.name)).toEqual([
      "GET /health",
      "POST /users/{user_id}",
      "PATCH /users/{user_id}",
      "PUT /users/{user_id}",
      "OPTIONS /users",
      "HEAD /users",
      "GET /reports/{report_id}",
      "GET /legacy",
      "POST /legacy",
      "GET /files/{file_path:path}",
      "DELETE /admin/users/{user_id}",
    ]);
    for (const node of result.nodes) {
      expect(node).toMatchObject({ kind: "route", language: "python", filePath: FILE_PATH });
      expect(node.id.startsWith("route:")).toBe(true);
      expect(node.signature).toBe(`${node.name} -> ${handlerFor(node.name)}`);
    }
    expect(result.references.map((ref) => [ref.referenceName, ref.referenceKind])).toEqual([
      ["health", "function_ref"],
      ["update_user", "function_ref"],
      ["update_user", "function_ref"],
      ["replace_user", "function_ref"],
      ["inspect_users", "function_ref"],
      ["inspect_users", "function_ref"],
      ["read_report", "function_ref"],
      ["legacy", "function_ref"],
      ["legacy", "function_ref"],
      ["read_file", "function_ref"],
      ["delete_user", "function_ref"],
    ]);
  });

  it("gives a route declared twice in one file distinct ids (#113 review)", () => {
    const custom = [
      "import os",
      "from fastapi import APIRouter",
      "v1 = APIRouter(prefix='/v1')",
      "v2 = APIRouter(prefix='/v1')",
      "@v1.get('/items')",
      "def list_items(): pass",
      "@v2.get('/items')",
      "def list_items(): pass",
      "",
    ].join("\n");

    const result = fastAPIResolver.extract!("src/versioned.py", custom);
    expect(result.nodes.map((node) => node.name)).toEqual(["GET /v1/items", "GET /v1/items"]);
    expect(new Set(result.nodes.map((node) => node.id)).size).toBe(2);
    expect(new Set(result.nodes.map((node) => node.identityKey)).size).toBe(2);
  });

  it("ignores a decorator that only appears inside a docstring", () => {
    const custom = [
      "from fastapi import FastAPI",
      "app = FastAPI()",
      "EXAMPLE = \"\"\"",
      "@app.get('/doc-only')\"\"\"",
      "def loader(): pass",
      "",
    ].join("\n");

    expect(fastAPIResolver.extract!("src/docs.py", custom).nodes).toEqual([]);
  });

  it("reads a router imported from another module", () => {
    const custom = [
      "from fastapi import APIRouter",
      "from .routers import users",
      "from app.api import router",
      "@router.get('/imported')",
      "def imported(): pass",
      "",
    ].join("\n");

    const result = fastAPIResolver.extract!("src/routes.py", custom);
    expect(result.nodes.map((node) => node.name)).toEqual(["GET /imported"]);
  });

  it("recognizes custom instance names and skips dynamic or unrelated routes", () => {
    const customSource = [
      "api = FastAPI()",
      "client = HttpClient()",
      "route_path = '/dynamic'",
      "@api.get('/ready')",
      "def ready(): pass",
      "@client.get('/external')",
      "def external(): pass",
      "@api.get(route_path)",
      "def dynamic(): pass",
      "@api.get(f'/{prefix}/interpolated')",
      "def interpolated(): pass",
      "",
    ].join("\n");

    const result = fastAPIResolver.extract!("src/custom.py", customSource);
    expect(result.nodes).toMatchObject([{ kind: "route", name: "GET /ready" }]);
    expect(result.references).toMatchObject([{ referenceName: "ready" }]);
  });

  it("skips an api_route whose methods cannot be read", () => {
    const custom = [
      "from fastapi import FastAPI",
      "app = FastAPI()",
      "VERBS = ['GET']",
      "@app.api_route('/guessed', methods=VERBS)",
      "def guessed(): pass",
      "@app.api_route('/bare')",
      "def bare(): pass",
      "",
    ].join("\n");

    expect(fastAPIResolver.extract!("src/api_route.py", custom).nodes).toEqual([]);
  });

  it("resolves unambiguous same-file functions and methods", () => {
    const result = fastAPIResolver.extract!(FILE_PATH, source);
    const context = fakeContext(pythonNodes);

    for (const endpoint of ["health", "update_user", "delete_user"]) {
      const ref = result.references.find((entry) => entry.referenceName === endpoint)!;
      const target = pythonNodes.find((node) => node.name === endpoint)!;
      expect(fastAPIResolver.resolve(ref, context)).toMatchObject({
        targetNodeId: target.id,
        confidence: 0.8,
        resolvedBy: "fastapi-route-handler",
      });
    }
  });

  it("leaves missing, cross-file-only, and ambiguous endpoints unresolved", () => {
    const ref = fastAPIResolver.extract!(FILE_PATH, source).references[0]!;
    const crossFile = node("function:cross-file", "health", "src/other.py");
    expect(fastAPIResolver.resolve(ref, fakeContext([crossFile]))).toBeNull();
    expect(fastAPIResolver.resolve(ref, fakeContext([]))).toBeNull();

    const sameFile = node("function:same-file", "health", FILE_PATH);
    const duplicate = node("method:duplicate", "health", FILE_PATH, "method");
    expect(fastAPIResolver.resolve(ref, fakeContext([sameFile, duplicate]))).toBeNull();
  });

  it("ignores non-Python files and is registered", () => {
    expect(fastAPIResolver.extract!("src/app.ts", "@app.get('/health')\ndef health(): pass"))
      .toEqual({ nodes: [], references: [] });
    expect(FRAMEWORK_RESOLVERS).toContain(fastAPIResolver);
  });
});

function handlerFor(routeName: string): string {
  const handlers: Record<string, string> = {
    "GET /health": "health",
    "POST /users/{user_id}": "update_user",
    "PATCH /users/{user_id}": "update_user",
    "PUT /users/{user_id}": "replace_user",
    "OPTIONS /users": "inspect_users",
    "HEAD /users": "inspect_users",
    "GET /reports/{report_id}": "read_report",
    "GET /legacy": "legacy",
    "POST /legacy": "legacy",
    "GET /files/{file_path:path}": "read_file",
    "DELETE /admin/users/{user_id}": "delete_user",
  };
  return handlers[routeName]!;
}

function node(
  id: string,
  name: string,
  filePath: string,
  kind: "function" | "method" = "function",
): GraphNode {
  return {
    id,
    kind,
    name,
    qualifiedName: name,
    filePath,
    language: "python",
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  };
}

function fakeContext(nodes: GraphNode[], files: Record<string, string> = {}): ResolutionContext {
  return {
    getNodesInFile: (path) => nodes.filter((entry) => entry.filePath === path),
    getNodesByName: (name) => nodes.filter((entry) => entry.name === name),
    getNodesByQualifiedName: (name) => nodes.filter((entry) => entry.qualifiedName === name),
    getNodesByKind: (kind) => nodes.filter((entry) => entry.kind === kind),
    getNodeById: (id) => nodes.find((entry) => entry.id === id) ?? null,
    fileExists: (path) => path in files,
    readFile: (path) => files[path] ?? null,
    getProjectRoot: () => "/repo",
    getAllFiles: () => Object.keys(files),
  };
}
