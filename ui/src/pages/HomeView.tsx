/** Home: the task list on the left, the open task (or a new one) on the right. */

import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import TaskList from './TaskList';
import TaskView from './TaskView';
import NewTask from './NewTask';
import TaskDetail from './TaskDetail';

export default function HomeView({ details = false, creating = false }: { details?: boolean; creating?: boolean }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const closeRef = useRef<HTMLAnchorElement>(null);
  const open = details && Boolean(id);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    if (!open) return;
    // Remember what had focus, so closing the drawer puts it back there.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') navigateRef.current(`/home/${id}`); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [open, id]);
  return (
    <div className="h-full grid grid-cols-1 md:grid-cols-[minmax(260px,30%)_1fr] gap-5 p-4 md:p-5">
      {/* p-1 -m-1: room for the selected task's ring inside the scrolling column. */}
      <div className={clsx('min-h-0 overflow-y-auto p-1 -m-1', (id || creating) && 'hidden md:block')}><TaskList selected={id ?? null} /></div>
      <div className={clsx('min-h-0 flex-col', id || creating ? 'flex' : 'hidden md:flex')}>{id ? <TaskView key={id} id={id} /> : <NewTask />}</div>
      {details && id && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30" role="dialog" aria-modal="true" aria-label="Technical details"
          onClick={(e) => { if (e.target === e.currentTarget) navigate(`/home/${id}`); }}>
          <div className="w-full max-w-3xl h-full overflow-y-auto bg-hud-bg shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-2 bg-hud-surface border-b border-hud-border">
              <span className="font-semibold">Technical details</span>
              <Link ref={closeRef} to={`/home/${id}`} className="text-sm text-hud-cyan">Close</Link>
            </div>
            <TaskDetail />
          </div>
        </div>
      )}
    </div>
  );
}
