/** The approved lessons a task's agents were given, and whether each one helped this task. */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GraduationCap } from 'lucide-react';
import { useCoreApi } from '../hooks/useSse';
import { look } from '../agents';
import { Badge, type BadgeTone } from '../ui';

interface LessonUse { lessonId: number; role: string; text: string; outcome: 'helped' | 'hurt' | 'neutral' | null; state: string }

const OUTCOME: Record<string, { label: string; tone: BadgeTone }> = {
  helped: { label: 'Helped', tone: 'ok' },
  hurt: { label: 'Did not help', tone: 'warn' },
  neutral: { label: 'No difference', tone: 'neutral' },
};

export default function LessonsUsed({ taskId, version }: { taskId: string; version: string }) {
  const api = useCoreApi();
  const [used, setUsed] = useState<LessonUse[]>([]);
  useEffect(() => {
    let gone = false;
    api.get(`/lessons/tasks/${encodeURIComponent(taskId)}`).then((d) => { if (!gone) setUsed(Array.isArray(d?.used) ? d.used : []); }).catch(() => {});
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, version]);

  if (used.length === 0) return null;
  return (
    <section aria-label="Lessons used on this task" className="rounded-xl border border-hud-border p-4">
      <div className="mb-2 flex items-center gap-2">
        <GraduationCap aria-hidden className="h-4 w-4 text-hud-cyan" />
        <h3 className="text-sm font-semibold text-hud-bright">Lessons used on this task</h3>
        <Link to="/lessons" className="ml-auto text-xs text-hud-cyan hover:underline">All lessons</Link>
      </div>
      <ul className="space-y-2 text-sm">
        {used.map((u) => {
          const outcome = u.outcome ? OUTCOME[u.outcome] : null;
          return (
            <li key={`${u.lessonId}-${u.role}`} className="flex flex-wrap items-start gap-2">
              <Badge tone="accent">{look(u.role).name}</Badge>
              <span className="flex-1 min-w-[12rem] text-hud-bright">{u.text}</span>
              {outcome ? <Badge tone={outcome.tone}>{outcome.label}</Badge> : <Badge>Task still open</Badge>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
