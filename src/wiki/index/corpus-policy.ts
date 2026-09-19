/** Hard safety ceilings shared by Wiki discovery, reads, and maintenance. */
export const WIKI_CORPUS_LIMITS = Object.freeze({
  maxDirectoryEntries: 100_000,
  maxMarkdownFiles: 10_000,
  maxDirectoryDepth: 64,
  maxFileBytes: 8 * 1024 * 1024,
  maxCorpusBytes: 256 * 1024 * 1024,
  // Refuse implausibly amplified disposable SQLite state before inspection
  // opens it or retains any of its values.
  maxIndexBytes: 2 * 1024 * 1024 * 1024,
  maxDiagnostics: 100,
  maxMaintenancePaths: 1_000,
} as const);

export type WikiCorpusLimit = keyof typeof WIKI_CORPUS_LIMITS;

export class WikiCorpusLimitError extends Error {
  readonly code = "WIKI_CORPUS_LIMIT_EXCEEDED";

  constructor(readonly limit: WikiCorpusLimit) {
    super(`The Wiki corpus exceeded the configured ${limit} safety bound.`);
    this.name = "WikiCorpusLimitError";
  }
}

export function addWikiCorpusBytes(total: number, fileBytes: number): number {
  if (!Number.isSafeInteger(fileBytes)
    || fileBytes < 0
    || fileBytes > WIKI_CORPUS_LIMITS.maxFileBytes) {
    throw new WikiCorpusLimitError("maxFileBytes");
  }
  const next = total + fileBytes;
  if (!Number.isSafeInteger(next) || next > WIKI_CORPUS_LIMITS.maxCorpusBytes) {
    throw new WikiCorpusLimitError("maxCorpusBytes");
  }
  return next;
}
