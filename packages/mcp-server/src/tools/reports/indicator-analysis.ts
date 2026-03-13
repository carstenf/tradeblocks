/**
 * Indicator Analysis Tool
 *
 * indicator_analysis: MCP equivalent of the Indicator Analysis UI page.
 * Supports arbitrary X/Y axes — any column from market.custom_indicators OR trade P&L.
 *
 * Returns (matching the UI page exactly):
 *   - Summary: Spearman ρ, Normalized Mutual Information, KS statistic
 *   - Bin table (equal-frequency bins): n, avg Y, win%, median, std dev, Sharpe, p-value
 *   - Scatter data with OLS regression line
 *   - Time-series data (X over time, Y over time)
 *   - Rolling 30-point Spearman correlation over time
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

function stdDevPop(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
}

function stdDevSample(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
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
  const s = stdDevPop(values);
  return s === 0 ? null : m / s;
}

/** Standard normal CDF (Abramowitz & Stegun approximation) */
function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-x * x)));
}

/** Two-sided one-sample t-test H₀: μ = 0 */
function tTestPValue(values: number[]): number {
  const n = values.length;
  if (n < 2) return 1;
  const m = mean(values);
  const se = stdDevSample(values) / Math.sqrt(n);
  if (se < 1e-12) return m === 0 ? 1 : 0;
  return Math.min(1, 2 * (1 - normalCDF(Math.abs(m / se))));
}

/** Pearson correlation */
function pearsonR(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = mean(x), my = mean(y);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx, dy = y[i]! - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : Math.max(-1, Math.min(1, num / denom));
}

/** Compute ranks with tie averaging */
function getRanks(arr: number[]): number[] {
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
}

/** Spearman rank correlation with two-tailed p-value */
function spearmanWithP(x: number[], y: number[]): { rho: number; pValue: number } {
  const n = x.length;
  if (n < 4) return { rho: NaN, pValue: NaN };
  const rx = getRanks(x), ry = getRanks(y);
  const rho = pearsonR(rx, ry);
  const tStat = rho * Math.sqrt((n - 2) / Math.max(1 - rho * rho, 1e-12));
  return { rho, pValue: Math.min(1, 2 * (1 - normalCDF(Math.abs(tStat)))) };
}

/** Normalized Mutual Information (0 = independent, 1 = perfect) */
function normalizedMI(x: number[], y: number[], k: number): number {
  const n = x.length;
  if (n < 2 * k) return NaN;
  const rx = getRanks(x), ry = getRanks(y);
  const binOf = (rank: number) => Math.min(k - 1, Math.floor((rank / n) * k));
  const joint: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < n; i++) joint[binOf(rx[i]!)][binOf(ry[i]!)]++;
  const px = joint.map((row) => row.reduce((s, v) => s + v, 0) / n);
  const py = Array.from({ length: k }, (_, j) => joint.reduce((s, row) => s + row[j]!, 0) / n);
  let mi = 0, hy = 0;
  for (let i = 0; i < k; i++) {
    if (px[i]! > 0)
      for (let j = 0; j < k; j++) {
        const pij = joint[i]![j]! / n;
        if (pij > 0) mi += pij * Math.log2(pij / (px[i]! * py[j]!));
      }
    if (py[i]! > 0) hy -= py[i]! * Math.log2(py[i]!);
  }
  return hy > 0 ? Math.max(0, Math.min(1, mi / hy)) : 0;
}

/** Two-sample KS test splitting on X median */
function ksTest(xValues: number[], yValues: number[]): { d: number; pValue: number } {
  const n = xValues.length;
  if (n < 4) return { d: 0, pValue: 1 };
  const sorted = [...xValues].sort((a, b) => a - b);
  const med = sorted[Math.floor(n / 2)]!;
  const group1: number[] = [], group2: number[] = [];
  for (let i = 0; i < n; i++)
    (xValues[i]! <= med ? group1 : group2).push(yValues[i]!);
  if (!group1.length || !group2.length) return { d: 0, pValue: 1 };
  group1.sort((a, b) => a - b);
  group2.sort((a, b) => a - b);
  const allVals = [...new Set([...group1, ...group2])].sort((a, b) => a - b);
  const n1 = group1.length, n2 = group2.length;
  let d = 0, i1 = 0, i2 = 0;
  for (const v of allVals) {
    while (i1 < n1 && group1[i1]! <= v) i1++;
    while (i2 < n2 && group2[i2]! <= v) i2++;
    d = Math.max(d, Math.abs(i1 / n1 - i2 / n2));
  }
  const nEff = (n1 * n2) / (n1 + n2);
  const lambda = (Math.sqrt(nEff) + 0.12 + 0.11 / Math.sqrt(nEff)) * d;
  return { d, pValue: Math.min(1, 2 * Math.exp(-2 * lambda * lambda)) };
}

