/**
 * Work admission limits for `filter_curve` permutation tests (#586).
 *
 * The defaults protect shared and interactive servers. A self-hosted server can
 * raise them, because with m fields and B iterations the best Holm-adjusted
 * permutation p-value is m/(B+1): a limit that admits too few iterations makes
 * the test unable to reject at all, whatever the data.
 *
 *   TRADEBLOCKS_PERMUTATION_WORK_LIMIT          per field   (default 30,000,000)
 *   TRADEBLOCKS_PERMUTATION_REQUEST_WORK_LIMIT  per request (default 90,000,000)
 *
 * Both are read per call. A value that is not a positive integer is an error,
 * never a silent fallback to the default.
 */

export const DEFAULT_PERMUTATION_WORK_LIMIT = 30_000_000;
export const DEFAULT_PERMUTATION_REQUEST_WORK_LIMIT = 90_000_000;
export const PERMUTATION_WORK_LIMIT_ENV = "TRADEBLOCKS_PERMUTATION_WORK_LIMIT";
export const PERMUTATION_REQUEST_WORK_LIMIT_ENV = "TRADEBLOCKS_PERMUTATION_REQUEST_WORK_LIMIT";
/** Significance level the power warning is judged against. */
export const PERMUTATION_WARNING_ALPHA = 0.05;
/** Largest `iterations` the permutation schema accepts. */
export const PERMUTATION_MAX_ITERATIONS = 499;

export interface PermutationWorkLimits {
  field: number;
  request: number;
  source: { field: "default" | "env"; request: "default" | "env" };
}

export class PermutationWorkLimitConfigError extends Error {
  readonly variable: string;
  readonly value: string;
  constructor(variable: string, value: string) {
    super(
      `${variable} must be a positive integer (work units), got ${JSON.stringify(value)}; ` +
        `unset it to use the default`,
    );
    this.name = "PermutationWorkLimitConfigError";
    this.variable = variable;
    this.value = value;
  }
}

function parseLimit(variable: string, raw: string | undefined, fallback: number) {
  if (raw === undefined) return { value: fallback, source: "default" as const };
  const text = raw.trim();
  const value = /^[0-9]+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PermutationWorkLimitConfigError(variable, raw);
  }
  return { value, source: "env" as const };
}

/** Effective limits from the environment; throws PermutationWorkLimitConfigError on a bad value. */
export function resolvePermutationWorkLimits(
  env: NodeJS.ProcessEnv = process.env,
): PermutationWorkLimits {
  const field = parseLimit(
    PERMUTATION_WORK_LIMIT_ENV,
    env[PERMUTATION_WORK_LIMIT_ENV],
    DEFAULT_PERMUTATION_WORK_LIMIT,
  );
  const request = parseLimit(
    PERMUTATION_REQUEST_WORK_LIMIT_ENV,
    env[PERMUTATION_REQUEST_WORK_LIMIT_ENV],
    DEFAULT_PERMUTATION_REQUEST_WORK_LIMIT,
  );
  return {
    field: field.value,
    request: request.value,
    source: { field: field.source, request: request.source },
  };
}

/** Smallest B with m/(B+1) < alpha, i.e. the fewest iterations at which the family can reject. */
export function minimumIterationsToReject(
  familySize: number,
  alpha: number = PERMUTATION_WARNING_ALPHA,
): number {
  let iterations = Math.max(1, Math.ceil(familySize / alpha) - 1);
  while (familySize / (iterations + 1) >= alpha) iterations++;
  while (iterations > 1 && familySize / iterations < alpha) iterations--;
  return iterations;
}

export interface PermutationPowerWarning {
  code: "permutation_cannot_reject";
  familySize: number;
  iterations: number;
  alpha: number;
  smallestAdjustedPValue: number;
  minimumIterations: number;
  minimumIterationsAllowed: boolean;
  message: string;
}

/**
 * A warning when `iterations` cannot reach m/(B+1) < alpha, so a result that
 * could never reject is not read as evidence against the filter; null otherwise.
 */
export function permutationPowerWarning(
  familySize: number,
  iterations: number,
  alpha: number = PERMUTATION_WARNING_ALPHA,
): PermutationPowerWarning | null {
  const smallestAdjustedPValue = familySize / (iterations + 1);
  if (smallestAdjustedPValue < alpha) return null;
  const minimumIterations = minimumIterationsToReject(familySize, alpha);
  const minimumIterationsAllowed = minimumIterations <= PERMUTATION_MAX_ITERATIONS;
  const family = familySize === 1 ? "1 field" : `${familySize} fields (Holm)`;
  return {
    code: "permutation_cannot_reject",
    familySize,
    iterations,
    alpha,
    smallestAdjustedPValue,
    minimumIterations,
    minimumIterationsAllowed,
    message:
      `With ${family} and ${iterations} iterations the smallest achievable adjusted p-value is ` +
      `${smallestAdjustedPValue.toFixed(4)}, so no field can reach p < ${alpha}: a non-significant ` +
      `result here is not evidence against the filter. At least ${minimumIterations} iterations are needed` +
      (minimumIterationsAllowed
        ? "."
        : `, above the ${PERMUTATION_MAX_ITERATIONS} the tool allows; test fewer fields per request.`),
  };
}
