/**
 * Bulk import of option quotes from a local Parquet archive (#595).
 *
 * An archive holds one Parquet file per trading day with 1-minute NBBO quotes in
 * the ThetaData bulk-quote layout:
 *
 *   expiration  'YYYY-MM-DD' (VARCHAR or DATE)
 *   strike      DOUBLE (dollars)
 *   right       'C' | 'P' | 'CALL' | 'PUT'
 *   timestamp   TIMESTAMP WITH TIME ZONE, or a naive TIMESTAMP read as America/New_York
 *   bid, ask    DOUBLE
 *   symbol      optional option root (e.g. 'SPXW'); default ticker root
 *
 * Each file is mapped to its trading day by the last YYYY-MM-DD in its path. Per
 * day the importer filters the file (DTE range, rights, strike band), writes the
 * `option_quote_minutes` and `option_chain` partitions for (underlying, date)
 * through the stores' `writeFromSelect`, and checks the written row counts
 * against a count of the same SELECT.
 *
 * A write replaces the whole (underlying, date) partition, so a day that already
 * holds data is skipped unless the caller asks for `onExisting: "replace"`;
 * a narrower slice can then never silently delete a broader one. Skipping also
 * makes repeated calls resume where the previous call stopped. Existence is
 * probed on the partition files; a day whose existence cannot be determined is
 * reported in `errors` and never written.
 *
 * Quotes are written before the chain because the quote writer is the one that
 * can refuse (shrink guard). If the chain write then fails, the quote partition
 * is restored (or removed for a new day). The two files are separate renames, so
 * a reader can briefly see new quotes with the old chain, and a process killed
 * between them leaves a half-written day that `skip` reports as present; run
 * `replace` over such a day to repair it.
 */
import { copyFileSync, linkSync, renameSync, statSync, unlinkSync } from "fs";
import * as path from "path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { getMarketStoresAuthority, type MarketStores } from "../stores/index.ts";
import { resolveCanonicalMarketPartitionDir } from "../../db/market-datasets.ts";
import { createMarketParquetViews } from "../../db/market-views.ts";
import {
  XNYS_SESSION_CALENDAR_SUPPORTED_FROM,
  XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH,
  isXnysSessionDate,
} from "../provenance/xnys-session-calendar.ts";

export type OptionRights = "both" | "call" | "put";
export type OnExisting = "skip" | "replace";

export interface ImportOptionArchiveOptions {
  /** Directory (searched recursively for *.parquet) or a glob such as /data/SPXW/**\/*.parquet. */
  path: string;
  from: string;
  to: string;
  underlying: string;
  /** Root written into OCC tickers. Default: the file's `symbol` column, else `underlying`. */
  tickerRoot?: string;
  dteMin: number;
  dteMax: number;
  rights: OptionRights;
  /** Keep strikes within ±strikePct % of the day's reference price. */
  strikePct?: number;
  strikeMin?: number;
  strikeMax?: number;
  exerciseStyle?: "european" | "american";
  onExisting: OnExisting;
  dryRun: boolean;
  /** Maximum number of days imported in this call (the rest is reported as remaining). */
  maxDays: number;
}

export interface DayCount {
  date: string;
  chainRows: number;
  quoteRows: number;
}

export interface ImportOptionArchiveResult {
  status: "ok" | "partial" | "error";
  dryRun: boolean;
  underlying: string;
  dateRange: { from: string; to: string };
  filesFound: number;
  days: {
    ok: DayCount[];
    planned: DayCount[];
    skippedExisting: string[];
    missingInArchive: string[];
    nonTradingDays: string[];
    /** Imported weekdays outside the 2022–2030 XNYS calendar: a holiday there is not recognised. */
    unclassifiedDays: string[];
    /** Imported days whose rows include timestamps on another America/New_York date than the path. */
    offDateRows: { date: string; rows: number }[];
    noMatchingRows: string[];
    noReferencePrice: string[];
    mismatched: { date: string; expected: DayCount; written: DayCount }[];
    errors: { date: string; error: string }[];
    remaining: string[];
  };
  rowsWritten: { chain: number; quotes: number };
  /** Strike-band reference per day when strikePct is set: first spot open, else 09:35 ET parity. */
  strikeReference?: { date: string; source: "spot_open" | "parity"; price: number }[];
  estimate?: { days: number; quoteRows: number; chainRows: number; sampledDays: number };
  error?: string;
}

