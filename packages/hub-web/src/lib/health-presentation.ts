export interface GraphParseCompositionInput {
  total: number;
  ok: number;
  partial: number;
  failed: number;
}

export interface GraphParseCompositionPresentation {
  accessibleLabel: string;
  okPercent: number;
  partialPercent: number;
  failedPercent: number;
}

export function graphParseComposition(
  parseHealth: GraphParseCompositionInput,
): GraphParseCompositionPresentation {
  const percent = (value: number) => parseHealth.total === 0
    ? 0
    : (value / parseHealth.total) * 100;
  return {
    accessibleLabel: `${parseHealth.ok} parsed successfully, ${parseHealth.partial} partial, ${parseHealth.failed} failed`,
    okPercent: percent(parseHealth.ok),
    partialPercent: percent(parseHealth.partial),
    failedPercent: percent(parseHealth.failed),
  };
}

export function shortRepositoryHead(value: string | null): string {
  return value ? value.slice(0, 10) : "Not indexed";
}
