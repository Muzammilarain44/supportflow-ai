import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { BarChart3, ChevronLeft, ChevronRight, Inbox, BookOpen, LayoutDashboard, LogOut, MessageSquare, Settings, Ticket, Users, Workflow, Zap } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Skeleton } from './ui';
import { useWorkspace } from '../context/WorkspaceContext';

const nav = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, phase1: true },
  { to: '/inbox', label: 'Inbox', icon: Inbox, phase1: true },
  { to: '/tickets', label: 'Tickets', icon: Ticket, phase1: true },
  { to: '/customers', label: 'Customers', icon: Users, phase1: true },
  { to: '/knowledge', label: 'Knowledge Base', icon: BookOpen, phase1: false },
  { to: '/automations', label: 'Automations', icon: Workflow, phase1: false },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, phase1: false },
  { to: '/team', label: 'Team', icon: Users, phase1: true },
  { to: '/widget-demo', label: 'Chat Widget', icon: MessageSquare, phase1: true },
  { to: '/settings', label: 'Settings', icon: Settings, phase1: true },
];
export default function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { user, signOut } = useAuth();
  const { workspaces, workspaceId, setWorkspaceId, status: wsStatus } = useWorkspace();
  const navigate = useNavigate();
  return (
    <div className="flex min-h-screen bg-navy">
      <aside className={`${collapsed ? 'w-16' : 'w-64'} hidden shrink-0 flex-col bg-sidebar transition-all md:flex`}>
        <div className="flex items-center gap-2 px-4 py-5">
          <Zap className="h-6 w-6 shrink-0 text-primary" />
          {!collapsed && <span className="text-lg font-bold text-white">SupportFlow <span className="text-primary">AI</span></span>}
        </div>
        <nav className="flex-1 space-y-1 px-2" aria-label="Main">
          {nav.map(({ to, label, icon: Icon, phase1 }) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-primary/20 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
              <Icon className="h-5 w-5 shrink-0" />
              {!collapsed && <span className="flex-1">{label}</span>}
              {!collapsed && !phase1 && <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300">Soon</span>}
            </NavLink>
          ))}
        </nav>
        <button onClick={() => setCollapsed(!collapsed)} className="m-2 flex items-center justify-center rounded-lg p-2 text-slate-400 hover:bg-slate-800" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <ChevronRight className="h-5 w-5" /> : <ChevronLeft className="h-5 w-5" />}
        </button>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-slate-800 bg-sidebar px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden text-sm font-medium text-slate-300 sm:block">Workspace</span>
            {wsStatus === 'auth-loading' || wsStatus === 'loading' ? (
              <Skeleton className="h-9 w-40" />
            ) : workspaces.length > 0 ? (
              <select
                value={workspaceId ?? ''}
                onChange={(e) => setWorkspaceId(e.target.value)}
                aria-label="Select workspace"
                className="max-w-48 truncate rounded-lg border border-slate-600 bg-navy px-2 py-1.5 text-sm text-white focus:border-primary focus:outline-none sm:max-w-64"
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            ) : (
              <button onClick={() => navigate('/onboarding')} className="rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:bg-purple-600">
                Create workspace
              </button>
            )}
          </div>
          <div className="relative">
            <button onClick={() => setMenuOpen(!menuOpen)} className="flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-sm text-white hover:bg-slate-700" aria-haspopup="menu" aria-expanded={menuOpen}>
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-bold">{(user?.email ?? '?')[0].toUpperCase()}</span>
              <span className="hidden max-w-40 truncate sm:block">{user?.email}</span>
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-2 w-56 rounded-xl border border-slate-700 bg-card p-2 shadow-lg" role="menu">
                <p className="truncate px-3 py-2 text-xs text-slate-400">{user?.email}</p>
                <button onClick={() => { setMenuOpen(false); navigate('/settings'); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-slate-700"><Settings className="h-4 w-4" /> Settings</button>
                <button onClick={async () => { await signOut(); navigate('/login'); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-400 hover:bg-slate-700"><LogOut className="h-4 w-4" /> Log out</button>
              </div>
            )}
          </div>
        </header>
        <main className="flex-1 p-4 md:p-6"><Outlet /></main>
        <nav className="flex overflow-x-auto border-t border-slate-800 bg-sidebar px-2 py-2 md:hidden" aria-label="Mobile">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `flex shrink-0 flex-col items-center px-3 py-1 text-[11px] ${isActive ? 'text-white' : 'text-slate-400'}`}><Icon className="h-5 w-5" />{label}</NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
