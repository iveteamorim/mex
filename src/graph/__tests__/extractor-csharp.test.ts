import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import type { FileExtraction } from "../extraction/index.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.cs");

describe("C# extractor", () => {
  let result: FileExtraction;

  beforeAll(async () => {
    await loadGrammars(["csharp"]);
    const source = readFileSync(FIXTURE, "utf-8");
    result = extractFile("fixtures/sample.cs", source, "csharp")!;
    expect(result).not.toBeNull();
  });

  const node = (kind: string, name: string) =>
    result.nodes.find((n) => n.kind === kind && n.name === name);
  const hasEdge = (kind: string, targetName: string) =>
    result.edges.some((e) => e.kind === kind && e.targetName === targetName);
  const extractSource = (source: string) => {
    const extracted = extractFile("regressions.cs", source, "csharp")!;
    expect(extracted).not.toBeNull();
    expect(extracted.health.status).toBe("ok");
    return extracted;
  };

  it("emits a file node and stamps the language", () => {
    expect(result.language).toBe("csharp");
    expect(node("file", "sample.cs")).toBeDefined();
  });

  it("extracts namespaces, including nested ones", () => {
    expect(node("namespace", "MyApp.Models")).toBeDefined();
    const auditLog = node("class", "AuditLog");
    expect(auditLog).toBeDefined();
    expect(auditLog!.qualifiedName).toBe("MyApp.Models.Admin.AuditLog");
  });

  it("extracts interfaces, structs, and enums", () => {
    expect(node("interface", "IGreeter")).toBeDefined();

    const point = node("struct", "Point");
    expect(point).toBeDefined();
    expect(node("field", "X")).toBeDefined();
    expect(node("field", "Y")).toBeDefined();

    const role = node("enum", "Role");
    expect(role).toBeDefined();
    expect(node("enum_member", "Admin")).toBeDefined();
    expect(node("enum_member", "Member")).toBeDefined();
  });

  it("extracts a class, its visibility, and its members", () => {
    const user = node("class", "User");
    expect(user).toBeDefined();
    expect(user!.visibility).toBe("public");
    expect(user!.isExported).toBe(true);

    const nameProp = node("property", "Name");
    expect(nameProp).toBeDefined();
    expect(nameProp!.returnType).toBe("string");

    expect(node("field", "name")).toBeDefined();

    const maxAge = node("constant", "MaxAge");
    expect(maxAge).toBeDefined();
    expect(maxAge!.isStatic).toBe(true);
  });

  it("extracts a constructor named after the class", () => {
    const ctor = result.nodes.find(
      (n) => n.kind === "method" && n.qualifiedName === "MyApp.Models.User.User",
    );
    expect(ctor).toBeDefined();
  });

  it("extracts methods, including static ones, with parameters", () => {
    // "Greet" is declared on both IGreeter and User — disambiguate by qualifiedName.
    const greet = result.nodes.find(
      (n) => n.kind === "method" && n.qualifiedName === "MyApp.Models.User.Greet",
    );
    expect(greet).toBeDefined();

    const create = node("method", "Create");
    expect(create).toBeDefined();
    expect(create!.isStatic).toBe(true);

    const param = result.nodes.find(
      (n) => n.kind === "parameter" && n.qualifiedName === "MyApp.Models.User.Create.name",
    );
    expect(param).toBeDefined();
  });

  it("emits extends/implements from the base list", () => {
    expect(hasEdge("extends", "BaseEntity")).toBe(true);
    expect(hasEdge("implements", "IGreeter")).toBe(true);
  });

  it("emits an attribute as a decorates edge", () => {
    expect(hasEdge("decorates", "Serializable")).toBe(true);
  });

  it("emits import edges for using directives", () => {
    expect(hasEdge("imports", "System")).toBe(true);
    expect(hasEdge("imports", "System.Collections.Generic")).toBe(true);
  });

  it("emits calls and instantiates references", () => {
    expect(hasEdge("instantiates", "User")).toBe(true);
    expect(hasEdge("calls", "Logger.Log")).toBe(true);
    expect(hasEdge("calls", "user.Greet")).toBe(true);
    expect(hasEdge("calls", "Console.WriteLine")).toBe(true);
  });

  it("nests methods under their class via contains edges", () => {
    const userClass = node("class", "User")!;
    const greet = result.nodes.find(
      (n) => n.kind === "method" && n.qualifiedName === "MyApp.Models.User.Greet",
    )!;
    expect(
      result.edges.some(
        (e) => e.kind === "contains" && e.source === userClass.id && e.target === greet.id,
      ),
    ).toBe(true);
  });

  it("visits declarations and references in a file-scoped namespace exactly once", () => {
    const extracted = extractSource(`
using System;
namespace Demo;
class Worker {
    void Start() { var worker = new Worker(); Work(); }
    void Work() {}
}
class Other {}
`);
    expect(extracted.nodes.map((entry) => entry.qualifiedName)).toEqual([
      "regressions.cs", "Demo", "Demo.Worker", "Demo.Worker.Start", "Demo.Worker.Work", "Demo.Other",
    ]);
    const worker = extracted.nodes.find((entry) => entry.qualifiedName === "Demo.Worker")!;
    const namespace = extracted.nodes.find((entry) => entry.kind === "namespace")!;
    const start = extracted.nodes.find((entry) => entry.qualifiedName === "Demo.Worker.Start")!;
    expect(extracted.edges.filter((edge) => edge.kind === "contains" && edge.target === worker.id))
      .toEqual([{ source: namespace.id, target: worker.id, kind: "contains" }]);
    expect(extracted.edges.filter((edge) => edge.kind === "calls"))
      .toEqual([expect.objectContaining({ source: start.id, targetName: "Work" })]);
    expect(extracted.edges.filter((edge) => edge.kind === "instantiates"))
      .toEqual([expect.objectContaining({ source: start.id, targetName: "Worker" })]);
    expect(extracted.edges.filter((edge) => edge.kind === "imports"))
      .toEqual([expect.objectContaining({ targetName: "System" })]);
  });

  it("keeps operators, conversions, constructors, and destructors distinct across reordering", () => {
    const members = [
      "public Sample() {}",
      "~Sample() {}",
      "public static Sample operator +(Sample left, Sample right) => left;",
      "public static Sample operator -(Sample left, Sample right) => left;",
      "public static Sample operator checked +(Sample left, Sample right) => left;",
      "public static implicit operator int(Sample value) => 0;",
      'public static implicit operator string(Sample value) => "";',
      "public static explicit operator Sample(int value) => new Sample();",
    ];
    const first = extractSource(`class Sample {\n${members.join("\n")}\n}`);
    const reordered = extractSource(`\n// Declarations moved without changing their identity.\nclass Sample {\n${[...members].reverse().join("\n")}\n}`);
    const methods = first.nodes.filter((entry) => entry.kind === "method");
    expect(methods.map((entry) => entry.name).sort()).toEqual([
      "Sample", "~Sample", "operator +", "operator -", "operator checked +",
      "implicit operator int", "implicit operator string", "explicit operator Sample",
    ].sort());
    expect(new Set(methods.map((entry) => entry.id)).size).toBe(members.length);
    expect(new Set(methods.map((entry) => entry.identityKey)).size).toBe(members.length);
    for (const method of methods) {
      const moved = reordered.nodes.find((entry) => entry.kind === "method" && entry.name === method.name)!;
      expect(moved).toMatchObject({
        id: method.id,
        identityKey: method.identityKey,
        qualifiedName: method.qualifiedName,
        signature: method.signature,
      });
    }
  });

  it("keeps static and instance constructor identities and body references attached after reordering", () => {
    const members = [
      "static Sample() { InitializeType(); }",
      "public Sample() { InitializeInstance(); }",
    ];
    const sources = [members, [...members].reverse()].map((constructors) => extractSource(`
class Sample {
    ${constructors.join("\n    ")}
    static void InitializeType() {}
    void InitializeInstance() {}
}
`));
    for (const [isStatic, name, targetName] of [
      [true, "static Sample", "InitializeType"],
      [false, "Sample", "InitializeInstance"],
    ] as const) {
      const constructors = sources.map((extracted) => {
        const matches = extracted.nodes.filter((entry) => entry.kind === "method" && entry.name === name);
        expect(matches).toHaveLength(1);
        const constructor = matches[0]!;
        expect(constructor).toMatchObject({ isStatic, signature: "()", qualifiedName: `Sample.${name}` });
        expect(extracted.edges.filter((edge) => edge.source === constructor.id && edge.kind === "calls"))
          .toEqual([expect.objectContaining({ targetName })]);
        return constructor;
      });
      expect(constructors[1]).toMatchObject({
        id: constructors[0]!.id,
        identityKey: constructors[0]!.identityKey,
        isStatic,
      });
    }
  });

  it("attributes field initializer calls and constructions to each declared field", () => {
    const extracted = extractSource(`
class Resource {}
class Owner {
    int first = Initialize(), second = Initialize();
    Resource resource = new Resource();
    static int Initialize() => 1;
}
`);
    const names = new Map(extracted.nodes.map((entry) => [entry.id, entry.qualifiedName]));
    const references = extracted.edges
      .filter((edge) => edge.kind === "calls" || edge.kind === "instantiates")
      .map((edge) => ({ owner: names.get(edge.source), kind: edge.kind, target: edge.targetName }));
    expect(references).toEqual([
      { owner: "Owner.first", kind: "calls", target: "Initialize" },
      { owner: "Owner.second", kind: "calls", target: "Initialize" },
      { owner: "Owner.resource", kind: "instantiates", target: "Resource" },
    ]);
  });

  it("extracts overloaded indexers with their signatures, parameters, and accessor calls", () => {
    const extracted = extractSource(`
class Bag {
    public int this[int index] => GetByIndex(index);
    public int this[string key] {
        get { return GetByKey(key); }
        set { SetByKey(key, value); }
    }
    int GetByIndex(int index) => 0;
    int GetByKey(string key) => 0;
    void SetByKey(string key, int value) {}
}
`);
    const indexers = extracted.nodes.filter((entry) => entry.kind === "property" && entry.name === "this");
    expect(indexers).toHaveLength(2);
    expect(new Set(indexers.map((entry) => entry.id)).size).toBe(2);
    expect(indexers.map((entry) => entry.signature)).toEqual(["[int index]", "[string key]"]);
    for (const [position, parameterName, parameterType, calls] of [
      [0, "index", "int", ["GetByIndex"]],
      [1, "key", "string", ["GetByKey", "SetByKey"]],
    ] as const) {
      const indexer = indexers[position]!;
      expect(indexer).toMatchObject({ qualifiedName: "Bag.this", returnType: "int" });
      const parameter = extracted.nodes.find((entry) =>
        entry.kind === "parameter" && entry.qualifiedName === `Bag.this.${parameterName}`,
      )!;
      expect(parameter).toMatchObject({ name: parameterName, returnType: parameterType });
      expect(extracted.edges).toContainEqual({ source: indexer.id, target: parameter.id, kind: "contains" });
      expect(extracted.edges.filter((edge) => edge.kind === "calls" && edge.source === indexer.id)
        .map((edge) => edge.targetName)).toEqual(calls);
    }
  });

  it("uses enum member identifiers when attributes precede the member", () => {
    const extracted = extractSource(`
enum State {
    [System.Obsolete("legacy value")] Deprecated = 1,
    [System.Obsolete] Secondary,
    Active,
}
`);
    const members = extracted.nodes.filter((entry) => entry.kind === "enum_member");
    expect(members.map((entry) => entry.name)).toEqual(["Deprecated", "Secondary", "Active"]);
    expect(members.map((entry) => entry.qualifiedName)).toEqual([
      "State.Deprecated", "State.Secondary", "State.Active",
    ]);
  });

  it("represents every inherited interface as extends", () => {
    const extracted = extractSource(`
interface ILeft {}
interface IRight {}
interface ICombined : ILeft, IRight {}
`);
    const combined = extracted.nodes.find((entry) => entry.name === "ICombined")!;
    expect(extracted.edges.filter((edge) => edge.source === combined.id)
      .map((edge) => ({ kind: edge.kind, target: edge.targetName }))).toEqual([
      { kind: "extends", target: "ILeft" },
      { kind: "extends", target: "IRight" },
    ]);
  });

  it("preserves the full receiver expression on calls", () => {
    const extracted = extractSource(`
class Base { protected void Run() {} }
class Other { public void Run() {} }
static class Helpers { public static void Run() {} }
class Caller : Base {
    void Start(Other other) {
        other.Run();
        this.Run();
        base.Run();
        Helpers.Run();
        GetOther().Run();
        Run();
    }
    Other GetOther() => new Other();
    new void Run() {}
}
`);
    const start = extracted.nodes.find((entry) => entry.qualifiedName === "Caller.Start")!;
    expect(extracted.edges.filter((edge) => edge.kind === "calls" && edge.source === start.id)
      .map((edge) => edge.targetName)).toEqual([
      "other.Run", "this.Run", "base.Run", "Helpers.Run", "GetOther().Run", "GetOther", "Run",
    ]);
  });
});
