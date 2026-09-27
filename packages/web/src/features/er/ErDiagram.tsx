import { useEffect, useMemo, useRef, useState } from 'react';
import dagre from '@dagrejs/dagre';
import type { Catalog } from '@gqlwb/shared';
import { useWorkbench } from '../../store/workbench.ts';
import { findRelationships, joinStatement, type Relationship } from './relationships.ts';
import { Badge, Button, EmptyState, IconButton, SectionHeader, cx } from '../../ui/primitives.tsx';
import { IconChildTable, IconClose, IconLink, IconPlayLine, IconTable } from '../../app/Icons.tsx';

/**
 * The relationship view.
 *
 * In the narrow sidebar it is a list, because a list is what fits and what you click. The diagram
 * is a modal, laid out with dagre. Both draw the same distinction: solid edges are nested lists the
 * schema guarantees, dashed edges are joins inferred from column names -- the ones GraphQL cannot
 * follow, which is why the tool exists.
 */
export function ErDiagram({ variant }: { variant: 'sidebar' | 'full' }) {
  const catalog = useWorkbench((s) => s.catalog);
  const addTab = useWorkbench((s) => s.addTab);
  const run = useWorkbench((s) => s.run);
  const [showDiagram, setShowDiagram] = useState(variant === 'full');

  const relationships = useMemo(() => (catalog ? findRelationships(catalog) : []), [catalog]);

  const openJoin = (relationship: Relationship) => {
    const table = catalog?.tables.find((t) => t.name === relationship.from);
    const id = addTab('sql', joinStatement(relationship, table));
    void run(id);
  };

  if (!catalog) {
    return (
      <div className="flex h-full flex-col">
        <SectionHeader>
          <IconLink size={13} /> Relationships
        </SectionHeader>
        <EmptyState title="No schema loaded" />
      </div>
    );
  }

  const nested = relationships.filter((r) => r.kind === 'nested');
  const inferred = relationships.filter((r) => r.kind === 'inferred');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        right={
          <Button size="sm" onClick={() => setShowDiagram(true)}>
            Diagram
          </Button>
        }
      >
        <IconLink size={13} /> Relationships
      </SectionHeader>

      <div className="min-h-0 flex-1 overflow-auto">
        {relationships.length === 0 ? (
          <p className="p-3 text-[11px] leading-relaxed text-ink-3">
            No relationships found. Nothing in this schema has a nested list or a column that looks like a foreign
            key, so every join will have to be written by hand.
          </p>
        ) : null}

        {inferred.length > 0 ? (
          <section>
            <p className="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              Inferred joins ({inferred.length})
            </p>
            <p className="px-2 pb-1 text-[10px] leading-relaxed text-ink-3">
              The schema does not model these. They are proposals from column names -- exactly the joins GraphQL
              cannot follow.
            </p>
            <ul>
              {inferred.map((relationship, index) => (
                <RelationshipRow key={index} relationship={relationship} onOpen={() => openJoin(relationship)} />
              ))}
            </ul>
          </section>
        ) : null}

        {nested.length > 0 ? (
          <section>
            <p className="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              Nested lists ({nested.length})
            </p>
            <p className="px-2 pb-1 text-[10px] leading-relaxed text-ink-3">
              Certain: these come with their parent in the same fetch.
            </p>
            <ul>
              {nested.map((relationship, index) => (
                <RelationshipRow key={index} relationship={relationship} onOpen={() => openJoin(relationship)} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {showDiagram ? (
        <DiagramModal catalog={catalog} relationships={relationships} onClose={() => setShowDiagram(false)} onOpenJoin={openJoin} />
      ) : null}
    </div>
  );
}

function RelationshipRow({ relationship, onOpen }: { relationship: Relationship; onOpen: () => void }) {
  return (
    <li className="group flex items-start gap-1 px-2 py-1 hover:bg-bg-2">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[11px] text-ink-0" title={relationship.reason}>
          {relationship.from}
          <span className="text-ink-3">.</span>
          {relationship.fromColumn}
          <span className="px-1 text-ink-3">-&gt;</span>
          {relationship.to}
          <span className="text-ink-3">.</span>
          {relationship.toColumn}
        </p>
        <p className="text-[10px] leading-snug text-ink-3">
          {relationship.kind === 'nested' ? 'nested in the parent fetch' : 'inferred from the column name'}
        </p>
      </div>
      <IconButton
        label="Write and run this join"
        size={20}
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={onOpen}
      >
        <IconPlayLine size={12} />
      </IconButton>
    </li>
  );
}

interface Laid {
  nodes: { id: string; x: number; y: number; width: number; height: number; isChild: boolean; columns: number }[];
  edges: { points: { x: number; y: number }[]; relationship: Relationship }[];
  width: number;
  height: number;
}

const NODE_WIDTH = 180;
const ROW_HEIGHT = 15;
const HEADER_HEIGHT = 22;
const MAX_ROWS = 8;

function layout(catalog: Catalog, relationships: Relationship[]): Laid {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 70, marginx: 16, marginy: 16 });
  graph.setDefaultEdgeLabel(() => ({}));

  const referenced = new Set<string>();
  for (const relationship of relationships) {
    referenced.add(relationship.from);
    referenced.add(relationship.to);
  }
  // A table with no relationships still belongs on the diagram; it is just an island.
  const tables = catalog.tables.filter((table) => referenced.has(table.name) || !table.isChild);

  for (const table of tables) {
    const columns = Math.min(MAX_ROWS, table.columns.filter((c) => !c.synthetic).length);
    graph.setNode(table.name, {
      width: NODE_WIDTH,
      height: HEADER_HEIGHT + columns * ROW_HEIGHT + 6,
    });
  }
  relationships.forEach((relationship, index) => {
    if (!graph.hasNode(relationship.from) || !graph.hasNode(relationship.to)) return;
    graph.setEdge(relationship.from, relationship.to, {}, String(index));
  });

  dagre.layout(graph);

  const nodes = tables.map((table) => {
    const node = graph.node(table.name) as { x: number; y: number; width: number; height: number };
    return {
      id: table.name,
      x: node.x - node.width / 2,
      y: node.y - node.height / 2,
      width: node.width,
      height: node.height,
      isChild: table.isChild,
      columns: Math.min(MAX_ROWS, table.columns.filter((c) => !c.synthetic).length),
    };
  });

  const edges = relationships
    .map((relationship, index) => {
      if (!graph.hasEdge(relationship.from, relationship.to, String(index))) return null;
      const edge = graph.edge(relationship.from, relationship.to, String(index)) as { points: { x: number; y: number }[] };
      return { points: edge.points ?? [], relationship };
    })
    .filter((edge): edge is { points: { x: number; y: number }[]; relationship: Relationship } => edge !== null);

  const graphMeta = graph.graph() as { width?: number; height?: number };
  return { nodes, edges, width: graphMeta.width ?? 800, height: graphMeta.height ?? 500 };
}

function DiagramModal({
  catalog,
  relationships,
  onClose,
  onOpenJoin,
}: {
  catalog: Catalog;
  relationships: Relationship[];
  onClose: () => void;
  onOpenJoin: (relationship: Relationship) => void;
}) {
  const laid = useMemo(() => layout(catalog, relationships), [catalog, relationships]);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [hovered, setHovered] = useState<string | null>(null);
  const dragging = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const byName = new Map(catalog.tables.map((t) => [t.name, t]));

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-bg-1 shadow-2xl">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
          <IconLink size={14} />
          <span className="text-xs font-semibold">Relationship diagram</span>
          <Badge tone="neutral">{laid.nodes.length} tables</Badge>
          <Badge tone="gql">{relationships.filter((r) => r.kind === 'inferred').length} inferred joins</Badge>
          <div className="flex-1" />
          <span className="hidden text-[10px] text-ink-3 sm:inline">drag to pan, scroll to zoom</span>
          <Button size="sm" onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}>
            Reset
          </Button>
          <IconButton label="Close" size={22} onClick={onClose}>
            <IconClose size={14} />
          </IconButton>
        </div>

        <div
          className="relative min-h-0 flex-1 overflow-hidden bg-bg-0"
          onPointerDown={(event) => {
            dragging.current = { x: event.clientX - transform.x, y: event.clientY - transform.y };
          }}
          onPointerMove={(event) => {
            if (!dragging.current) return;
            setTransform((current) => ({
              ...current,
              x: event.clientX - (dragging.current?.x ?? 0),
              y: event.clientY - (dragging.current?.y ?? 0),
            }));
          }}
          onPointerUp={() => {
            dragging.current = null;
          }}
          onPointerLeave={() => {
            dragging.current = null;
          }}
          onWheel={(event) => {
            event.preventDefault();
            setTransform((current) => ({
              ...current,
              scale: Math.max(0.3, Math.min(2.5, current.scale * (event.deltaY < 0 ? 1.12 : 0.89))),
            }));
          }}
          style={{ cursor: dragging.current ? 'grabbing' : 'grab' }}
        >
          <svg width="100%" height="100%">
            <g transform={`translate(${transform.x},${transform.y}) scale(${transform.scale})`}>
              {/* Edges first, so nodes sit above them */}
              {laid.edges.map((edge, index) => {
                const path = edge.points
                  .map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
                  .join(' ');
                const active = hovered === edge.relationship.from || hovered === edge.relationship.to;
                return (
                  <g key={index}>
                    <path
                      d={path}
                      fill="none"
                      stroke={edge.relationship.kind === 'nested' ? 'var(--color-gql)' : 'var(--color-sql)'}
                      strokeWidth={active ? 2 : 1.25}
                      strokeDasharray={edge.relationship.kind === 'inferred' ? '5 4' : undefined}
                      opacity={hovered && !active ? 0.25 : 0.85}
                    />
                    {active && edge.points.length > 0 ? (
                      <text
                        x={edge.points[Math.floor(edge.points.length / 2)]?.x ?? 0}
                        y={(edge.points[Math.floor(edge.points.length / 2)]?.y ?? 0) - 5}
                        textAnchor="middle"
                        className="fill-ink-1"
                        style={{ fontSize: 9 }}
                      >
                        {edge.relationship.fromColumn} = {edge.relationship.toColumn}
                      </text>
                    ) : null}
                  </g>
                );
              })}

              {laid.nodes.map((node) => {
                const table = byName.get(node.id);
                const columns = (table?.columns ?? []).filter((c) => !c.synthetic).slice(0, MAX_ROWS);
                const hiddenCount = (table?.columns.filter((c) => !c.synthetic).length ?? 0) - columns.length;
                return (
                  <g
                    key={node.id}
                    transform={`translate(${node.x},${node.y})`}
                    onPointerEnter={() => setHovered(node.id)}
                    onPointerLeave={() => setHovered(null)}
                  >
                    <rect
                      width={node.width}
                      height={node.height}
                      rx={6}
                      fill="var(--color-bg-1)"
                      stroke={hovered === node.id ? 'var(--color-sql)' : 'var(--color-line-strong)'}
                      strokeWidth={hovered === node.id ? 1.5 : 1}
                    />
                    <rect width={node.width} height={HEADER_HEIGHT} rx={6} fill="var(--color-bg-3)" />
                    <rect y={HEADER_HEIGHT - 6} width={node.width} height={6} fill="var(--color-bg-3)" />
                    <text
                      x={8}
                      y={HEADER_HEIGHT / 2 + 1}
                      dominantBaseline="middle"
                      className={cx(node.isChild ? 'fill-gql' : 'fill-ink-0')}
                      style={{ fontSize: 10.5, fontWeight: 600 }}
                    >
                      {node.id}
                    </text>
                    {columns.map((column, index) => (
                      <text
                        key={column.name}
                        x={8}
                        y={HEADER_HEIGHT + 4 + index * ROW_HEIGHT + ROW_HEIGHT / 2}
                        dominantBaseline="middle"
                        className={column.name === table?.primaryKey ? 'fill-sql' : 'fill-ink-2'}
                        style={{ fontSize: 9.5, fontFamily: 'ui-monospace, monospace' }}
                      >
                        {column.name.length > 24 ? `${column.name.slice(0, 23)}...` : column.name}
                      </text>
                    ))}
                    {hiddenCount > 0 ? (
                      <text
                        x={8}
                        y={HEADER_HEIGHT + 4 + columns.length * ROW_HEIGHT + ROW_HEIGHT / 2}
                        dominantBaseline="middle"
                        className="fill-ink-3"
                        style={{ fontSize: 9 }}
                      >
                        +{hiddenCount} more
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
          </svg>

        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-1.5 text-[10px] text-ink-2">
          <span className="flex items-center gap-1.5">
            <svg width="22" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="22" y2="3" stroke="var(--color-gql)" strokeWidth="1.5" />
            </svg>
            <IconChildTable size={11} /> nested list, fetched with its parent
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="22" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="22" y2="3" stroke="var(--color-sql)" strokeWidth="1.5" strokeDasharray="5 4" />
            </svg>
            <IconTable size={11} /> inferred join, not modelled by the schema
          </span>
        </div>

        {relationships.filter((r) => r.kind === 'inferred').length > 0 ? (
          <div className="shrink-0 border-t border-line px-3 py-2">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-ink-3">Run an inferred join</p>
            <div className="flex flex-wrap gap-1.5">
              {relationships
                .filter((r) => r.kind === 'inferred')
                .slice(0, 8)
                .map((relationship, index) => (
                  <Button
                    key={index}
                    size="sm"
                    onClick={() => {
                      onOpenJoin(relationship);
                      onClose();
                    }}
                    title={relationship.reason}
                  >
                    {relationship.from} - {relationship.to}
                  </Button>
                ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
