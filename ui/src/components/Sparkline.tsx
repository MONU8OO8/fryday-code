/** A small line chart of 0–100 values over time, drawn as plain SVG. */

export default function Sparkline({ values, label, className = 'text-hud-cyan', height = 48 }: { values: number[]; label: string; className?: string; height?: number }) {
  const width = 240;
  if (values.length < 2) return <div style={{ height }} className="text-xs text-hud-dim flex items-center">Collecting…</div>;
  const step = width / (values.length - 1);
  const y = (v: number) => height - (Math.max(0, Math.min(100, v)) / 100) * (height - 2) - 1;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={`w-full ${className}`} style={{ height }}>
      <line x1="0" x2={width} y1={y(75)} y2={y(75)} className="stroke-hud-border" strokeDasharray="3 3" strokeWidth="1" />
      <polygon points={`0,${height} ${points} ${width},${height}`} className="fill-current opacity-10" />
      <polyline points={points} fill="none" className="stroke-current" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
