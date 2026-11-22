/**
 * The task's flow as a picture: every agent and step in order, the one working now
 * lit up, the hand-off that brought the task there moving along the line, and every
 * send-back to the Builder drawn as an arc underneath. Click a node to see what it did.
 *
 * Everything shown comes from the flow core builds from stored facts (pipeline/flow.ts).
 */

import { useMemo } from 'react';
import { look } from '../agents';

export type FlowNodeId = 'analyst' | 'planner' | 'coder' | 'checks' | 'reviewer' | 'api_tester' | 'ui_tester' | 'owner' | 'release' | 'deploy';
export type FlowNodeState = 'idle' | 'active' | 'waiting' | 'done' | 'failed' | 'skipped';

export interface FlowNode {
  id: FlowNodeId;
  label: string;
  kind: 'agent' | 'core' | 'owner';
  state: FlowNodeState;
  detail: string;
  runs: number;
  liveRunId: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}
export interface FlowEdge {
  from: FlowNodeId;
  to: FlowNodeId;
  kind: 'handoff' | 'sendback';
  at: number;
  round: number | null;
}
export interface Flow {
  nodes: FlowNode[];
  edges: FlowEdge[];
  current: { node: FlowNodeId; since: number } | null;
  /** In counted tokens (input + output + cache writes). */
  budget: { limitTokens: number; usedTokens: number };
}

const W = 1000;
const PAD = 56;
const CY = 70;
const R = 23;
/** Where arcs under the row start, below the labels. */
const ARC_TOP = CY + R + 40;

/** A theme colour (the hud.* tokens in index.css), so the picture reads in light and dark. */
const v = (name: string, alpha?: number) => (alpha === undefined ? `rgb(var(--hud-${name}))` : `rgb(var(--hud-${name}) / ${alpha})`);
/** The same colour, thinned out against the page. */
const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

const STATE_STROKE: Record<FlowNodeState, string> = {
  idle: v('dim', 0.5),
  active: '',
  waiting: v('amber'),
  done: v('green'),
  failed: v('red'),
  skipped: v('dim', 0.5),
};

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function arcPath(fromX: number, toX: number, depth: number): string {
  const y = ARC_TOP;
  return `M ${fromX} ${y} C ${fromX} ${y + depth}, ${toX} ${y + depth}, ${toX} ${y}`;
}

