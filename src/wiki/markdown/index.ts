/**
 * Markdown codec.
 *
 * Positions-only parsing and scoped patching: the codec locates ranges and
 * splices within them, and never re-serializes an AST. Only the contract and
 * the property harnesses exist so far; the parser lands in the next phase.
 */

export * from "./ranges.js";
export * from "./contract.js";