const EUROPEAN_INDEX_ROOTS = new Set([
  "SPX",
  "SPXW",
  "XSP",
  "NDX",
  "NDXP",
  "RUT",
  "RUTW",
  "VIX",
  "DJX",
]);
const DATE_IN_PATH = /(\d{4}-\d{2}-\d{2})(?!.*\d{4}-\d{2}-\d{2})/;
const SAMPLE_DAYS = 5;

// ---------------------------------------------------------------- pure helpers

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Map files to trading days by the last YYYY-MM-DD in each path. */
export function filesByDate(files: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of files) {
    const m = DATE_IN_PATH.exec(f);
    if (!m) continue;
    const list = out.get(m[1]) ?? [];
    list.push(f);
    out.set(m[1], list);
  }
  return out;
}

/** Weekdays in [from, to] split into candidate sessions and known closures. */
export function candidateDays(
  from: string,
  to: string,
): { sessions: string[]; closed: string[]; unclassified: Set<string> } {
  const sessions: string[] = [];
  const closed: string[] = [];
  const unclassified = new Set<string>();
  const end = new Date(`${to}T12:00:00Z`).getTime();
  for (
    let d = new Date(`${from}T12:00:00Z`);
    d.getTime() <= end;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    const inCalendar =
      iso >= XNYS_SESSION_CALENDAR_SUPPORTED_FROM && iso <= XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH;
    if (inCalendar && !isXnysSessionDate(iso)) closed.push(iso);
    else sessions.push(iso);
    if (!inCalendar) unclassified.add(iso);
  }
  return { sessions, closed, unclassified };
}

export function sourceRelation(files: readonly string[]): string {
  const list = files.map(sqlLiteral).join(", ");
  return `read_parquet([${list}], hive_partitioning = false, union_by_name = true)`;
}

/**
 * Instant expression for the source `timestamp` column, independent of the
 * host / DuckDB session time zone: TIMESTAMPTZ is used as is, a naive
 * TIMESTAMP is read as America/New_York wall-clock time. Other types are refused.
 */
export function timestampInstantExpr(columnType: string): string {
  const t = columnType.toUpperCase();
  if (t === "TIMESTAMP WITH TIME ZONE" || t === "TIMESTAMPTZ") return `"timestamp"`;
  if (/^TIMESTAMP(_S|_MS|_NS)?$/.test(t)) {
    return `timezone('America/New_York', CAST("timestamp" AS TIMESTAMP))`;
  }
  throw new Error(
    `unsupported timestamp column type ${columnType}; expected TIMESTAMP WITH TIME ZONE ` +
      `or a naive TIMESTAMP in America/New_York`,
  );
}

/** HH:MM in America/New_York for an instant expression. */
const ET_MINUTE = (instant: string) =>
  `strftime(timezone('America/New_York', ${instant}), '%H:%M')`;

const DTE_EXPR = (day: string) =>
  `date_diff('day', DATE ${sqlLiteral(day)}, CAST(expiration AS DATE))`;

export function archiveWhere(
  day: string,
  opts: Pick<ImportOptionArchiveOptions, "dteMin" | "dteMax" | "rights">,
  band: { low: number; high: number } | null,
): string {
  const w = [`${DTE_EXPR(day)} BETWEEN ${Math.trunc(opts.dteMin)} AND ${Math.trunc(opts.dteMax)}`];
  if (opts.rights !== "both") {
    w.push(`upper(left("right", 1)) = '${opts.rights === "call" ? "C" : "P"}'`);
  }
  if (band) w.push(`strike BETWEEN ${band.low} AND ${band.high}`);
  return w.join(" AND ");
}

/** OCC ticker: ROOT + yymmdd + C/P + strike×1000 padded to 8 digits. */
export function tickerExpr(rootExpr: string): string {
  return (
    `${rootExpr} || strftime(CAST(expiration AS DATE), '%y%m%d') || upper(left("right", 1)) ` +
    `|| lpad(CAST(CAST(round(strike * 1000) AS BIGINT) AS VARCHAR), 8, '0')`
  );
}