export default function AgentFlow({ flow, selected, onSelect, liveText }: {
  flow: Flow;
  selected: FlowNodeId | null;
  onSelect: (id: FlowNodeId) => void;
  /** What the working agent is doing right now, in a few words. */
  liveText: string | null;
}) {
  const xs = useMemo(() => {
    const gap = (W - PAD * 2) / (flow.nodes.length - 1);
    return Object.fromEntries(flow.nodes.map((n, i) => [n.id, PAD + i * gap])) as Record<FlowNodeId, number>;
  }, [flow.nodes]);
  const motion = !reducedMotion();
  const current = flow.current;
  const lastEdge = flow.edges.length ? flow.edges[flow.edges.length - 1]! : null;
  // The move that brought the task to where it is now: drawn moving while it is there.
  const arriving = current && lastEdge && lastEdge.to === current.node ? lastEdge : null;
  const sendbacks = flow.edges.filter((e) => e.kind === 'sendback' || xs[e.to] < xs[e.from]);
  const nodeOf = (id: FlowNodeId) => flow.nodes.find((n) => n.id === id)!;
  const strokeOf = (n: FlowNode) => (n.state === 'active' ? look(n.id).color : STATE_STROKE[n.state]);

  // Room under the row only for the arcs there are.
  const height = sendbacks.length ? ARC_TOP + 42 + (sendbacks.length - 1) * 14 + 16 : CY + R + 42;
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full min-w-[760px] select-none" role="img"
      aria-label={`Task flow. ${current ? `Now with the ${nodeOf(current.node).label}.` : 'Not moving.'} ${flow.nodes.map((n) => `${n.label}: ${n.state}${n.detail ? `, ${n.detail}` : ''}`).join('. ')}`}>
      <defs>
        <marker id="flow-arrow-red" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: v('red') }} />
        </marker>
        <marker id="flow-arrow-cyan" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: v('cyan') }} />
        </marker>
      </defs>

      {/* The track between neighbours: lit once the task has passed along it. */}
      {flow.nodes.slice(0, -1).map((n, i) => {
        const next = flow.nodes[i + 1]!;
        const passed = next.state !== 'idle' && next.state !== 'skipped' && n.state !== 'idle';
        return (
          <line key={`track-${n.id}`} x1={xs[n.id] + R + 4} y1={CY} x2={xs[next.id] - R - 4} y2={CY}
            style={{ stroke: passed ? v('green', 0.45) : v('border') }} strokeWidth={2} strokeDasharray={next.state === 'skipped' || n.state === 'skipped' ? '3 5' : undefined} />
        );
      })}

      {/* Every time the task went backwards (a send-back to the Builder), oldest outermost. */}
      {sendbacks.map((e, i) => {
        const depth = 42 + (sendbacks.length - 1 - i) * 14;
        const isNow = arriving === e;
        const red = e.kind === 'sendback';
        const d = arcPath(xs[e.from], xs[e.to], depth);
        return (
          <g key={`arc-${e.at}-${i}`} opacity={isNow ? 1 : 0.4}>
            <path d={d} fill="none" style={{ stroke: red ? v('red') : v('cyan') }} strokeWidth={isNow ? 2.2 : 1.4}
              className={isNow && motion ? 'flow-dash' : undefined} markerEnd={`url(#flow-arrow-${red ? 'red' : 'cyan'})`} />
            {e.round !== null && (
              <text x={(xs[e.from] + xs[e.to]) / 2} y={ARC_TOP + depth * 0.75 + 13} textAnchor="middle" fontSize={10} style={{ fill: red ? v('red') : v('cyan') }}>
                {red ? `round ${e.round} sent back` : 'back'}
              </text>
            )}
            {isNow && motion && (
              <circle r={4.5} style={{ fill: red ? v('red') : v('cyan') }}>
                <animateMotion dur="1.6s" repeatCount="indefinite" path={d} />
              </circle>
            )}
          </g>
        );
      })}

      {/* The forward hand-off that brought the task here, moving. */}
      {arriving && xs[arriving.to] > xs[arriving.from] && (() => {
        const d = `M ${xs[arriving.from] + R + 4} ${CY} L ${xs[arriving.to] - R - 4} ${CY}`;
        const color = look(arriving.to).color;
        return (
          <g key={`arrive-${arriving.from}-${arriving.to}-${arriving.at}`}>
            <path d={d} style={{ stroke: color }} strokeWidth={2.5} fill="none" className={motion ? 'flow-dash' : undefined} />
            {motion && (
              <circle r={4.5} style={{ fill: color }}>
                <animateMotion dur="1.4s" repeatCount="indefinite" path={d} />
              </circle>
            )}
          </g>
        );
      })()}

      {/* The nodes. */}
      {flow.nodes.map((n) => {
        const x = xs[n.id];
        const Icon = look(n.id).icon;
        const stroke = strokeOf(n);
        const lit = n.state === 'active' || n.state === 'waiting';
        const dim = n.state === 'idle' || n.state === 'skipped';
        return (
          <g key={n.id} onClick={() => onSelect(n.id)} style={{ cursor: 'pointer' }} opacity={n.state === 'skipped' ? 0.45 : 1}
            role="button" aria-pressed={selected === n.id} aria-label={`${n.label}: ${n.state}`} tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n.id); } }}>
            {selected === n.id && <circle cx={x} cy={CY} r={R + 7} fill="none" style={{ stroke: v('cyan', 0.5) }} strokeWidth={1.5} />}
            {lit && motion && <circle key={`ring-${current?.since}`} cx={x} cy={CY} r={R} fill="none" style={{ stroke }} strokeWidth={2} className="flow-ring" />}
            {lit && motion && <circle key={`burst-${current?.since}`} cx={x} cy={CY} r={R} style={{ fill: stroke }} className="flow-burst" />}
            <circle cx={x} cy={CY} r={R} style={{ fill: lit ? tint(stroke, 13) : v('surface'), stroke }} strokeWidth={lit ? 2.5 : 1.6}
              strokeDasharray={n.state === 'skipped' ? '3 4' : undefined} />
            <Icon x={x - 10} y={CY - 10} width={20} height={20} color={dim ? v('dim') : lit ? stroke : look(n.id).color} strokeWidth={1.8} />
            {n.state === 'done' && <circle cx={x + R * 0.72} cy={CY + R * 0.72} r={6} style={{ fill: v('green'), stroke: v('surface') }} strokeWidth={2} />}
            {n.state === 'failed' && <circle cx={x + R * 0.72} cy={CY + R * 0.72} r={6} style={{ fill: v('red'), stroke: v('surface') }} strokeWidth={2} />}
            {n.runs > 1 && (
              <g>
                <rect x={x + R * 0.45} y={CY - R - 6} width={20} height={13} rx={6.5} style={{ fill: v('border') }} />
                <text x={x + R * 0.45 + 10} y={CY - R + 4} textAnchor="middle" fontSize={9} style={{ fill: v('bright') }}>×{n.runs}</text>
              </g>
            )}
            <text x={x} y={CY + R + 17} textAnchor="middle" fontSize={12} fontWeight={lit ? 700 : 500}
              style={{ fill: dim ? v('dim') : v('bright') }} textDecoration={n.state === 'skipped' ? 'line-through' : undefined}>{n.label}</text>
            <text x={x} y={CY + R + 31} textAnchor="middle" fontSize={10} style={{ fill: n.state === 'failed' ? v('red') : v('dim') }}>
              {n.state === 'active' ? 'working' : n.state === 'waiting' ? 'waiting for you' : n.detail}
            </text>
          </g>
        );
      })}

      {/* What the working agent is doing, above it. */}
      {current && (() => {
        const x = xs[current.node];
        const node = nodeOf(current.node);
        const text = node.state === 'waiting'
          ? (node.detail === 'ready for you' ? 'the result is ready for you to look at' : node.detail ? `waiting for you · ${node.detail}` : 'waiting for you')
          : liveText;
        if (!text) return null;
        const w = 250;
        const left = Math.min(Math.max(x - w / 2, 2), W - w - 2);
        return (
          <g key={`bubble-${current.node}`}>
            <line x1={x} y1={30} x2={x} y2={CY - R - 3} style={{ stroke: strokeOf(node) }} strokeOpacity={0.6} strokeDasharray="2 3" />
            <foreignObject x={left} y={2} width={w} height={28}>
              <div className="flow-bubble flex h-full items-center gap-1.5 truncate rounded-lg border px-2 text-xs"
                style={{ borderColor: tint(strokeOf(node), 55), background: v('surface'), color: v('bright') }}>
                <span aria-hidden className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full motion-reduce:animate-none" style={{ background: strokeOf(node) }} />
                <span className="truncate">{text}</span>
              </div>
            </foreignObject>
          </g>
        );
      })()}
    </svg>
  );
}
