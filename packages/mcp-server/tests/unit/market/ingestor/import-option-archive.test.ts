import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  closeConnection,
  getConnection,
  getCurrentConnection,
} from "../../../../src/db/connection.ts";
import { createMarketStores, type MarketStores } from "../../../../src/market/stores/index.ts";
import { TickerRegistry } from "../../../../src/market/tickers/registry.ts";
import { registerMarketFetchTools } from "../../../../src/tools/market-fetch.ts";
import {
  candidateDays,
  filesByDate,
  strikeBand,
  timestampInstantExpr,
} from "../../../../src/market/ingestor/option-archive.ts";
import { resolveCanonicalMarketPartitionDir } from "../../../../src/db/market-datasets.ts";

// 2026-01-16 Fri, 2026-01-19 MLK holiday (file present, must never be imported),
// 2026-01-20 Tue, 2026-01-21 Wed (no file).
const DAYS_WITH_FILES = ["2026-01-16", "2026-01-19", "2026-01-20"];

type Result = {
  status: string;
  days: {
    ok: { date: string; chainRows: number; quoteRows: number }[];
    planned: { date: string; chainRows: number; quoteRows: number }[];
    skippedExisting: string[];
    missingInArchive: string[];
    nonTradingDays: string[];
    mismatched: { date: string }[];
    errors: { date: string; error: string }[];
    remaining: string[];
    unclassifiedDays: string[];
    offDateRows: { date: string; rows: number }[];
  };
  rowsWritten: { chain: number; quotes: number };
  strikeReference?: { date: string; source: string; price: number }[];
  estimate?: { days: number };
  error?: string;
};

/** One day file: two expirations (same day and +7), strikes 5900/6000/6100, C+P, two minutes. */
async function writeDayFile(dir: string, day: string): Promise<void> {
  const conn = getCurrentConnection();
  const year = day.slice(0, 4);
  mkdirSync(join(dir, "SPXW", year), { recursive: true });
  const target = join(dir, "SPXW", year, `${day}.parquet`);
  await conn.run(`
    COPY (
      SELECT 'SPXW' AS symbol,
             CAST(CAST(DATE '${day}' + INTERVAL (e) DAY AS DATE) AS VARCHAR) AS expiration,
             CAST(k AS DOUBLE) AS strike,
             r AS "right",
             CAST(TIMESTAMPTZ '${day} 09:35:00-05' + INTERVAL (m) MINUTE AS TIMESTAMPTZ) AS "timestamp",
             CASE WHEN r = 'CALL' THEN 6000 - k + 10.0 ELSE k - 6000 + 10.0 END AS bid,
             CASE WHEN r = 'CALL' THEN 6000 - k + 11.0 ELSE k - 6000 + 11.0 END AS ask
      FROM (VALUES (0), (7)) e(e), (VALUES (5900), (6000), (6100)) k(k),
           (VALUES ('CALL'), ('PUT')) r(r), (VALUES (0), (1)) m(m)
    ) TO '${target}' (FORMAT PARQUET)`);
}

/** Same day layout as writeDayFile, but with a naive TIMESTAMP in New York wall-clock time. */
async function writeNaiveDayFile(dir: string, day: string): Promise<void> {
  const conn = getCurrentConnection();
  mkdirSync(dir, { recursive: true });
  await conn.run(`
    COPY (
      SELECT 'SPXW' AS symbol, CAST(DATE '${day}' AS VARCHAR) AS expiration,
             CAST(k AS DOUBLE) AS strike, r AS "right",
             CAST(TIMESTAMP '${day} 09:35:00' + INTERVAL (m) MINUTE AS TIMESTAMP) AS "timestamp",
             10.0 AS bid, 11.0 AS ask
      FROM (VALUES (5900), (6000), (6100)) k(k), (VALUES ('CALL'), ('PUT')) r(r), (VALUES (0), (1)) m(m)
    ) TO '${join(dir, `${day}.parquet`)}' (FORMAT PARQUET)`);
}

