# import_option_archive: bulk import of option quotes from a local Parquet archive

New tool `import_option_archive` (tradeblocks#595). It imports 1-minute NBBO
option quotes from a directory or glob of Parquet day files into the
`option_quote_minutes` and `option_chain` partitions, filtered by date
range, DTE, rights and strike band, with a per-day row-count check and a
`dryRun` that returns the plan and an estimate.

- Days that already hold option data are skipped by default
  (`onExisting: "skip"`), so a narrower import never deletes a broader one;
  `onExisting: "replace"` rewrites them. When it cannot be determined
  whether a day holds data, the day is reported in `days.errors` and not
  written.
- Quotes and chain of a day are published together: if either write fails,
  readers keep the previous complete day (or nothing for a new day).
- A naive `timestamp` column is read as America/New_York wall-clock time;
  results do not depend on the host time zone.
