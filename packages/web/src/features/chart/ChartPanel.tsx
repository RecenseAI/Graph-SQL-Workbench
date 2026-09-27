import { useEffect, useMemo, useRef, useState } from 'react';
import { scaleBand, scaleLinear, scalePoint, scaleTime } from 'd3-scale';
import { line as d3line, area as d3area, curveMonotoneX } from 'd3-shape';
import type { QueryResult, ResultColumn } from '@gqlwb/shared';
import type { GridView } from '../../store/workbench.ts';
import { Badge, EmptyState, Select, cx } from '../../ui/primitives.tsx';
import { IconChart } from '../../app/Icons.tsx';

/**
 * Charts for a result.
 *
 * The form is chosen from the data's job, not from a menu: a time axis gets a line, categories get
 * columns, two measures with no category get a scatter. One series is drawn in a single hue with no
 * legend (the title already names it); several use the validated categorical slots in fixed order,
 * with a legend, because identity must never rest on colour alone. Every value is also in the
 * Result tab, which is the table view the palette's light-mode contrast relief requires.
 */

const MAX_SERIES = 8;
const MAX_CATEGORIES = 40;
const BAR_MAX_THICKNESS = 24;
const SURFACE_GAP = 2;

type ChartKind = 'column' | 'line' | 'scatter';

const isNumeric = (column: ResultColumn): boolean => column.cellType === 'number' || column.cellType === 'bigint';
const isTemporal = (column: ResultColumn): boolean =>
  column.cellType === 'timestamp' || column.cellType === 'date';
const isCategorical = (column: ResultColumn): boolean =>
  column.cellType === 'string' || column.cellType === 'boolean';