/** OLS linear regression */
function olsRegression(x: number[], y: number[]): { slope: number; intercept: number } {
  const n = x.length;
  if (n < 2) return { slope: 0, intercept: y[0] ?? 0 };
  const sumX = x.reduce((s, v) => s + v, 0);
  const sumY = y.reduce((s, v) => s + v, 0);
  const sumXY = x.reduce((s, v, i) => s + v * y[i]!, 0);
  const sumX2 = x.reduce((s, v) => s + v * v, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  return { slope, intercept: (sumY - slope * sumX) / n };
}

function r4(v: number | null | undefined): number | null {
  if (v == null || !isFinite(v)) return null;
  return Math.round(v * 10000) / 10000;
}

// ── Equal-frequency bins ──────────────────────────────────────────────────────

interface BinResult {
  binIndex: number;
  label: string;
  xMin: number;
  xMax: number;
  n: number;
  avgY: number | null;
  winPct: number | null;
  medianY: number | null;
  stdDev: number | null;
  sharpe: number | null;
  pValue: number | null;
}

function buildEqualFreqBins(
  pairs: Array<{ x: number; y: number }>,
  numBins: number,
  yIsPl: boolean
): BinResult[] {
  if (!pairs.length) return [];
  const sorted = [...pairs].sort((a, b) => a.x - b.x);
  const n = sorted.length;
  const chunkSize = Math.ceil(n / numBins);
  const results: BinResult[] = [];
  for (let i = 0; i < numBins; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, n);
    if (start >= n) break;
    const chunk = sorted.slice(start, end);
    const yVals = chunk.map((p) => p.y);
    const xMin = chunk[0]!.x, xMax = chunk[chunk.length - 1]!.x;
    const avgY = mean(yVals);
    results.push({
      binIndex: i,
      label: `Bin ${i + 1}: ${r4(xMin)} – ${r4(xMax)}`,
      xMin,
      xMax,
      n: chunk.length,
      avgY: r4(avgY),
      winPct: yIsPl ? r4((yVals.filter((v) => v > 0).length / yVals.length) * 100) : null,
      medianY: r4(median(yVals)),
      stdDev: r4(stdDevPop(yVals)),
      sharpe: r4(sharpe(yVals)),
      pValue: r4(tTestPValue(yVals)),
    });
  }
  return results;
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

// ── Register tool ─────────────────────────────────────────────────────────────

export function registerIndicatorAnalysisTool(server: McpServer, baseDir: string): void {
  server.registerTool(
    "indicator_analysis",
    {
      description:
        "MCP equivalent of the Indicator Analysis UI page. " +
        "Choose any column from market.custom_indicators OR 'pl' (trade P&L) as X or Y axis. " +
        "Returns (matching the UI): " +
        "summary stats (Spearman ρ, Normalized Mutual Information, KS statistic), " +
        "equal-frequency bin table (n, avg Y, win%, median, std dev, Sharpe, p-value per bin), " +
        "scatter data with OLS regression, time-series data, and rolling 30-point Spearman correlation. " +
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
          .describe("Number of equal-frequency bins for X axis (default: 10)"),
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

          // Build matched X/Y pairs (with date for time series)
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
          const yIsPl = yColumn === "pl";

          // ── Summary statistics (matching 3 UI metric cards) ──────────────
          const spearman = spearmanWithP(xVals, yVals);
          const mi = normalizedMI(xVals, yVals, numBins);
          const ks = ksTest(xVals, yVals);

          // ── Equal-frequency bin table ────────────────────────────────────
          const binTable = buildEqualFreqBins(
            points.map((p) => ({ x: p.x, y: p.y })),
            numBins,
            yIsPl
          );

          // ── Scatter with OLS ─────────────────────────────────────────────
          const ols = olsRegression(xVals, yVals);
          const xMin = Math.min(...xVals), xMax = Math.max(...xVals);
          const olsLine = [
            { x: r4(xMin), y: r4(ols.slope * xMin + ols.intercept) },
            { x: r4(xMax), y: r4(ols.slope * xMax + ols.intercept) },
          ];
          const scatterTruncated = points.length > maxScatterPoints;
          const scatterPoints = (scatterTruncated ? points.slice(0, maxScatterPoints) : points)
            .map((p) => ({ date: p.date, x: p.x, y: p.y }));

          // ── Time series (daily mean if multiple trades per day) ──────────
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

          // ── Rolling 30-point Spearman ─────────────────────────────────────
          const ROLLING_WINDOW = 30;
          const rollingCorr: Array<{ date: string; rho: number | null }> = [];
          for (let i = ROLLING_WINDOW - 1; i < points.length; i++) {
            const window = points.slice(i - ROLLING_WINDOW + 1, i + 1);
            const wx = window.map((p) => p.x);
            const wy = window.map((p) => p.y);
            const { rho } = spearmanWithP(wx, wy);
            rollingCorr.push({ date: points[i]!.date, rho: r4(rho) });
          }

          const summary =
            `${xColumn} vs ${yColumn} | n=${points.length} | ` +
            `Spearman ρ=${r4(spearman.rho)} (p=${r4(spearman.pValue)}) | ` +
            `NMI=${r4(mi)} | KS d=${r4(ks.d)} (p=${r4(ks.pValue)})`;

          return createToolOutput(summary, {
            blockId,
            xColumn,
            yColumn,
            numBins,
            n: points.length,
            // 3 summary stats matching the UI metric cards
            summary: {
              spearman: {
                rho: r4(spearman.rho),
                pValue: r4(spearman.pValue),
                significant: isFinite(spearman.pValue) && spearman.pValue < 0.05,
              },
              mutualInformation: {
                nmi: r4(mi),
                description: "Normalized Mutual Information (0=independent, 1=perfect)",
              },
              ksTest: {
                d: r4(ks.d),
                pValue: r4(ks.pValue),
                significant: ks.pValue < 0.05,
                description: "KS test on Y distributions: X ≤ median vs X > median",
              },
            },
            // Equal-frequency bin table
            binTable,
            // Scatter with OLS regression line
            scatter: {
              points: scatterPoints,
              truncated: scatterTruncated,
              total: points.length,
              olsLine,
              ols: { slope: r4(ols.slope), intercept: r4(ols.intercept) },
            },
            // Time series
            timeSeries: {
              x: { label: xColumn, data: xTimeSeries },
              y: { label: yColumn, data: yTimeSeries },
            },
            // Rolling 30-point Spearman
            rollingCorrelation: {
              window: ROLLING_WINDOW,
              data: rollingCorr,
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
