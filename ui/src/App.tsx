import { useEffect, useState } from 'react';
import { Routes, Route, Link, NavLink, Navigate, useLocation, useParams } from 'react-router-dom';
import clsx from 'clsx';
import CommandDeck from './pages/CommandDeck';
import AgentsView from './pages/AgentsView';
import ReposView from './pages/ReposView';
import SettingsView from './pages/SettingsView';
import ConnectionsView from './pages/ConnectionsView';
import HomeView from './pages/HomeView';
import HistoryView from './pages/HistoryView';
import BoardView from './pages/BoardView';
import HealthView from './pages/HealthView';
import GraphView from './pages/GraphView';
import LessonsView from './pages/LessonsView';
import HealthStrip from './components/HealthStrip';
import SetupView, { BackToSetup } from './pages/SetupView';
import { SessionGate } from './Session';
import Toaster from './components/Toaster';
import PublicDemoBanner from './demo/DemoBanner';
import { useCoreApi } from './hooks/useSse';
import { useSystem } from './hooks/useSystem';
import { countedTokens, fmtTokens } from './agents';
import { Badge, Logo, LogoMark } from './ui';
import { MotionConfig } from 'motion/react';
import { Bot, History, LayoutGrid, MoreHorizontal, Network, X } from 'lucide-react';

/** `also`: other addresses under the same item (a task opened from the board is at /home/:id). */
/** On a phone: the four places used most, and the rest under More. */
const TABS = [
  { to: '/board', label: 'Board', icon: LayoutGrid, also: ['/home'] },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/graph', label: 'Graph', icon: Network },
  { to: '/history', label: 'History', icon: History },
];
const MORE = ['/lessons', '/health', '/setup'];

const NAV: Array<{ to: string; label: string; also?: string[] }> = [
  { to: '/board', label: 'Board', also: ['/home'] },
  { to: '/agents', label: 'Agents' },
  { to: '/graph', label: 'Graph' },
  { to: '/lessons', label: 'Lessons' },
  { to: '/health', label: 'Health' },
  { to: '/history', label: 'History' },
  { to: '/setup', label: 'Setup' },
];

export default function App() {
  // The public demo has no core and no owner to sign in: it is a replay in the browser.
  if (import.meta.env.VITE_DEMO === '1') return <Shell />;
  return (
    <SessionGate>
      <Shell />
    </SessionGate>
  );
}

type Counts = { inputTokens: number; outputTokens: number; cacheWriteTokens: number };