const TICK_FORMAT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const VALUE_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function ChartPanel({ result, view }: { result: QueryResult; view: GridView }) {
  const columns = result.columns;

  const numericColumns = useMemo(() => columns.filter(isNumeric), [columns]);
  const temporalColumn = useMemo(() => columns.find(isTemporal), [columns]);
  const categoryColumn = useMemo(() => columns.find(isCategorical), [columns]);

  // The suggested form, which the controls below can override.
  const suggested: { kind: ChartKind; x: string | null; series: string[] } = useMemo(() => {
    const firstNumeric = numericColumns[0]?.name ?? null;
    if (temporalColumn && firstNumeric) {
      return { kind: 'line', x: temporalColumn.name, series: [firstNumeric] };
    }
    if (categoryColumn && firstNumeric) {
      return { kind: 'column', x: categoryColumn.name, series: [firstNumeric] };
    }
    if (numericColumns.length >= 2) {
      const x = numericColumns[0]?.name ?? null;
      const y = numericColumns[1]?.name ?? null;
      return { kind: 'scatter', x, series: y ? [y] : [] };
    }
    return { kind: 'column', x: null, series: firstNumeric ? [firstNumeric] : [] };
  }, [categoryColumn, numericColumns, temporalColumn]);

  const [kind, setKind] = useState<ChartKind>(suggested.kind);
  const [xColumn, setXColumn] = useState<string | null>(suggested.x);
  const [series, setSeries] = useState<string[]>(suggested.series);
  const [signature, setSignature] = useState('');

  // Re-suggest whenever the result's shape changes, but keep a user's choices otherwise.
  const shapeSignature = columns.map((c) => `${c.name}:${c.cellType}`).join('|');
  useEffect(() => {
    if (shapeSignature === signature) return;
    setSignature(shapeSignature);
    setKind(suggested.kind);
    setXColumn(suggested.x);
    setSeries(suggested.series);
  }, [shapeSignature, signature, suggested]);

  const rows = view.rows;

  if (numericColumns.length === 0) {
    return (
      <EmptyState title="Nothing numeric to plot" icon={<IconChart size={22} />}>
        Add an aggregate to the statement -- COUNT, SUM, AVG -- and it becomes chartable.
      </EmptyState>
    );
  }
  if (rows.length === 0) {
    return <EmptyState title="No rows to plot" icon={<IconChart size={22} />} />;
  }

  const activeSeries = series.filter((name) => numericColumns.some((c) => c.name === name)).slice(0, MAX_SERIES);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 flex-wrap items-center gap-2 border-b border-line px-2">
        <label className="flex items-center gap-1 text-[11px] text-ink-2">
          form
          <Select value={kind} onChange={(e) => setKind(e.target.value as ChartKind)} className="h-6 w-24 text-[11px]">
            <option value="column">Columns</option>
            <option value="line">Line</option>
            <option value="scatter">Scatter</option>
          </Select>
        </label>
        <label className="flex items-center gap-1 text-[11px] text-ink-2">
          x
          <Select
            value={xColumn ?? ''}
            onChange={(e) => setXColumn(e.target.value || null)}
            className="h-6 w-32 text-[11px]"
          >
            <option value="">row number</option>
            {columns.map((column) => (
              <option key={column.name} value={column.name}>
                {column.name}
              </option>
            ))}
          </Select>
        </label>
        <span className="flex flex-wrap items-center gap-1 text-[11px] text-ink-2">
          y
          {numericColumns.map((column, index) => {
            const on = activeSeries.includes(column.name);
            const slot = activeSeries.indexOf(column.name);
            return (
              <button
                key={column.name}
                type="button"
                onClick={() =>
                  setSeries((current) =>
                    current.includes(column.name)
                      ? current.filter((n) => n !== column.name)
                      : [...current, column.name].slice(0, MAX_SERIES),
                  )
                }
                className={cx(
                  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]',
                  on ? 'border-line-strong bg-bg-3 text-ink-0' : 'border-line text-ink-3 hover:text-ink-1',
                )}
                title={on ? `Remove ${column.name}` : `Plot ${column.name}`}
              >
                {on ? (
                  <span
                    className="size-2 rounded-sm"
                    style={{ background: `var(--color-series-${(slot % MAX_SERIES) + 1})` }}
                  />
                ) : null}
                {column.name}
                {index >= MAX_SERIES && !on ? null : null}
              </button>
            );
          })}
        </span>
        <div className="flex-1" />
        {rows.length > MAX_CATEGORIES && kind === 'column' ? (
          <Badge tone="warn" title={`Showing the ${MAX_CATEGORIES} largest. Every row is in the Result tab.`}>
            top {MAX_CATEGORIES} of {view.rowCount.toLocaleString()}
          </Badge>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 p-2">
        {activeSeries.length === 0 ? (
          <EmptyState title="Pick a column to plot" icon={<IconChart size={22} />}>
            Choose one of the numeric columns above.
          </EmptyState>
        ) : (
          <Chart kind={kind} columns={columns} rows={rows} xColumn={xColumn} series={activeSeries} />
        )}
      </div>
    </div>
  );
}

interface ChartProps {
  kind: ChartKind;
  columns: ResultColumn[];
  rows: unknown[][];
  xColumn: string | null;
  series: string[];
}

interface Hover {
  x: number;
  y: number;
  label: string;
  entries: { name: string; value: number; slot: number }[];
}

