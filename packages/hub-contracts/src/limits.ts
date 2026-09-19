export const HUB_LIMITS = {
  maxMutationBodyBytes: 64 * 1024,
  maxQueryCharacters: 256,
  maxCursorBytes: 4 * 1024,
  maxQueryStringBytes: 16 * 1024,
  defaultPageSize: 25,
  maxPageSize: 100,
  maxSearchGroupSize: 50,
  maxJsonResponseBytes: 1024 * 1024,
  maxIdentifierCharacters: 128,
  maxDiagnosticCount: 50,
} as const;