function WeekTokens() {
  const api = useCoreApi();
  const [tokens, setTokens] = useState<number | null>(null);
  useEffect(() => {
    const load = () => api.get('/usage/by-role?days=7').then((d) => setTokens((d.roles ?? []).reduce((n: number, r: Counts) => n + countedTokens(r), 0))).catch(() => {});
    void load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, []);
  return tokens === null ? null : <span className="text-xs text-hud-dim hidden xl:inline whitespace-nowrap">This week · {fmtTokens(tokens)} tokens</span>;
}

/** An old task link (/tasks/:id) opens the task on Home. */
function TaskRedirect() {
  const { id } = useParams();
  return <Navigate to={`/home/${id}`} replace />;
}

/** `fryday-code demo`: say plainly that the agents are stand-ins. */
function DemoBanner() {
  const system = useSystem();
  if (!system?.demo) return null;
  return (
    <div role="note" className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-1.5 text-xs text-hud-dim bg-hud-amber/10 border-b border-hud-amber/30 flex-shrink-0">
      <Badge tone="warn">Demo mode</Badge>
      <span>Stand-in agents, no AI calls. They follow a script on a sample project; nothing leaves this computer.</span>
    </div>
  );
}

/** The phone's navigation: a bar of tabs at the bottom, within thumb's reach. */
function BottomTabs({ under }: { under: (p: string) => boolean }) {
  const [more, setMore] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setMore(false), [pathname]);
  const tab = 'flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:bg-hud-cyan/10';
  return (
    <>
      {more && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40 flow-in" onClick={() => setMore(false)}>
          <div role="dialog" aria-label="More" onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-hud-surface border-t border-hud-border p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sheet-up">
            <div className="flex items-center justify-between px-1 pb-2">
              <span className="font-semibold">More</span>
              <button type="button" aria-label="Close" onClick={() => setMore(false)} className="p-1.5 rounded-lg text-hud-dim hover:text-hud-bright"><X className="w-4 h-4" /></button>
            </div>
            {NAV.filter((n) => MORE.includes(n.to)).map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => clsx('block rounded-xl px-3 py-3 text-sm', isActive ? 'bg-hud-cyan/10 text-hud-cyan font-semibold' : 'text-hud-bright hover:bg-hud-border/40')}>{n.label}</NavLink>
            ))}
          </div>
        </div>
      )}
      <nav aria-label="Main" className="md:hidden fixed inset-x-0 bottom-0 z-30 flex border-t border-hud-border bg-hud-surface/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        {TABS.map(({ to, label, icon: Icon, also }) => {
          const active = under(to) || !!also?.some(under);
          return (
            <NavLink key={to} to={to} aria-current={active ? 'page' : undefined} className={clsx(tab, active ? 'text-hud-cyan font-semibold' : 'text-hud-dim')}>
              <Icon aria-hidden className={clsx('w-5 h-5 transition-transform', active && 'scale-110')} />{label}
            </NavLink>
          );
        })}
        <button type="button" onClick={() => setMore(true)} aria-haspopup="dialog" className={clsx(tab, MORE.some(under) ? 'text-hud-cyan font-semibold' : 'text-hud-dim')}>
          <MoreHorizontal aria-hidden className="w-5 h-5" />More
        </button>
      </nav>
    </>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  return (
    <MotionConfig reducedMotion="user">
    <div className="flex flex-col h-screen overflow-hidden bg-hud-bg text-hud-bright">
      <header className="flex items-center gap-3 sm:gap-5 px-4 sm:px-5 h-14 flex-shrink-0 border-b border-hud-border bg-hud-surface">
        <Link to="/board" aria-label="FryDay Code, Board" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60">
          <span className="hidden sm:inline-flex"><Logo size={26} /></span>
          <span className="sm:hidden inline-flex"><LogoMark size={26} /></span>
        </Link>
        <nav aria-label="Main" className="hidden md:flex gap-1">
          {NAV.map(({ to, label, also }) => (
            <NavLink key={to} to={to}
              className={({ isActive }) => clsx('px-3 sm:px-3.5 py-1.5 rounded-full text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60',
                isActive || also?.some(under) ? 'bg-hud-cyan/10 text-hud-cyan font-semibold' : 'text-hud-dim hover:text-hud-bright hover:bg-hud-border/40')}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4"><HealthStrip /><WeekTokens /></div>
      </header>
      {import.meta.env.VITE_DEMO === '1' ? <PublicDemoBanner /> : <DemoBanner />}

      <Toaster />

      <main className="flex-1 min-h-0 overflow-auto pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
        <Routes>
          <Route index element={<Navigate to="/board" replace />} />
          <Route path="/board" element={<BoardView />} />
          <Route path="/health" element={<HealthView />} />
          <Route path="/agents" element={<AgentsView />} />
          <Route path="/graph" element={<GraphView />} />
          <Route path="/lessons" element={<LessonsView />} />
          <Route path="/home" element={<HomeView />} />
          <Route path="/home/new" element={<HomeView creating />} />
          <Route path="/home/:id" element={<HomeView />} />
          <Route path="/home/:id/details" element={<HomeView details />} />
          <Route path="/history" element={<HistoryView />} />
          <Route path="/setup" element={<SetupView />} />
          <Route path="/setup/projects" element={<BackToSetup><ReposView /></BackToSetup>} />
          <Route path="/setup/connections" element={<BackToSetup><ConnectionsView /></BackToSetup>} />
          <Route path="/setup/agents" element={<BackToSetup><SettingsView /></BackToSetup>} />
          <Route path="/setup/activity" element={<Navigate to="/agents" replace />} />
          <Route path="/setup/console" element={<BackToSetup><CommandDeck /></BackToSetup>} />
          {/* Earlier addresses, still used by links in Chat messages and old bookmarks. */}
          <Route path="/command" element={<Navigate to="/home" replace />} />
          <Route path="/tasks" element={<Navigate to="/home" replace />} />
          <Route path="/tasks/:id" element={<TaskRedirect />} />
          <Route path="/repos" element={<Navigate to="/setup/projects" replace />} />
          <Route path="/connections" element={<Navigate to="/setup/connections" replace />} />
          <Route path="/settings" element={<Navigate to="/setup/agents" replace />} />
          <Route path="*" element={<Navigate to="/board" replace />} />
        </Routes>
      </main>
      <BottomTabs under={under} />
    </div>
    </MotionConfig>
  );
}
