/**
 * MEX Wiki Engine.
 *
 * A Markdown-canonical knowledge graph over the `.mex` scaffold: Markdown is
 * the source of truth and is Git-tracked, while `.mex/wiki.db` is a disposable
 * projection that can be deleted and rebuilt without losing knowledge.
 *
 * The canonical model, the Markdown codec, the disposable index and the read
 * layer are implemented. The grounding adapter, operations pipeline, migration,
 * synthesis and CLI land in later phases and will export from here.
 */

export * from "./model/index.js";
export * from "./markdown/index.js";
export * from "./index/index.js";
export * from "./query/index.js";
