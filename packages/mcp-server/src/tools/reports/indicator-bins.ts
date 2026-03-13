/**
 * Indicator Bins Analysis Tool
 *
 * analyze_indicator_bins: Full equivalent of the Indicator Analysis UI page.
 * Supports arbitrary X/Y axes — any column from market.custom_indicators OR trade P&L.
 * Returns:
 *   - Bin analysis table (equal-width X bins → per-bin stats for Y)
 *   - Pearson r, Spearman ρ with p-values
 *   - Scatter data (X vs Y)
 *   - Time-series data (X over time, Y over time)
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock } from "../../utils/block-loader.js";
import { createToolOutput } from "../../utils/output-formatter.js";
import { getConnection } from "../../db/connection.js";
import { withFullSync } from "../middleware/sync-middleware.js";
import { filterByStrategy, filterByDateRange } from "../shared/filters.js";

// ── Statistics helpers ────────────────────────────────────────────────────────

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values: number[], m = mean(values)): number {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

function normalCDF(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t * (0.31938153 +
      t * (-0.356563782 +
        t * (1.781477937 +
          t * (-1.821255978 + t * 1.330274429))));
  const approx = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly;
  return z >= 0 ? approx : 1 - approx;
}

/** Two-tailed t-test p-value for H0: mean = 0 */
function tTestPValue(values: number[]): number {
  const n = values.length;
  if (n < 2) return 1;
  const m = mean(values);
  const se = stdDev(values, m) / Math.sqrt(n);
  if (se === 0) return m === 0 ? 1 : 0;
  return Math.max(0, Math.min(1, 2 * (1 - normalCDF(Math.abs(m / se)))));
}

/** Pearson correlation with two-tailed p-value */
function pearsonWithP(x: number[], y: number[]): { r: number; pValue: number } {
  const n = x.length;
  if (n < 3) return { r: 0, pValue: 1 };
  const mx = mean(x);
  const my = mean(y);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return { r: 0, pValue: 1 };
  const r = Math.max(-1, Math.min(1, num / denom));
  const t = r * Math.sqrt((n - 2) / (1 - r * r + 1e-15));
  return { r, pValue: Math.max(0, Math.min(1, 2 * (1 - normalCDF(Math.abs(t))))) };
}