function Chart({ kind, columns, rows, xColumn, series }: ChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 720, height: 300 });
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const indexOf = (name: string): number => columns.findIndex((c) => c.name === name);
  const xIndex = xColumn ? indexOf(xColumn) : -1;
  const xMeta = xIndex >= 0 ? columns[xIndex] : undefined;
  const seriesIndexes = series.map(indexOf);

  const asNumber = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  // Points, with rows that have no numeric value in any plotted series dropped.
  const points = useMemo(() => {
    const collected = rows.map((row, rowIndex) => {
      const values = seriesIndexes.map((index) => (index >= 0 ? asNumber(row[index]) : null));
      const rawX = xIndex >= 0 ? row[xIndex] : rowIndex + 1;
      return {
        rowIndex,
        label: rawX === null || rawX === undefined ? 'NULL' : String(rawX),
        rawX,
        values,
      };
    });
    const withData = collected.filter((point) => point.values.some((value) => value !== null));
    if (kind === 'column' && withData.length > MAX_CATEGORIES) {
      // Keep the largest categories; the Result tab still holds every row.
      return [...withData]
        .sort((a, b) => Math.max(...b.values.map((v) => v ?? 0)) - Math.max(...a.values.map((v) => v ?? 0)))
        .slice(0, MAX_CATEGORIES);
    }
    return withData;
  }, [rows, seriesIndexes, xIndex, kind]);

  const margin = { top: 14, right: 16, bottom: kind === 'scatter' ? 34 : 46, left: 56 };
  const width = Math.max(240, size.width);
  const height = Math.max(160, size.height);
  const plotWidth = Math.max(10, width - margin.left - margin.right);
  const plotHeight = Math.max(10, height - margin.top - margin.bottom);

  const allValues = points.flatMap((point) => point.values.filter((value): value is number => value !== null));
  const maxValue = allValues.length ? Math.max(...allValues) : 1;
  const minValue = allValues.length ? Math.min(...allValues) : 0;
  // Bars must grow from a single baseline, so zero is included unless the data is entirely negative.
  const yDomain: [number, number] =
    kind === 'scatter'
      ? [minValue, maxValue]
      : [Math.min(0, minValue), Math.max(0, maxValue)];
  const y = scaleLinear().domain(yDomain).nice(5).range([plotHeight, 0]);
  const yTicks = y.ticks(5);

  const temporal = xMeta ? isTemporal(xMeta) : false;

  return (
    <div ref={hostRef} className="relative h-full w-full">
      <svg width={width} height={height} role="img" className="overflow-visible">
        <g transform={`translate(${margin.left},${margin.top})`}>
          {/* Gridlines: hairline, solid, recessive */}
          {yTicks.map((tick) => (
            <line
              key={tick}
              x1={0}
              x2={plotWidth}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--color-grid)"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ))}
          {yTicks.map((tick) => (
            <text
              key={`label-${tick}`}
              x={-8}
              y={y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-ink-3"
              style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
            >
              {TICK_FORMAT.format(tick)}
            </text>
          ))}

          {kind === 'column' ? (
            <Columns
              points={points}
              series={series}
              y={y}
              plotWidth={plotWidth}
              plotHeight={plotHeight}
              onHover={setHover}
              margin={margin}
            />
          ) : kind === 'line' ? (
            <Lines
              points={points}
              series={series}
              y={y}
              plotWidth={plotWidth}
              plotHeight={plotHeight}
              temporal={temporal}
              onHover={setHover}
              margin={margin}
            />
          ) : (
            <Scatter
              points={points}
              series={series}
              y={y}
              plotWidth={plotWidth}
              plotHeight={plotHeight}
              onHover={setHover}
              margin={margin}
            />
          )}

          {/* Baseline sits above the marks' feet, drawn once */}
          <line
            x1={0}
            x2={plotWidth}
            y1={y(Math.max(0, yDomain[0]))}
            y2={y(Math.max(0, yDomain[0]))}
            stroke="var(--color-line-strong)"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        </g>
      </svg>

      {/* Legend: always present for two or more series; a single series is named by the axis */}
      {series.length >= 2 ? (
        <div className="pointer-events-none absolute left-0 top-0 flex flex-wrap gap-x-3 gap-y-1 pl-14 text-[10px] text-ink-1">
          {series.map((name, slot) => (
            <span key={name} className="inline-flex items-center gap-1">
              <span
                className="inline-block h-0.5 w-3 rounded-full"
                style={{ background: `var(--color-series-${(slot % MAX_SERIES) + 1})` }}
              />
              {name}
            </span>
          ))}
        </div>
      ) : null}

      {hover ? (
        <div
          className="pointer-events-none absolute z-10 min-w-28 max-w-56 rounded border border-line bg-bg-2 px-2 py-1.5 shadow-xl"
          style={{
            left: Math.min(hover.x + 12, width - 150),
            top: Math.max(0, hover.y - 10),
          }}
        >
          <p className="truncate text-[10px] text-ink-2">{hover.label}</p>
          {hover.entries.map((entry) => (
            <p key={entry.name} className="flex items-baseline gap-1.5">
              <span
                className="inline-block h-0.5 w-3 shrink-0 rounded-full"
                style={{ background: `var(--color-series-${(entry.slot % MAX_SERIES) + 1})` }}
              />
              <span className="tnum text-[11px] font-medium text-ink-0">{VALUE_FORMAT.format(entry.value)}</span>
              <span className="truncate text-[10px] text-ink-3">{entry.name}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Reads a series value, treating a missing index as a gap rather than a crash. */
const valueAt = (point: { values: (number | null)[] }, seriesIndex: number): number | null =>
  point.values[seriesIndex] ?? null;

interface MarkProps {
  points: { rowIndex: number; label: string; rawX: unknown; values: (number | null)[] }[];
  series: string[];
  y: ReturnType<typeof scaleLinear<number, number>>;
  plotWidth: number;
  plotHeight: number;
  margin: { top: number; right: number; bottom: number; left: number };
  onHover: (hover: Hover | null) => void;
  temporal?: boolean;
}

function Columns({ points, series, y, plotWidth, plotHeight, margin, onHover }: MarkProps) {
  const band = scaleBand<string>()
    .domain(points.map((point) => String(point.rowIndex)))
    .range([0, plotWidth])
    .paddingInner(0.25)
    .paddingOuter(0.15);

  const slotWidth = band.bandwidth();
  const perSeries = Math.max(1, Math.min(BAR_MAX_THICKNESS, (slotWidth - SURFACE_GAP * (series.length - 1)) / series.length));
  const groupWidth = perSeries * series.length + SURFACE_GAP * (series.length - 1);
  const baseline = y(0);

  // Only the largest value is labelled directly; the axis and tooltip carry the rest.
  const maxima = series.map((_, seriesIndex) => {
    let best = -Infinity;
    let at = -1;
    points.forEach((point, index) => {
      const value = valueAt(point, seriesIndex);
      if (value !== null && value > best) {
        best = value;
        at = index;
      }
    });
    return { at, value: best };
  });

  const showTickLabels = points.length <= 24;

  return (
    <g>
      {points.map((point, pointIndex) => {
        const slotStart = band(String(point.rowIndex)) ?? 0;
        const groupStart = slotStart + (slotWidth - groupWidth) / 2;
        return (
          <g key={point.rowIndex}>
            {series.map((name, seriesIndex) => {
              const value = valueAt(point, seriesIndex);
              if (value === null) return null;
              const x = groupStart + seriesIndex * (perSeries + SURFACE_GAP);
              const top = Math.min(y(value), baseline);
              const barHeight = Math.max(1, Math.abs(baseline - y(value)));
              const radius = Math.min(4, perSeries / 2, barHeight);
              const negative = value < 0;
              // 4px rounded data-end, square at the baseline.
              const path = negative
                ? `M ${x} ${top} h ${perSeries} v ${barHeight - radius} a ${radius} ${radius} 0 0 1 ${-radius} ${radius} h ${-(perSeries - radius * 2)} a ${radius} ${radius} 0 0 1 ${-radius} ${-radius} Z`
                : `M ${x} ${top + barHeight} v ${-(barHeight - radius)} a ${radius} ${radius} 0 0 1 ${radius} ${-radius} h ${perSeries - radius * 2} a ${radius} ${radius} 0 0 1 ${radius} ${radius} v ${barHeight - radius} Z`;
              const isMax = maxima[seriesIndex]?.at === pointIndex;
              return (
                <g key={name}>
                  <path d={path} fill={`var(--color-series-${(seriesIndex % MAX_SERIES) + 1})`} />
                  {isMax && perSeries >= 12 ? (
                    <text
                      x={x + perSeries / 2}
                      y={negative ? top + barHeight + 11 : top - 4}
                      textAnchor="middle"
                      className="fill-ink-1"
                      style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
                    >
                      {TICK_FORMAT.format(value)}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {/* Hit target spans the whole band plus its gap, so hovering never needs precision */}
            <rect
              x={slotStart}
              y={0}
              width={Math.max(slotWidth, 8)}
              height={plotHeight}
              fill="transparent"
              onPointerMove={(event) =>
                onHover({
                  x: event.nativeEvent.offsetX - margin.left + 8,
                  y: event.nativeEvent.offsetY - margin.top,
                  label: point.label,
                  entries: series
                    .map((name, seriesIndex) => ({ name, value: valueAt(point, seriesIndex), slot: seriesIndex }))
                    .filter((entry): entry is { name: string; value: number; slot: number } => entry.value !== null),
                })
              }
              onPointerLeave={() => onHover(null)}
            />
            {showTickLabels ? (
              <text
                x={slotStart + slotWidth / 2}
                y={plotHeight + 14}
                textAnchor="end"
                transform={`rotate(-35, ${slotStart + slotWidth / 2}, ${plotHeight + 14})`}
                className="fill-ink-3"
                style={{ fontSize: 10 }}
              >
                {point.label.length > 16 ? `${point.label.slice(0, 15)}...` : point.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

function Lines({ points, series, y, plotWidth, plotHeight, margin, onHover, temporal }: MarkProps) {
  const parsed = points.map((point) => {
    const time = temporal ? Date.parse(String(point.rawX)) : Number.NaN;
    return { ...point, time: Number.isFinite(time) ? time : null };
  });
  const useTime = temporal && parsed.every((point) => point.time !== null);

  // Two explicitly typed scales rather than one union, so the accessor needs no casts.
  const x = useTime
    ? scaleTime<number, number>()
        .domain([
          new Date(Math.min(...parsed.map((point) => point.time ?? 0))),
          new Date(Math.max(...parsed.map((point) => point.time ?? 0))),
        ])
        .range([0, plotWidth])
    : scalePoint<string>()
        .domain(parsed.map((point) => String(point.rowIndex)))
        .range([0, plotWidth])
        .padding(0.5);

  const xOf = (point: (typeof parsed)[number]): number =>
    'ticks' in x ? x(new Date(point.time ?? 0)) : (x(String(point.rowIndex)) ?? 0);

  const [crosshair, setCrosshair] = useState<number | null>(null);
  const showMarkers = parsed.length <= 40;

  return (
    <g>
      {series.map((name, seriesIndex) => {
        const color = `var(--color-series-${(seriesIndex % MAX_SERIES) + 1})`;
        const defined = parsed.filter((point) => valueAt(point, seriesIndex) !== null);
        const generator = d3line<(typeof parsed)[number]>()
          .x((point) => xOf(point))
          .y((point) => y(valueAt(point, seriesIndex) ?? 0))
          .curve(curveMonotoneX);
        const path = generator(defined) ?? '';
        // A single series gets a 10% wash under it, which reads as magnitude without shouting.
        const fill =
          series.length === 1
            ? d3area<(typeof parsed)[number]>()
                .x((point) => xOf(point))
                .y0(y(Math.max(0, y.domain()[0] ?? 0)))
                .y1((point) => y(valueAt(point, seriesIndex) ?? 0))
                .curve(curveMonotoneX)(defined) ?? ''
            : '';
        return (
          <g key={name}>
            {fill ? <path d={fill} fill={color} opacity={0.1} /> : null}
            <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {showMarkers
              ? defined.map((point) => (
                  <circle
                    key={point.rowIndex}
                    cx={xOf(point)}
                    cy={y(valueAt(point, seriesIndex) ?? 0)}
                    r={4}
                    fill={color}
                    stroke="var(--color-bg-1)"
                    strokeWidth={2}
                  />
                ))
              : null}
          </g>
        );
      })}

      {crosshair !== null ? (
        <line x1={crosshair} x2={crosshair} y1={0} y2={plotHeight} stroke="var(--color-line-strong)" strokeWidth={1} />
      ) : null}

      {/* One overlay finds the nearest X, so the pointer never has to hit a 2px line */}
      <rect
        x={0}
        y={0}
        width={plotWidth}
        height={plotHeight}
        fill="transparent"
        onPointerMove={(event) => {
          const offsetX = event.nativeEvent.offsetX - margin.left;
          let nearest: (typeof parsed)[number] | undefined = parsed[0];
          let bestDistance = Infinity;
          for (const point of parsed) {
            const distance = Math.abs(xOf(point) - offsetX);
            if (distance < bestDistance) {
              bestDistance = distance;
              nearest = point;
            }
          }
          if (!nearest) return;
          setCrosshair(xOf(nearest));
          onHover({
            x: xOf(nearest) + 8,
            y: event.nativeEvent.offsetY - margin.top,
            label: nearest.label,
            entries: series
              .map((name, seriesIndex) => ({ name, value: valueAt(nearest, seriesIndex), slot: seriesIndex }))
              .filter((entry): entry is { name: string; value: number; slot: number } => entry.value !== null),
          });
        }}
        onPointerLeave={() => {
          setCrosshair(null);
          onHover(null);
        }}
      />

      {parsed.length <= 16
        ? parsed.map((point) => (
            <text
              key={point.rowIndex}
              x={xOf(point)}
              y={plotHeight + 14}
              textAnchor="end"
              transform={`rotate(-35, ${xOf(point)}, ${plotHeight + 14})`}
              className="fill-ink-3"
              style={{ fontSize: 10 }}
            >
              {point.label.length > 16 ? `${point.label.slice(0, 15)}...` : point.label}
            </text>
          ))
        : null}
    </g>
  );
}

function Scatter({ points, series, y, plotWidth, plotHeight, margin, onHover }: MarkProps) {
  const xValues = points.map((point) => Number(point.rawX)).filter((value) => Number.isFinite(value));
  const x = scaleLinear()
    .domain([Math.min(...xValues, 0), Math.max(...xValues, 1)])
    .nice(5)
    .range([0, plotWidth]);

  return (
    <g>
      {x.ticks(5).map((tick) => (
        <text
          key={tick}
          x={x(tick)}
          y={plotHeight + 14}
          textAnchor="middle"
          className="fill-ink-3"
          style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
        >
          {TICK_FORMAT.format(tick)}
        </text>
      ))}
      {series.map((name, seriesIndex) => {
        const color = `var(--color-series-${(seriesIndex % MAX_SERIES) + 1})`;
        return (
          <g key={name}>
            {points.map((point) => {
              const value = valueAt(point, seriesIndex);
              const px = Number(point.rawX);
              if (value === null || !Number.isFinite(px)) return null;
              return (
                <g key={point.rowIndex}>
                  <circle cx={x(px)} cy={y(value)} r={4} fill={color} stroke="var(--color-bg-1)" strokeWidth={2} />
                  {/* A 24px transparent hit area, because an 8px dot is not a target */}
                  <circle
                    cx={x(px)}
                    cy={y(value)}
                    r={12}
                    fill="transparent"
                    onPointerMove={(event) =>
                      onHover({
                        x: event.nativeEvent.offsetX - margin.left + 8,
                        y: event.nativeEvent.offsetY - margin.top,
                        label: `${TICK_FORMAT.format(px)} on x`,
                        entries: [{ name, value, slot: seriesIndex }],
                      })
                    }
                    onPointerLeave={() => onHover(null)}
                  />
                </g>
              );
            })}
          </g>
        );
      })}
    </g>
  );
}
