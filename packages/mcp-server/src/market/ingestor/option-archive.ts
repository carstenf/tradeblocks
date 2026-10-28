/**
 * Bulk import of option quotes from a local Parquet archive (#595).
 *
 * An archive holds one Parquet file per trading day with 1-minute NBBO quotes in
 * the ThetaData bulk-quote layout:
 *
 *   expiration  'YYYY-MM-DD' (VARCHAR or DATE)
 *   strike      DOUBLE (dollars)
 *   right       'C' | 'P' | 'CALL' | 'PUT'
 *   timestamp   TIMESTAMP WITH TIME ZONE (or a timestamp in America/New_York)
 *   bid, ask    DOUBLE
 *   symbol      optional option root (e.g. 'SPXW'); default ticker root
 *
 * Each file is mapped to its trading day by the last YYYY-MM-DD in its path. Per
 * day the importer filters the file (DTE range, rights, strike band), writes the
 * `option_chain` and `option_quote_minutes` partitions for (underlying, date)
 * through the stores' `writeFromSelect`, and checks the written row counts
 * against a count of the same SELECT.
 *
 * A write replaces the whole (underlying, date) partition, so a day that already
 * holds data is skipped unless the caller asks for `onExisting: "replace"`;
 * a narrower slice can then never silently delete a broader one. Skipping also
 * makes repeated calls resume where the previous call stopped.
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import type { MarketStores } from "../stores/index.ts";
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
    noMatchingRows: string[];
    noReferencePrice: string[];
    mismatched: { date: string; expected: DayCount; written: DayCount }[];
    errors: { date: string; error: string }[];
    remaining: string[];
  };
  rowsWritten: { chain: number; quotes: number };
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
export function candidateDays(from: string, to: string): { sessions: string[]; closed: string[] } {
  const sessions: string[] = [];
  const closed: string[] = [];
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
  }
  return { sessions, closed };
}

export function sourceRelation(files: readonly string[]): string {
  const list = files.map(sqlLiteral).join(", ");
  return `read_parquet([${list}], hive_partitioning = false, union_by_name = true)`;
}

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
): string {
  return (
    `SELECT ${sqlLiteral(underlying)} AS underlying, ${sqlLiteral(day)} AS date, ` +
    `${tickerExpr(rootExpr)} AS ticker, ` +
    `strftime(timezone('America/New_York', CAST("timestamp" AS TIMESTAMPTZ)), '%H:%M') AS time, ` +
    `round(bid, 2) AS bid, round(ask, 2) AS ask, ` +
    `CASE WHEN ask > 0 THEN round((bid + ask) / 2, 3) END AS mid, ` +
    `epoch_ns(CAST("timestamp" AS TIMESTAMPTZ)) AS last_updated_ns, 'nbbo' AS source ` +
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

async function dayExists(
  conn: DuckDBConnection,
  underlying: string,
  day: string,
): Promise<boolean> {
  const u = sqlLiteral(underlying);
  const d = sqlLiteral(day);
  for (const table of ["market.option_chain", "market.option_quote_minutes"]) {
    try {
      const hit = await conn.runAndReadAll(
        `SELECT 1 FROM ${table} WHERE underlying = ${u} AND date = ${d} LIMIT 1`,
      );
      if (hit.getRows().length > 0) return true;
    } catch {
      // view not created yet (no option data at all) → nothing exists
    }
  }
  return false;
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
  } catch {
    // no spot data → parity fallback per day
  }
  return out;
}

/** Forward from put-call parity on the nearest expiration at 09:35 ET. */
export async function parityReference(
  conn: DuckDBConnection,
  source: string,
): Promise<number | null> {
  const v = await scalar(
    conn,
    `WITH q AS (SELECT CAST(expiration AS DATE) AS e, strike, upper(left("right", 1)) AS r, (bid + ask) / 2 AS mid
                FROM ${source}
                WHERE strftime(timezone('America/New_York', CAST("timestamp" AS TIMESTAMPTZ)), '%H:%M') = '09:35'
                  AND bid > 0 AND ask > 0),
          n AS (SELECT min(e) AS e FROM q)
     SELECT c.strike + c.mid - p.mid FROM q c JOIN q p USING (e, strike), n
     WHERE c.r = 'C' AND p.r = 'P' AND c.e = n.e
     ORDER BY abs(c.mid - p.mid) LIMIT 1`,
  );
  return v === null ? null : Number(v);
}

async function hasSymbolColumn(conn: DuckDBConnection, source: string): Promise<boolean> {
  const rows = (await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${source}`)).getRows();
  return rows.some((r) => String(r[0]) === "symbol");
}

// ---------------------------------------------------------------- orchestration

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

  if (opts.from > opts.to) return fail(`from (${opts.from}) is after to (${opts.to})`);
  if (opts.dteMin > opts.dteMax) return fail("dteMin must be <= dteMax");

  let files: string[];
  try {
    files = await listArchiveFiles(conn, opts.path);
  } catch (err) {
    return fail(`cannot list archive files: ${err instanceof Error ? err.message : String(err)}`);
  }
  const byDate = filesByDate(files);
  result.filesFound = files.length;

  const { sessions, closed } = candidateDays(opts.from, opts.to);
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
    } else if (opts.onExisting === "skip" && (await dayExists(conn, underlying, day))) {
      result.days.skippedExisting.push(day);
    } else {
      work.push(day);
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
      let band = strikeBand(opts, null);
      if (opts.strikePct !== undefined) {
        const reference = opens.get(day) ?? (await parityReference(conn, source));
        if (reference === null) {
          result.days.noReferencePrice.push(day);
          continue;
        }
        band = strikeBand(opts, reference);
      }
      const rootExpr = opts.tickerRoot
        ? sqlLiteral(opts.tickerRoot.toUpperCase())
        : (await hasSymbolColumn(conn, source))
          ? "upper(symbol)"
          : sqlLiteral(underlying);
      const where = archiveWhere(day, opts, band);
      const chainSql = chainSelect(day, source, where, underlying, rootExpr, exerciseStyle);
      const quoteSql = quotesSelect(day, source, where, underlying, rootExpr);
      const expected: DayCount = {
        date: day,
        chainRows: Number(await scalar(conn, `SELECT count(*) FROM (${chainSql})`)),
        quoteRows: Number(await scalar(conn, `SELECT count(*) FROM (${quoteSql})`)),
      };
      if (expected.quoteRows === 0) {
        result.days.noMatchingRows.push(day);
        continue;
      }
      if (opts.dryRun) {
        result.days.planned.push(expected);
        continue;
      }
      const partition = { underlying, date: day };
      const chain = await stores.chain.writeFromSelect(partition, chainSql);
      const quotes = await stores.quote.writeFromSelect(partition, quoteSql);
      const written: DayCount = {
        date: day,
        chainRows: chain.rowCount,
        quoteRows: quotes.rowCount,
      };
      result.rowsWritten.chain += chain.rowCount;
      result.rowsWritten.quotes += quotes.rowCount;
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
