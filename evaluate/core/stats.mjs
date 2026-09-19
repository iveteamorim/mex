export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function mean(values) {
  return values.length ? sum(values) / values.length : null;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
}

export function round(value, digits = 4) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? value
    : Number(value.toFixed(digits));
}

export function distribution(values) {
  const finite = values.filter(Number.isFinite);
  return {
    count: finite.length,
    min: finite.length ? Math.min(...finite) : null,
    p50: median(finite),
    p95: percentile(finite, 0.95),
    max: finite.length ? Math.max(...finite) : null,
    mean: mean(finite),
  };
}

/** Deterministic bootstrap interval for a mean using a tiny LCG. */
export function bootstrapMeanInterval(values, options = {}) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { low: null, high: null, samples: 0 };
  if (finite.length === 1) return { low: finite[0], high: finite[0], samples: 1 };
  let state = (options.seed ?? 0x6d6578) >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const iterations = options.iterations ?? 2_000;
  const means = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let total = 0;
    for (let index = 0; index < finite.length; index++) {
      total += finite[Math.floor(random() * finite.length)];
    }
    means.push(total / finite.length);
  }
  means.sort((a, b) => a - b);
  return {
    low: means[Math.floor(iterations * 0.025)],
    high: means[Math.min(iterations - 1, Math.ceil(iterations * 0.975) - 1)],
    samples: iterations,
  };
}
