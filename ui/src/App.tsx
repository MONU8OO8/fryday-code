import { useEffect, useState } from 'react';
import { Routes, Route, Link, NavLink, Navigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import CommandDeck from './pages/CommandDeck';
import AgentsView from './pages/AgentsView';
import ReposView from './pages/ReposView';
import SettingsView from './pages/SettingsView';
import ConnectionsView from './pages/ConnectionsView';
import HomeView from './pages/HomeView';
import HistoryView from './pages/HistoryView';
import SetupView, { BackToSetup } from './pages/SetupView';
import { SessionGate } from './Session';
import Toaster from './components/Toaster';
import PublicDemoBanner from './demo/DemoBanner';
import { useCoreApi } from './hooks/useSse';
import { useSystem } from './hooks/useSystem';
import { countedTokens, fmtTokens } from './agents';
import { Badge, Logo, LogoMark } from './ui';

const NAV = [
  { to: '/home', label: 'Home' },
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
  return tokens === null ? null : <span className="text-xs text-hud-dim hidden sm:inline whitespace-nowrap">This week · {fmtTokens(tokens)} tokens</span>;
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

function Shell() {
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-hud-bg text-hud-bright">
      <header className="flex items-center gap-3 sm:gap-5 px-4 sm:px-5 h-14 flex-shrink-0 border-b border-hud-border bg-hud-surface">
        <Link to="/home" aria-label="FryDay Code, Home" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60">
          <span className="hidden sm:inline-flex"><Logo size={26} /></span>
          <span className="sm:hidden inline-flex"><LogoMark size={26} /></span>
        </Link>
        <nav aria-label="Main" className="flex gap-1">
          {NAV.map(({ to, label }) => (
            <NavLink key={to} to={to}
              className={({ isActive }) => clsx('px-3.5 py-1.5 rounded-full text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60',
                isActive ? 'bg-hud-cyan/10 text-hud-cyan font-semibold' : 'text-hud-dim hover:text-hud-bright hover:bg-hud-border/40')}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto"><WeekTokens /></div>
      </header>
      {import.meta.env.VITE_DEMO === '1' ? <PublicDemoBanner /> : <DemoBanner />}

      <Toaster />

      <main className="flex-1 min-h-0 overflow-auto">
        <Routes>
          <Route index element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<HomeView />} />
          <Route path="/home/new" element={<HomeView creating />} />
          <Route path="/home/:id" element={<HomeView />} />
          <Route path="/home/:id/details" element={<HomeView details />} />
          <Route path="/history" element={<HistoryView />} />
          <Route path="/setup" element={<SetupView />} />
          <Route path="/setup/projects" element={<BackToSetup><ReposView /></BackToSetup>} />
          <Route path="/setup/connections" element={<BackToSetup><ConnectionsView /></BackToSetup>} />
          <Route path="/setup/agents" element={<BackToSetup><SettingsView /></BackToSetup>} />
          <Route path="/setup/activity" element={<BackToSetup><AgentsView /></BackToSetup>} />
          <Route path="/setup/console" element={<BackToSetup><CommandDeck /></BackToSetup>} />
          {/* Earlier addresses, still used by links in Chat messages and old bookmarks. */}
          <Route path="/command" element={<Navigate to="/home" replace />} />
          <Route path="/tasks" element={<Navigate to="/home" replace />} />
          <Route path="/tasks/:id" element={<TaskRedirect />} />
          <Route path="/agents" element={<Navigate to="/setup/activity" replace />} />
          <Route path="/repos" element={<Navigate to="/setup/projects" replace />} />
          <Route path="/connections" element={<Navigate to="/setup/connections" replace />} />
          <Route path="/settings" element={<Navigate to="/setup/agents" replace />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </main>
    </div>
  );
}