export function chainSelect(
  day: string,
  source: string,
  where: string,
  underlying: string,
  rootExpr: string,
  exerciseStyle: string,
): string {
  return (
    `SELECT DISTINCT ${sqlLiteral(underlying)} AS underlying, ${sqlLiteral(day)} AS date, ` +
    `${tickerExpr(rootExpr)} AS ticker, ` +
    `CASE upper(left("right", 1)) WHEN 'C' THEN 'call' ELSE 'put' END AS contract_type, ` +
    `CAST(strike AS DOUBLE) AS strike, CAST(CAST(expiration AS DATE) AS VARCHAR) AS expiration, ` +
    `CAST(${DTE_EXPR(day)} AS INTEGER) AS dte, ${sqlLiteral(exerciseStyle)} AS exercise_style ` +
    `FROM ${source} WHERE ${where}`
  );
}

export function quotesSelect(
  day: string,
  source: string,
  where: string,
  underlying: string,
  rootExpr: string,
  instant: string = `"timestamp"`,
): string {
  return (
    `SELECT ${sqlLiteral(underlying)} AS underlying, ${sqlLiteral(day)} AS date, ` +
    `${tickerExpr(rootExpr)} AS ticker, ` +
    `${ET_MINUTE(instant)} AS time, ` +
    `round(bid, 2) AS bid, round(ask, 2) AS ask, ` +
    `CASE WHEN ask > 0 THEN round((bid + ask) / 2, 3) END AS mid, ` +
    `epoch_ns(${instant}) AS last_updated_ns, 'nbbo' AS source ` +
    `FROM ${source} WHERE ${where}`
  );
}

/** Strike band from explicit bounds and/or a percentage around a reference price. */
export function strikeBand(
  opts: Pick<ImportOptionArchiveOptions, "strikePct" | "strikeMin" | "strikeMax">,
  reference: number | null,
): { low: number; high: number } | null {
  let low = opts.strikeMin ?? -Infinity;
  let high = opts.strikeMax ?? Infinity;
  if (opts.strikePct !== undefined && reference !== null) {
    low = Math.max(low, reference * (1 - opts.strikePct / 100));
    high = Math.min(high, reference * (1 + opts.strikePct / 100));
  }
  if (low === -Infinity && high === Infinity) return null;
  return {
    low: low === -Infinity ? -1e12 : Number(low.toFixed(4)),
    high: high === Infinity ? 1e12 : Number(high.toFixed(4)),
  };
}

// ---------------------------------------------------------------- partition files

export type DayExistence = "present" | "absent" | { unknown: string };

interface PartitionFiles {
  chain: string;
  quote: string;
}

function partitionFiles(dataDir: string, underlying: string, day: string): PartitionFiles {
  const file = (dataset: "option_chain" | "option_quote_minutes") =>
    path.join(
      resolveCanonicalMarketPartitionDir(dataDir, dataset),
      `underlying=${underlying}`,
      `date=${day}`,
      "data.parquet",
    );
  return { chain: file("option_chain"), quote: file("option_quote_minutes") };
}

/** true / false from the file system; throws on anything but "does not exist". */
function fileExists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Whether (underlying, day) already holds option data, probed on the partition
 * files. Fails closed: a probe error, or a legacy date-only chain partition for
 * the day (whose underlyings its path does not show), is `unknown`, never `absent`.
 */
