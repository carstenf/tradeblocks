import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_PERMUTATION_REQUEST_WORK_LIMIT,
  DEFAULT_PERMUTATION_WORK_LIMIT,
  PermutationWorkLimitConfigError,
  minimumIterationsToReject,
  permutationPowerWarning,
  resolvePermutationWorkLimits,
} from "../../src/utils/permutation-work-limits.ts";

describe("permutation work limits", () => {
  it("defaults to 30M per field and 90M per request when unset", () => {
    expect(resolvePermutationWorkLimits({})).toEqual({
      field: DEFAULT_PERMUTATION_WORK_LIMIT,
      request: DEFAULT_PERMUTATION_REQUEST_WORK_LIMIT,
      source: { field: "default", request: "default" },
    });
  });

  it("reads positive integers from the environment", () => {
    expect(
      resolvePermutationWorkLimits({
        TRADEBLOCKS_PERMUTATION_WORK_LIMIT: " 200000000 ",
        TRADEBLOCKS_PERMUTATION_REQUEST_WORK_LIMIT: "600000000",
      }),
    ).toEqual({
      field: 200_000_000,
      request: 600_000_000,
      source: { field: "env", request: "env" },
    });
  });

  it.each(["", "abc", "0", "-5", "1.5", "1e8", "30_000_000", "99999999999999999999"])(
    "rejects %j instead of falling back",
    (value) => {
      expect(() =>
        resolvePermutationWorkLimits({ TRADEBLOCKS_PERMUTATION_REQUEST_WORK_LIMIT: value }),
      ).toThrow(PermutationWorkLimitConfigError);
    },
  );
});

describe("permutation power warning", () => {
  it("finds the fewest iterations with m/(B+1) < alpha", () => {
    // 1/(B+1) < 0.05 needs B = 20; 4/(B+1) < 0.05 needs B = 80; 3/(B+1) needs B = 60.
    expect(minimumIterationsToReject(1)).toBe(20);
    expect(minimumIterationsToReject(3)).toBe(60);
    expect(minimumIterationsToReject(4)).toBe(80);
    for (const m of [1, 2, 3, 4, 7, 10]) {
      const b = minimumIterationsToReject(m);
      expect(m / (b + 1)).toBeLessThan(0.05);
      expect(m / b).toBeGreaterThanOrEqual(0.05);
    }
  });

  it("warns exactly when the family cannot reject", () => {
    expect(permutationPowerWarning(4, 65)).toMatchObject({
      code: "permutation_cannot_reject",
      familySize: 4,
      iterations: 65,
      smallestAdjustedPValue: 4 / 66,
      minimumIterations: 80,
      minimumIterationsAllowed: true,
    });
    expect(permutationPowerWarning(4, 79)).not.toBeNull();
    expect(permutationPowerWarning(4, 80)).toBeNull();
    expect(permutationPowerWarning(1, 19)).toMatchObject({ minimumIterations: 20 });
    expect(permutationPowerWarning(1, 20)).toBeNull();
    expect(permutationPowerWarning(30, 499)).toMatchObject({
      minimumIterations: 600,
      minimumIterationsAllowed: false,
    });
  });
});