describe("import_option_archive", () => {
  let dataDir: string;
  let archive: string;
  let server: McpServer;
  let client: Client;
  let stores: MarketStores;

  const call = async (args: Record<string, unknown>): Promise<Result> => {
    const out = await client.callTool({
      name: "import_option_archive",
      arguments: { path: archive, underlying: "SPX", ...args },
    });
    expect(out.isError).not.toBe(true);
    return out.structuredContent as unknown as Result;
  };
  const count = async (sql: string): Promise<number> =>
    Number((await getCurrentConnection().runAndReadAll(sql)).getRows()[0][0]);

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "option-archive-"));
    archive = join(dataDir, "archive");
    await getConnection(dataDir);
    for (const d of DAYS_WITH_FILES) await writeDayFile(archive, d);
    stores = createMarketStores({
      get conn() {
        return getCurrentConnection();
      },
      dataDir,
      parquetMode: process.env.TRADEBLOCKS_PARQUET === "true",
      tickers: new TickerRegistry([{ underlying: "SPX", roots: ["SPX", "SPXW"] }]),
    });
    server = new McpServer({ name: "option-archive-test", version: "1.0.0" });
    client = new Client({ name: "option-archive-client", version: "1.0.0" });
    registerMarketFetchTools(server, dataDir, stores);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await closeConnection();
    jest.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("dryRun classifies days and writes nothing", async () => {
    const r = await call({ from: "2026-01-16", to: "2026-01-21", dryRun: true });
    expect(r.days.nonTradingDays).toEqual(["2026-01-19"]);
    expect(r.days.missingInArchive).toEqual(["2026-01-21"]);
    expect(r.days.planned.map((d) => d.date)).toEqual(["2026-01-16", "2026-01-20"]);
    // 0DTE only: 3 strikes × C/P = 6 contracts, × 2 minutes = 12 quotes
    expect(r.days.planned[0]).toMatchObject({ chainRows: 6, quoteRows: 12 });
    expect(r.estimate?.days).toBe(2);
    expect(r.rowsWritten).toEqual({ chain: 0, quotes: 0 });
    expect(await stores.chain.hasChain("SPX", "2026-01-16")).toBe(false);
  });

  it("imports chain and quotes with verified counts and the file's root", async () => {
    const r = await call({ from: "2026-01-16", to: "2026-01-21" });
    expect(r.status).toBe("ok");
    expect(r.days.ok).toEqual([
      { date: "2026-01-16", chainRows: 6, quoteRows: 12 },
      { date: "2026-01-20", chainRows: 6, quoteRows: 12 },
    ]);
    expect(await stores.chain.hasChain("SPX", "2026-01-19")).toBe(false);
    const chain = await stores.chain.readChain("SPX", "2026-01-16");
    expect(chain.map((c) => c.ticker).sort()).toContain("SPXW260116C06000000");
    expect(chain.every((c) => c.dte === 0 && c.exercise_style === "european")).toBe(true);
    const quotes = await stores.quote.readQuotes(
      ["SPXW260116P06000000"],
      "2026-01-16",
      "2026-01-16",
    );
    expect(quotes.get("SPXW260116P06000000")).toEqual([
      expect.objectContaining({ bid: 10, ask: 11, timestamp: "2026-01-16 09:35" }),
      expect.objectContaining({ timestamp: "2026-01-16 09:36" }),
    ]);
  });

  it("skip leaves an existing day untouched; replace rewrites it", async () => {
    await call({ from: "2026-01-16", to: "2026-01-16" }); // 0DTE: 6 contracts
    const skip = await call({ from: "2026-01-16", to: "2026-01-16", dteMax: 7 });
    expect(skip.days.skippedExisting).toEqual(["2026-01-16"]);
    expect(skip.days.ok).toEqual([]);
    const sql =
      "SELECT count(*) FROM market.option_chain WHERE underlying='SPX' AND date='2026-01-16'";
    expect(await count(sql)).toBe(6);

    const replace = await call({
      from: "2026-01-16",
      to: "2026-01-16",
      dteMax: 7,
      onExisting: "replace",
    });
    expect(replace.days.ok).toEqual([{ date: "2026-01-16", chainRows: 12, quoteRows: 24 }]);
    expect(await count(sql)).toBe(12);
  });

  it("reports a row-count mismatch instead of ok", async () => {
    jest.spyOn(stores.quote, "writeFromSelect").mockResolvedValueOnce({ rowCount: 1 });
    const r = await call({ from: "2026-01-16", to: "2026-01-16" });
    expect(r.status).toBe("partial");
    expect(r.days.ok).toEqual([]);
    expect(r.days.mismatched).toEqual([
      {
        date: "2026-01-16",
        expected: { date: "2026-01-16", chainRows: 6, quoteRows: 12 },
        written: { date: "2026-01-16", chainRows: 6, quoteRows: 1 },
      },
    ]);
  });

  it("applies filters, ticker root override, strike band from parity, and maxDays", async () => {
    const r = await call({
      from: "2026-01-16",
      to: "2026-01-20",
      dteMax: 7,
      rights: "put",
      strikePct: 1,
      tickerRoot: "SPX",
      maxDays: 1,
    });
    expect(r.status).toBe("partial");
    expect(r.days.remaining).toEqual(["2026-01-20"]);
    // parity reference = 6000 → band 5940..6060 keeps strike 6000 only; puts, 2 expirations
    expect(r.days.ok).toEqual([{ date: "2026-01-16", chainRows: 2, quoteRows: 4 }]);
    expect(r.strikeReference).toEqual([{ date: "2026-01-16", source: "parity", price: 6000 }]);
    const tickers = (await stores.chain.readChain("SPX", "2026-01-16")).map((c) => c.ticker).sort();
    expect(tickers).toEqual(["SPX260116P06000000", "SPX260123P06000000"]);
  });
  const partitionFile = (dataset: "option_chain" | "option_quote_minutes", day: string) =>
    join(
      resolveCanonicalMarketPartitionDir(dataDir, dataset),
      "underlying=SPX",
      `date=${day}`,
      "data.parquet",
    );
  const chainCount = (day: string) =>
    count(`SELECT count(*) FROM market.option_chain WHERE underlying='SPX' AND date='${day}'`);
  const quoteCount = (day: string) =>
    count(
      `SELECT count(*) FROM market.option_quote_minutes WHERE underlying='SPX' AND date='${day}'`,
    );
  const leftoverBackups = (day: string) =>
    readdirSync(join(partitionFile("option_quote_minutes", day), "..")).filter((f) =>
      f.includes("import-backup"),
    );

  it("a replace the quote store refuses publishes nothing and keeps the previous day", async () => {
    await call({ from: "2026-01-16", to: "2026-01-16", dteMax: 7 }); // 12 contracts, 24 quotes
    // puts at 0 DTE only: 6 quotes < 50% of 24 → quote shrink guard refuses
    const r = await call({
      from: "2026-01-16",
      to: "2026-01-16",
      rights: "put",
      onExisting: "replace",
    });
    expect(r.status).toBe("partial");
    expect(r.days.ok).toEqual([]);
    expect(r.days.errors.map((e) => e.date)).toEqual(["2026-01-16"]);
    expect(await chainCount("2026-01-16")).toBe(12);
    expect(await quoteCount("2026-01-16")).toBe(24);
    expect(leftoverBackups("2026-01-16")).toEqual([]);
  });

  it("a failed chain write after a replace restores the previous quote partition", async () => {
    await call({ from: "2026-01-16", to: "2026-01-16" }); // 6 contracts, 12 quotes
    jest.spyOn(stores.chain, "writeFromSelect").mockRejectedValueOnce(new Error("disk full"));
    const r = await call({
      from: "2026-01-16",
      to: "2026-01-16",
      dteMax: 7,
      onExisting: "replace",
    });
    expect(r.days.ok).toEqual([]);
    expect(r.days.errors).toEqual([
      {
        date: "2026-01-16",
        error: expect.stringContaining("quote partition restored to its previous state"),
      },
    ]);
    expect(await chainCount("2026-01-16")).toBe(6);
    expect(await quoteCount("2026-01-16")).toBe(12);
    expect(leftoverBackups("2026-01-16")).toEqual([]);
  });

  it("a failed chain write on a new day leaves no quote partition behind", async () => {
    await call({ from: "2026-01-20", to: "2026-01-20" }); // another day, so the views exist
    jest.spyOn(stores.chain, "writeFromSelect").mockRejectedValueOnce(new Error("disk full"));
    const r = await call({ from: "2026-01-16", to: "2026-01-16" });
    expect(r.days.errors.map((e) => e.date)).toEqual(["2026-01-16"]);
    expect(existsSync(partitionFile("option_quote_minutes", "2026-01-16"))).toBe(false);
    expect(existsSync(partitionFile("option_chain", "2026-01-16"))).toBe(false);
    expect(await quoteCount("2026-01-16")).toBe(0);
    expect(await quoteCount("2026-01-20")).toBe(12);
  });

  it("skip fails closed when existence cannot be determined", async () => {
    const legacyDir = join(
      resolveCanonicalMarketPartitionDir(dataDir, "option_chain"),
      "date=2026-01-16",
    );
    mkdirSync(legacyDir, { recursive: true });
    // a legacy date-only chain partition: its path does not say which underlyings it holds
    await getCurrentConnection().run(
      `COPY (SELECT 'SPX' AS underlying, 'SPXW260116C06000000' AS ticker) ` +
        `TO '${join(legacyDir, "data.parquet")}' (FORMAT PARQUET)`,
    );
    const r = await call({ from: "2026-01-16", to: "2026-01-16" });
    expect(r.days.ok).toEqual([]);
    expect(r.days.skippedExisting).toEqual([]);
    expect(r.days.errors).toEqual([
      { date: "2026-01-16", error: expect.stringContaining("cannot determine") },
    ]);
    expect(r.rowsWritten).toEqual({ chain: 0, quotes: 0 });
    expect(existsSync(partitionFile("option_quote_minutes", "2026-01-16"))).toBe(false);
  });

  it("reads naive timestamps as America/New_York whatever the session time zone", async () => {
    const naive = join(dataDir, "naive");
    await writeNaiveDayFile(naive, "2026-01-16");
    await getCurrentConnection().run("SET TimeZone = 'Asia/Tokyo'");
    const r = await call({ path: naive, from: "2026-01-16", to: "2026-01-16", strikePct: 1 });
    expect(r.days.ok).toEqual([{ date: "2026-01-16", chainRows: 2, quoteRows: 4 }]);
    const times = (
      await getCurrentConnection().runAndReadAll(
        "SELECT DISTINCT time FROM market.option_quote_minutes WHERE underlying='SPX' ORDER BY time",
      )
    )
      .getRows()
      .map((row) => String(row[0]));
    // parity needs the 09:35 ET rows, so a reference was found only if the zone is right
    expect(times).toEqual(["09:35", "09:36"]);
    const ns = await count(
      "SELECT min(last_updated_ns) FROM market.option_quote_minutes WHERE underlying='SPX'",
    );
    expect(ns).toBe(Date.parse("2026-01-16T14:35:00Z") * 1e6);
  });
  it("refuses an underlying or ticker root that is not a plain symbol", async () => {
    for (const args of [
      { underlying: "../../victim" },
      { underlying: ".." },
      { tickerRoot: "SPX/../X" },
    ]) {
      const out = await client.callTool({
        name: "import_option_archive",
        arguments: {
          path: archive,
          underlying: "SPX",
          from: "2026-01-16",
          to: "2026-01-16",
          ...args,
        },
      });
      const r = out.structuredContent as unknown as Result & { status: string };
      expect(r.status).toBe("error");
      expect(r.error).toMatch(/invalid (underlying|tickerRoot)/);
    }
  });

  it("lists imported out-of-calendar days and rows dated off the file's day", async () => {
    // 2021-12-24 is an XNYS holiday before the bundled calendar; the file is imported, flagged.
    await writeDayFile(archive, "2021-12-24");
    // A file named 2026-01-22 whose rows are stamped 2026-01-20 (a misnamed copy).
    const misnamed = join(dataDir, "misnamed");
    mkdirSync(misnamed, { recursive: true });
    await getCurrentConnection().run(
      `COPY (SELECT * FROM read_parquet('${join(archive, "SPXW", "2026", "2026-01-20.parquet")}')) ` +
        `TO '${join(misnamed, "2026-01-22.parquet")}' (FORMAT PARQUET)`,
    );
    const old = await call({ from: "2021-12-24", to: "2021-12-24" });
    expect(old.days.ok.map((d) => d.date)).toEqual(["2021-12-24"]);
    expect(old.days.unclassifiedDays).toEqual(["2021-12-24"]);
    const off = await call({ path: misnamed, from: "2026-01-22", to: "2026-01-22", dteMax: 7 });
    expect(off.days.offDateRows).toEqual([{ date: "2026-01-22", rows: 12 }]);
    expect(off.days.unclassifiedDays).toEqual([]);
  });
});