export function dayExistence(dataDir: string, underlying: string, day: string): DayExistence {
  try {
    const files = partitionFiles(dataDir, underlying, day);
    if (fileExists(files.chain) || fileExists(files.quote)) return "present";
    const legacy = path.join(
      resolveCanonicalMarketPartitionDir(dataDir, "option_chain"),
      `date=${day}`,
      "data.parquet",
    );
    if (fileExists(legacy)) {
      return { unknown: `a legacy date-only option_chain partition exists for ${day}` };
    }
    return "absent";
  } catch (err) {
    return { unknown: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Keep the current file (if any) under a backup name. A hard link is enough
 * because the writer publishes by rename, which leaves the old inode intact.
 */
function snapshot(file: string): string | null {
  if (!fileExists(file)) return null;
  const backup = `${file}.import-backup-${process.pid}-${Date.now()}`;
  try {
    linkSync(file, backup);
  } catch {
    copyFileSync(file, backup);
  }
  return backup;
}

function discard(backup: string | null): void {
  if (!backup) return;
  try {
    unlinkSync(backup);
  } catch {
    /* best-effort */
  }
}

/** Put a file back to its snapshot, or remove it when there was none. */
function restore(file: string, backup: string | null): void {
  if (backup) renameSync(backup, file);
  else if (fileExists(file)) unlinkSync(file);
}

// ---------------------------------------------------------------- DB helpers

async function scalar(conn: DuckDBConnection, sql: string): Promise<unknown> {
  const rows = (await conn.runAndReadAll(sql)).getRows();
  return rows.length ? rows[0][0] : null;
}

export async function listArchiveFiles(conn: DuckDBConnection, path: string): Promise<string[]> {
  const pattern = /[*?[]/.test(path) ? path : `${path.replace(/\/+$/, "")}/**/*.parquet`;
  const rows = (
    await conn.runAndReadAll(`SELECT file FROM glob(${sqlLiteral(pattern)}) ORDER BY file`)
  ).getRows();
  return rows.map((r) => String(r[0]));
}

async function spotOpens(
  conn: DuckDBConnection,
  ticker: string,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const rows = (
      await conn.runAndReadAll(
        `SELECT CAST(date AS VARCHAR), arg_min(open, time) FROM market.spot ` +
          `WHERE ticker = ${sqlLiteral(ticker)} AND date BETWEEN ${sqlLiteral(from)} AND ${sqlLiteral(to)} ` +
          `GROUP BY date`,
      )
    ).getRows();
    for (const [d, o] of rows) if (o !== null) out.set(String(d).slice(0, 10), Number(o));
  } catch (err) {
    // Only a missing spot view means "no spot data"; any other read error must surface.
    const message = err instanceof Error ? err.message : String(err);
    if (!/does not exist|not found/i.test(message)) throw err;
  }
  return out;
}

/** Forward from put-call parity on the nearest expiration at 09:35 ET. */
export async function parityReference(
  conn: DuckDBConnection,
  source: string,
  instant: string = `"timestamp"`,
): Promise<number | null> {
  const v = await scalar(
    conn,
    `WITH q AS (SELECT CAST(expiration AS DATE) AS e, strike, upper(left("right", 1)) AS r, (bid + ask) / 2 AS mid
                FROM ${source}
                WHERE ${ET_MINUTE(instant)} = '09:35'
                  AND bid > 0 AND ask > 0),
          n AS (SELECT min(e) AS e FROM q)
     SELECT c.strike + c.mid - p.mid FROM q c JOIN q p USING (e, strike), n
     WHERE c.r = 'C' AND p.r = 'P' AND c.e = n.e
     ORDER BY abs(c.mid - p.mid) LIMIT 1`,
  );
  return v === null ? null : Number(v);
}

/** Whether the file has a `symbol` column, and the instant expression for its `timestamp`. */
async function describeSource(
  conn: DuckDBConnection,
  source: string,
): Promise<{ hasSymbol: boolean; instant: string }> {
  const rows = (await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${source}`)).getRows();
  const ts = rows.find((r) => String(r[0]) === "timestamp");
  if (!ts) throw new Error("archive file has no timestamp column");
  return {
    hasSymbol: rows.some((r) => String(r[0]) === "symbol"),
    instant: timestampInstantExpr(String(ts[1])),
  };
}

// ---------------------------------------------------------------- orchestration

/**
 * Write one day as a pair: quotes first (the write that can refuse), chain
 * second. A failed quote write publishes nothing; a failed chain write puts the
 * quote partition back as it was, so readers keep the previous complete day
 * (or, for a new day, nothing).
 */
async function writeDay(
  conn: DuckDBConnection,
  stores: MarketStores,
  dataDir: string,
  partition: { underlying: string; date: string },
  chainSql: string,
  quoteSql: string,
): Promise<{ chain: { rowCount: number }; quotes: { rowCount: number } }> {
  const files = partitionFiles(dataDir, partition.underlying, partition.date);
  const quoteBackup = snapshot(files.quote);
  let quotes: { rowCount: number };
  try {
    quotes = await stores.quote.writeFromSelect(partition, quoteSql);
  } catch (err) {
    discard(quoteBackup);
    throw err;
  }
  try {
    const chain = await stores.chain.writeFromSelect(partition, chainSql);
    discard(quoteBackup);
    return { chain, quotes };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      restore(files.quote, quoteBackup);
    } catch (restoreErr) {
      const why = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      throw new Error(
        `chain write failed (${reason}) and restoring the quote partition failed (${why}); ` +
          `check ${files.quote}` +
          (quoteBackup ? ` (previous version kept at ${quoteBackup})` : ""),
      );
    }
    try {
      await createMarketParquetViews(conn, dataDir);
    } catch (viewErr) {
      const why = viewErr instanceof Error ? viewErr.message : String(viewErr);
      throw new Error(
        `chain write failed (${reason}); quote partition restored to its previous state, ` +
          `but refreshing the market views failed (${why}); restart the server to rebuild them`,
      );
    }
    throw new Error(
      `chain write failed (${reason}); quote partition restored to its previous state`,
    );
  }
}

export async function importOptionArchive(
  conn: DuckDBConnection,
  stores: MarketStores,
  opts: ImportOptionArchiveOptions,
): Promise<ImportOptionArchiveResult> {
  const underlying = opts.underlying.toUpperCase();
  const result: ImportOptionArchiveResult = {
    status: "ok",
    dryRun: opts.dryRun,
    underlying,
    dateRange: { from: opts.from, to: opts.to },
    filesFound: 0,
    days: {
      ok: [],
      planned: [],
      skippedExisting: [],
      missingInArchive: [],
      nonTradingDays: [],
      unclassifiedDays: [],
      offDateRows: [],
      noMatchingRows: [],
      noReferencePrice: [],
      mismatched: [],
      errors: [],
      remaining: [],
    },
    rowsWritten: { chain: 0, quotes: 0 },
  };
  const fail = (error: string): ImportOptionArchiveResult => ({
    ...result,
    status: "error",
    error,
  });

  if (!/^[A-Z0-9._-]+$/.test(underlying) || underlying === "." || underlying === "..") {
    return fail(
      `invalid underlying ${JSON.stringify(opts.underlying)}: use letters, digits, '.', '_' or '-'`,
    );
  }
  if (opts.tickerRoot !== undefined && !/^[A-Za-z0-9]+$/.test(opts.tickerRoot)) {
    return fail(`invalid tickerRoot ${JSON.stringify(opts.tickerRoot)}: use letters and digits`);
  }
  if (opts.from > opts.to) return fail(`from (${opts.from}) is after to (${opts.to})`);
  if (opts.dteMin > opts.dteMax) return fail("dteMin must be <= dteMax");
  const dataDir = getMarketStoresAuthority(stores)?.dataRoot;
  if (!dataDir)
    return fail("market stores carry no data root; option partitions cannot be located");

  let files: string[];
  try {
    files = await listArchiveFiles(conn, opts.path);
  } catch (err) {
    return fail(`cannot list archive files: ${err instanceof Error ? err.message : String(err)}`);
  }
  const byDate = filesByDate(files);
  result.filesFound = files.length;

  const { sessions, closed, unclassified } = candidateDays(opts.from, opts.to);
  result.days.nonTradingDays = closed;
  const opens =
    opts.strikePct !== undefined
      ? await spotOpens(conn, underlying, opts.from, opts.to)
      : new Map();
  const exerciseStyle =
    opts.exerciseStyle ??
    (EUROPEAN_INDEX_ROOTS.has(underlying) ||
    EUROPEAN_INDEX_ROOTS.has((opts.tickerRoot ?? "").toUpperCase())
      ? "european"
      : "american");

  // Classify days first; the work list is what remains after skips.
  const work: string[] = [];
  for (const day of sessions) {
    if (!byDate.has(day)) {
      result.days.missingInArchive.push(day);
      continue;
    }
    if (opts.onExisting === "replace") {
      work.push(day);
      continue;
    }
    const existence = dayExistence(dataDir, underlying, day);
    if (existence === "present") result.days.skippedExisting.push(day);
    else if (existence === "absent") work.push(day);
    else {
      result.days.errors.push({
        date: day,
        error: `cannot determine whether the day already holds data (${existence.unknown}); not written`,
      });
    }
  }

  const sample = opts.dryRun
    ? work
        .filter((_, i) => i % Math.max(1, Math.floor(work.length / SAMPLE_DAYS)) === 0)
        .slice(0, SAMPLE_DAYS)
    : work.slice(0, opts.maxDays);
  if (!opts.dryRun) result.days.remaining = work.slice(opts.maxDays);

  for (const day of sample) {
    const source = sourceRelation(byDate.get(day)!);
    try {
      const described = await describeSource(conn, source);
      let band = strikeBand(opts, null);
      if (opts.strikePct !== undefined) {
        const spot = opens.get(day);
        const reference = spot ?? (await parityReference(conn, source, described.instant));
        if (reference === null) {
          result.days.noReferencePrice.push(day);
          continue;
        }
        (result.strikeReference ??= []).push({
          date: day,
          source: spot !== undefined ? "spot_open" : "parity",
          price: reference,
        });
        band = strikeBand(opts, reference);
      }
      const rootExpr = opts.tickerRoot
        ? sqlLiteral(opts.tickerRoot.toUpperCase())
        : described.hasSymbol
          ? "upper(symbol)"
          : sqlLiteral(underlying);
      const where = archiveWhere(day, opts, band);
      const chainSql = chainSelect(day, source, where, underlying, rootExpr, exerciseStyle);
      const quoteSql = quotesSelect(day, source, where, underlying, rootExpr, described.instant);
      const expected: DayCount = {
        date: day,
        chainRows: Number(await scalar(conn, `SELECT count(*) FROM (${chainSql})`)),
        quoteRows: Number(await scalar(conn, `SELECT count(*) FROM (${quoteSql})`)),
      };
      if (expected.quoteRows === 0) {
        result.days.noMatchingRows.push(day);
        continue;
      }
      const offDate = Number(
        await scalar(
          conn,
          `SELECT count(*) FROM ${source} WHERE ${where} AND ` +
            `CAST(timezone('America/New_York', ${described.instant}) AS DATE) <> DATE ${sqlLiteral(day)}`,
        ),
      );
      if (opts.dryRun) {
        result.days.planned.push(expected);
        if (offDate > 0) result.days.offDateRows.push({ date: day, rows: offDate });
        continue;
      }
      const partition = { underlying, date: day };
      const { chain, quotes } = await writeDay(
        conn,
        stores,
        dataDir,
        partition,
        chainSql,
        quoteSql,
      );
      const written: DayCount = {
        date: day,
        chainRows: chain.rowCount,
        quoteRows: quotes.rowCount,
      };
      result.rowsWritten.chain += chain.rowCount;
      result.rowsWritten.quotes += quotes.rowCount;
      if (offDate > 0) result.days.offDateRows.push({ date: day, rows: offDate });
      if (unclassified.has(day)) result.days.unclassifiedDays.push(day);
      if (written.chainRows === expected.chainRows && written.quoteRows === expected.quoteRows) {
        result.days.ok.push(written);
      } else {
        result.days.mismatched.push({ date: day, expected, written });
      }
    } catch (err) {
      result.days.errors.push({
        date: day,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (opts.dryRun) {
    const planned = result.days.planned;
    const per = (k: "quoteRows" | "chainRows") =>
      planned.length ? planned.reduce((s, d) => s + d[k], 0) / planned.length : 0;
    result.estimate = {
      days: work.length,
      sampledDays: planned.length,
      quoteRows: Math.round(per("quoteRows") * work.length),
      chainRows: Math.round(per("chainRows") * work.length),
    };
  }
  if (result.days.mismatched.length || result.days.errors.length || result.days.remaining.length) {
    result.status = "partial";
  }
  return result;
}
