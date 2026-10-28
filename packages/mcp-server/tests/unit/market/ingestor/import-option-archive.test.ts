import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
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
} from "../../../../src/market/ingestor/option-archive.ts";

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
    remaining: string[];
  };
  rowsWritten: { chain: number; quotes: number };
  estimate?: { days: number };
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
    const tickers = (await stores.chain.readChain("SPX", "2026-01-16")).map((c) => c.ticker).sort();
    expect(tickers).toEqual(["SPX260116P06000000", "SPX260123P06000000"]);
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
});