describe("option-archive helpers", () => {
  it("maps files to the last date in their path", () => {
    const m = filesByDate([
      "/a/2020-01-01/x/2026-01-16.parquet",
      "/a/b.parquet",
      "/a/2026-01-20.parquet",
    ]);
    expect([...m.keys()]).toEqual(["2026-01-16", "2026-01-20"]);
  });

  it("skips weekends and known closures but keeps pre-calendar weekdays", () => {
    expect(candidateDays("2026-01-16", "2026-01-20")).toEqual({
      sessions: ["2026-01-16", "2026-01-20"],
      closed: ["2026-01-19"],
      unclassified: new Set(),
    });
    expect(candidateDays("2020-01-17", "2020-01-20").sessions).toEqual([
      "2020-01-17",
      "2020-01-20",
    ]);
  });

  it("combines absolute and percentage strike bounds", () => {
    expect(strikeBand({}, null)).toBeNull();
    expect(strikeBand({ strikePct: 10 }, 100)).toEqual({ low: 90, high: 110 });
    expect(strikeBand({ strikePct: 10, strikeMin: 95 }, 100)).toEqual({ low: 95, high: 110 });
  });
  it("normalizes timestamp column types to an instant", () => {
    expect(timestampInstantExpr("TIMESTAMP WITH TIME ZONE")).toBe(`"timestamp"`);
    expect(timestampInstantExpr("TIMESTAMP_NS")).toContain("America/New_York");
    expect(() => timestampInstantExpr("VARCHAR")).toThrow(/unsupported timestamp column type/);
  });
});
