type JsonObject = Readonly<Record<string, unknown>>;

/**
 * Build a self-contained JSON Schema resource from one focused root and only
 * the local definitions reachable from that root.
 *
 * Contract catalogs remain the source of truth. Callers narrow their root
 * before invoking this helper; this function merely closes local `$ref`s and
 * fails if a catalog accidentally leaves a reference unresolved.
 */
export function projectLocalSchemaClosure(options: {
  id: string;
  source: JsonObject;
  root: JsonObject;
  additionalDefinitions?: JsonObject;
}): JsonObject {
  const sourceDefinitions = schemaDefinitions(options.source);
  const definitions = {
    ...sourceDefinitions,
    ...(options.additionalDefinitions ?? {}),
  };
  const selected = new Map<string, unknown>();
  const pending: string[] = [];

  collectLocalRefs(options.root, pending);
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (selected.has(name)) continue;
    if (!Object.hasOwn(definitions, name)) {
      throw new Error(`Focused contract schema references missing definition ${name}.`);
    }
    const definition = structuredClone(definitions[name]);
    selected.set(name, definition);
    collectLocalRefs(definition, pending);
  }

  const comments = [options.source.$comment, options.root.$comment]
    .filter((comment): comment is string => typeof comment === "string");
  return Object.freeze({
    ...structuredClone(options.root),
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: options.id,
    ...(comments.length === 0 ? {} : { $comment: comments.join(" ") }),
    $defs: Object.fromEntries(selected),
  });
}

/** Return one catalog definition without exposing a mutable catalog object. */
export function projectSchemaDefinition(source: JsonObject, name: string): unknown {
  const definitions = schemaDefinitions(source);
  if (!Object.hasOwn(definitions, name)) {
    throw new Error(`Contract schema definition ${name} does not exist.`);
  }
  return structuredClone(definitions[name]);
}

function schemaDefinitions(source: JsonObject): Record<string, unknown> {
  if (
    source.$defs === null
    || typeof source.$defs !== "object"
    || Array.isArray(source.$defs)
  ) {
    throw new Error("Contract schema does not expose an object $defs catalog.");
  }
  return source.$defs as Record<string, unknown>;
}

function collectLocalRefs(value: unknown, refs: string[]): void {
  if (Array.isArray(value)) {
    for (const child of value) collectLocalRefs(child, refs);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof child === "string" && child.startsWith("#/$defs/")) {
      refs.push(child.slice("#/$defs/".length));
    }
    collectLocalRefs(child, refs);
  }
}