/** Spearman rank correlation with two-tailed p-value */
function spearmanWithP(x: number[], y: number[]): { rho: number; pValue: number } {
  const rank = (arr: number[]) => {
    const sorted = [...arr].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array<number>(arr.length);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j < sorted.length - 1 && sorted[j + 1]!.v === sorted[i]!.v) j++;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[sorted[k]!.i] = avgRank;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(x);
  const ry = rank(y);
  const { r: rho, pValue } = pearsonWithP(rx, ry);
  return { rho, pValue };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

function sharpe(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  const s = stdDev(values, m);
  return s === 0 ? null : m / s;
}

function r4(v: number | null | undefined): number | null {
  if (v == null || !isFinite(v)) return null;
  return Math.round(v * 10000) / 10000;
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function formatTradeDate(date: Date | string): string {
  if (typeof date === "string") {
    const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  const d = typeof date === "string" ? new Date(date) : date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function resultToRecords(
  result: { columnCount: number; columnName(i: number): string; getRows(): Iterable<unknown[]> }
): Record<string, unknown>[] {
  const cols: string[] = [];
  for (let i = 0; i < result.columnCount; i++) cols.push(result.columnName(i));
  const rows: Record<string, unknown>[] = [];
  for (const row of result.getRows()) {
    const rec: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      const v = (row as unknown[])[i];
      rec[c] = typeof v === "bigint" ? Number(v) : v;
    });
    rows.push(rec);
  }
  return rows;
}

// ── Bin table ─────────────────────────────────────────────────────────────────

function buildBinTable(xVals: number[], yVals: number[], numBins: number) {
  const min = Math.min(...xVals);
  const max = Math.max(...xVals);
  if (min === max) return [];

  const binWidth = (max - min) / numBins;
  const bins: number[][] = Array.from({ length: numBins }, () => []);
  const ranges: [number, number][] = Array.from({ length: numBins }, (_, i) => [
    min + i * binWidth,
    min + (i + 1) * binWidth,
  ]);

  for (let i = 0; i < xVals.length; i++) {
    let idx = Math.floor((xVals[i]! - min) / binWidth);
    if (idx >= numBins) idx = numBins - 1;
    bins[idx]!.push(yVals[i]!);
  }

  return bins.map((group, i) => {
    const [lo, hi] = ranges[i]!;
    if (group.length === 0) return null;
    const total = group.reduce((s, v) => s + v, 0);
    const wins = group.filter((v) => v > 0).length;
    return {
      binIndex: i,
      range: `${r4(lo)} – ${r4(hi)}`,
      n: group.length,
      winPct: r4((wins / group.length) * 100),
      avgY: r4(total / group.length),
      medianY: r4(median(group)),
      totalY: r4(total),
      sharpe: r4(sharpe(group)),
      pValue: r4(tTestPValue(group)),
    };
  }).filter(Boolean);
}

// ── Register tool ─────────────────────────────────────────────────────────────

export function registerIndicatorBinsTool(server: McpServer, baseDir: string): void {
  server.registerTool(
    "analyze_indicator_bins",
    {
      description:
        "Full equivalent of the Indicator Analysis UI page. " +
        "Choose any column from market.custom_indicators OR 'pl' (trade P&L) as X or Y axis. " +
        "Returns: equal-width bin table (n, win%, avg/median/total Y, Sharpe, p-value per bin), " +
        "Pearson r and Spearman ρ with significance, scatter data, and time-series data. " +
        "Requires market.custom_indicators (import custom_indicators.csv via import_csv first).",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        xColumn: z
          .string()
          .describe(
            'X-axis: column from market.custom_indicators (e.g. "VRP_MA20") or "pl" for trade P&L'
          ),
        yColumn: z
          .string()
          .describe(
            'Y-axis: column from market.custom_indicators (e.g. "MRP_MA20") or "pl" for trade P&L'
          ),
        numBins: z
          .number()
          .min(2)
          .max(50)
          .default(10)
          .describe("Number of equal-width bins for X axis (default: 10)"),
        strategy: z.string().optional().describe("Filter to specific strategy"),
        startDate: z.string().optional().describe("Filter start date (YYYY-MM-DD)"),
        endDate: z.string().optional().describe("Filter end date (YYYY-MM-DD)"),
        maxScatterPoints: z
          .number()
          .min(10)
          .max(2000)
          .default(500)
          .describe("Max scatter data points returned (default: 500)"),
      }),
    },
    withFullSync(
      baseDir,
      async ({ blockId, xColumn, yColumn, numBins, strategy, startDate, endDate, maxScatterPoints }) => {
        try {
          const block = await loadBlock(baseDir, blockId);
          let trades = block.trades;
          trades = filterByStrategy(trades, strategy);
          trades = filterByDateRange(trades, startDate, endDate);

          if (trades.length === 0) {
            return { content: [{ type: "text", text: "No trades found matching the specified filters." }] };
          }

          // Build date → P&L map
          const tradeDateMap = new Map<string, number[]>();
          for (const trade of trades) {
            const d = formatTradeDate(trade.dateOpened);
            if (!tradeDateMap.has(d)) tradeDateMap.set(d, []);
            tradeDateMap.get(d)!.push(trade.pl);
          }

          // Determine which indicator columns we need
          const indicatorCols = new Set<string>();
          if (xColumn !== "pl") indicatorCols.add(xColumn);
          if (yColumn !== "pl") indicatorCols.add(yColumn);

          // Query custom_indicators if needed
          const indMap = new Map<string, Record<string, number>>();

          if (indicatorCols.size > 0) {
            const conn = await getConnection(baseDir);

            const tableCheck = await conn.runAndReadAll(`
              SELECT 1 FROM duckdb_tables()
              WHERE schema_name = 'market' AND table_name = 'custom_indicators'
            `);
            if (tableCheck.getRows().length === 0) {
              return {
                content: [{
                  type: "text",
                  text: "Table market.custom_indicators not found. Import custom_indicators.csv via import_csv first.",
                }],
                isError: true,
              };
            }

            for (const col of indicatorCols) {
              const colCheck = await conn.runAndReadAll(`
                SELECT 1 FROM duckdb_columns()
                WHERE schema_name = 'market' AND table_name = 'custom_indicators'
                  AND column_name = '${col}'
              `);
              if (colCheck.getRows().length === 0) {
                return {
                  content: [{
                    type: "text",
                    text: `Column "${col}" not found in market.custom_indicators.`,
                  }],
                  isError: true,
                };
              }
            }

            const tradeDates = Array.from(tradeDateMap.keys());
            const dateList = tradeDates.map((d) => `'${d}'`).join(", ");
            const colList = Array.from(indicatorCols).map((c) => `"${c}"`).join(", ");

            const result = await conn.runAndReadAll(
              `SELECT "date", ${colList} FROM market.custom_indicators WHERE "date" IN (${dateList})`
            );
            for (const rec of resultToRecords(result)) {
              const d = String(rec["date"]);
              const vals: Record<string, number> = {};
              for (const col of indicatorCols) {
                const v = Number(rec[col]);
                if (!isNaN(v)) vals[col] = v;
              }
              if (Object.keys(vals).length === indicatorCols.size) indMap.set(d, vals);
            }
          }

          // Build matched X/Y pairs
          interface Point { date: string; x: number; y: number }
          const points: Point[] = [];

          for (const [date, pnls] of tradeDateMap) {
            const indRec = indMap.get(date);
            for (const pnl of pnls) {
              const xVal = xColumn === "pl" ? pnl : (indRec?.[xColumn] ?? null);
              const yVal = yColumn === "pl" ? pnl : (indRec?.[yColumn] ?? null);
              if (xVal !== null && yVal !== null) {
                points.push({ date, x: xVal, y: yVal });
              }
            }
          }

          if (points.length < 5) {
            return {
              content: [{ type: "text", text: `Only ${points.length} matched data points (need ≥ 5).` }],
            };
          }

          points.sort((a, b) => a.date.localeCompare(b.date));
          const xVals = points.map((p) => p.x);
          const yVals = points.map((p) => p.y);
          const dates = points.map((p) => p.date);

          // Correlation
          const pearson = pearsonWithP(xVals, yVals);
          const spearman = spearmanWithP(xVals, yVals);

          // Bin table
          const binTable = buildBinTable(xVals, yVals, numBins);

          // Scatter (capped)
          const scatterTruncated = points.length > maxScatterPoints;
          const scatterData = scatterTruncated ? points.slice(0, maxScatterPoints) : points;

          // Time series (daily mean if multiple trades per day)
          const xByDate = new Map<string, number[]>();
          const yByDate = new Map<string, number[]>();
          for (const p of points) {
            if (!xByDate.has(p.date)) xByDate.set(p.date, []);
            if (!yByDate.has(p.date)) yByDate.set(p.date, []);
            xByDate.get(p.date)!.push(p.x);
            yByDate.get(p.date)!.push(p.y);
          }
          const uniqueDates = [...new Set(dates)].sort();
          const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
          const xTimeSeries = uniqueDates.map((d) => ({ date: d, value: r4(avg(xByDate.get(d)!)) }));
          const yTimeSeries = uniqueDates.map((d) => ({ date: d, value: r4(avg(yByDate.get(d)!)) }));

          const summary =
            `${xColumn} vs ${yColumn} | n=${points.length} | ` +
            `Pearson r=${r4(pearson.r)} (p=${r4(pearson.pValue)}) | ` +
            `Spearman ρ=${r4(spearman.rho)} (p=${r4(spearman.pValue)})`;

          return createToolOutput(summary, {
            blockId,
            xColumn,
            yColumn,
            numBins,
            n: points.length,
            correlations: {
              pearson: { r: r4(pearson.r), pValue: r4(pearson.pValue), significant: pearson.pValue < 0.05 },
              spearman: { rho: r4(spearman.rho), pValue: r4(spearman.pValue), significant: spearman.pValue < 0.05 },
            },
            binTable,
            scatterData: { points: scatterData, truncated: scatterTruncated, total: points.length },
            timeSeries: {
              x: { label: xColumn, data: xTimeSeries },
              y: { label: yColumn, data: yTimeSeries },
            },
          });
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
            isError: true,
          };
        }
      }
    )
  );
}
