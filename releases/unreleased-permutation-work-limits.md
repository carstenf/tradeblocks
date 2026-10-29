# filter_curve: configurable permutation work limits and a power warning

The permutation work limits of `filter_curve` can now be raised on a self-hosted
server (tradeblocks#586): `TRADEBLOCKS_PERMUTATION_WORK_LIMIT` (per field,
default 30,000,000 work units) and `TRADEBLOCKS_PERMUTATION_REQUEST_WORK_LIMIT`
(per request, default 90,000,000). Unset, behaviour is unchanged. A value that is
not a positive integer refuses the permutation with
`permutation_work_limit_config_invalid` rather than falling back to the default.

Work-limit refusals now report the effective limits (`workLimits`) and
`minimumIterationsToReject` next to `maxIterationsThatFit`.

When the admitted iterations cannot reach m/(B+1) < 0.05 for m tested fields,
the response carries a `permutation_cannot_reject` warning with the minimum
iterations needed, so a result that could never reject is not read as evidence
against the filter.
