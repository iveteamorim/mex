export function nearestRank(values, percentile = 0.95) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("A percentile requires at least one finite sample.");
  }
  if (!(percentile > 0 && percentile <= 1)) {
    throw new Error("Percentile must be greater than zero and at most one.");
  }
  const sorted = values.map(finiteNonNegative).sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

export function summarize(values, expectedSamples) {
  if (!Array.isArray(values) || values.length !== expectedSamples) {
    throw new Error(`Expected exactly ${expectedSamples} samples; received ${values?.length ?? 0}.`);
  }
  const samples = values
    .map(finiteNonNegative)
    .map((value) => round(value))
    .sort((left, right) => left - right);
  return {
    samples,
    min: samples[0],
    median: round(median(samples)),
    p95: round(nearestRank(samples, 0.95)),
    max: samples.at(-1),
  };
}

export function runtimeBudgetCandidate(value) {
  return Math.ceil(finiteNonNegative(value) * 1.15);
}

export function assetBudgetCandidate(value) {
  return Math.ceil(finiteNonNegative(value) * 1.05);
}

export function round(value, digits = 3) {
  const multiplier = 10 ** digits;
  return Math.round(finiteNonNegative(value) * multiplier) / multiplier;
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function finiteNonNegative(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Expected a finite non-negative number; received ${String(value)}.`);
  }
  return value;
}
