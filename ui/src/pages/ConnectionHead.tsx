/** The title row shared by the cards on the Connections page: icon, name, state and "optional". */

import type { ReactNode } from 'react';
import { Badge, type BadgeTone } from '../ui';

export default function ConnectionHead({ icon, title, state, tone = 'neutral', optional = false }: {
  icon: ReactNode;
  title: string;
  state: ReactNode;
  tone?: BadgeTone;
  optional?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span aria-hidden className="flex-shrink-0 text-hud-cyan">{icon}</span>
      <h3 className="text-sm font-semibold text-hud-bright">{title}</h3>
      <Badge tone={tone} dot>{state}</Badge>
      {optional && <span className="ml-auto text-xs text-hud-dim">Optional</span>}
    </div>
  );
}
