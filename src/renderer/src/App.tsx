import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Account, Lead, Project, Source } from '../../shared/types';
import { AccountsDialog } from './components/AccountsDialog';
import { BroadcastsView } from './components/BroadcastsView';
import { ChatPanel } from './components/ChatPanel';
import { ChatsView } from './components/ChatsView';
import { StatsView } from './components/StatsView';
import { CrmPanel } from './components/CrmPanel';
import { FunnelView } from './components/FunnelView';
import { LeadsPanel, type LeadFilters } from './components/LeadsPanel';
import { NavRail, type NavView } from './components/NavRail';
import { ProjectsView } from './components/ProjectsView';
import { ServicesView } from './components/ServicesView';
import { SubscriptionsView } from './components/SubscriptionsView';
import { SettingsView } from './components/SettingsView';
import { ToastProvider, installGlobalErrors, useToast } from './components/Toast';
import { getApi } from './hooks/useApi';
import { getShotBootstrap } from './mockApi';

const shotSeed =
  typeof location !== 'undefined' && location.hash.includes('shot=') ? getShotBootstrap() : null;

function hashLeadId(): number | null {
  if (typeof location === 'undefined') return null;
  const m = location.hash.match(/lead=(\d+)/);
  return m ? Number(m[1]) : null;
}

function hashNavView(): NavView {
  if (typeof location === 'undefined') return 'inbox';
  const hash = location.hash.replace(/^#/, '');
  if (!hash.includes('shot=')) return 'inbox';
  if (hash.includes('funnel')) return 'funnel';
  if (hash.includes('projects')) return 'projects';
  if (hash.includes('broadcasts')) return 'broadcasts';
  if (hash.includes('settings')) return 'settings';
  if (hash.includes('service-editor') || hash.includes('shot=services') || hash.includes('&services')) return 'services';
  if (hash.includes('subscriptions')) return 'subscriptions';
  if (hash.includes('accounts')) return 'accounts';
  return 'inbox';
}

function AppInner() {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>(shotSeed?.projects ?? []);
  const [accounts, setAccounts] = useState<Account[]>(shotSeed?.accounts ?? []);
  const [allSources, setAllSources] = useState<Source[]>([]);
  const [leads, setLeads] = useState<Lead[]>(shotSeed?.leads ?? []);
  const [projectFilterId, setProjectFilterId] = useState<number | null>(null);
  const [leadId, setLeadId] = useState<number | null>(hashLeadId());
  const [leadSearch, setLeadSearch] = useState('');
  const [leadFilters, setLeadFilters] = useState<LeadFilters>({ chip: null, sort: 'newest' });
  const [view, setView] = useState<NavView>(hashNavView());
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [crmCollapsed, setCrmCollapsed] = useState(false);
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());
  const [jobLabel, setJobLabel] = useState<string | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);

  const selectedLead = leads.find((l) => l.id === leadId) ?? null;
  const leadProject = selectedLead ? projects.find((p) => p.id === selectedLead.projectId) ?? null : null;
  const selectedSource = selectedLead?.sourceId
    ? allSources.find((s) => s.id === selectedLead.sourceId) ?? null
    : null;

  const refreshProjects = useCallback(async () => {
    const list = await getApi().projects.list();
    setProjects(list);
    return list;
  }, []);

  const refreshAccounts = useCallback(async () => {
    setAccounts(await getApi().accounts.list());
  }, []);

  const refreshAllSources = useCallback(async (list: Project[]) => {
    const chunks = await Promise.all(list.map((p) => getApi().sources.list(p.id)));
    setAllSources(chunks.flat());
  }, []);

  const refreshLeads = useCallback(async (list: Project[], search?: string) => {
    const chunks = await Promise.all(
      list.map((p) => getApi().leads.list(p.id, search ? { search } : undefined)),
    );
    setLeads(chunks.flat().sort((a, b) => b.date - a.date));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const list = await refreshProjects();
        await Promise.all([refreshAccounts(), refreshLeads(list), refreshAllSources(list)]);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [refreshProjects, refreshAccounts, refreshLeads, refreshAllSources, toast]);

  useEffect(() => {
    if (projects.length === 0) return;
    refreshLeads(projects, leadSearch).catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }, [leadSearch, projects, refreshLeads, toast]);

  useEffect(() => {
    const off = getApi().onEvent((e) => {
      if (e.type === 'lead:new') {
        setLeads((prev) => [e.lead, ...prev.filter((l) => l.id !== e.lead.id)]);
        setFreshIds((prev) => new Set(prev).add(e.lead.id));
        setTimeout(() => {
          setFreshIds((prev) => {
            const n = new Set(prev);
            n.delete(e.lead.id);
            return n;
          });
        }, 2500);
      }
      if (e.type === 'lead:update') {
        setLeads((prev) => prev.map((l) => (l.id === e.lead.id ? e.lead : l)));
      }
      if (e.type === 'project:update') {
        setProjects((prev) => prev.map((p) => (p.id === e.project.id ? e.project : p)));
      }
      if (e.type === 'account:update') {
        setAccounts((prev) => prev.map((a) => (a.id === e.account.id ? e.account : a)));
      }
      if (e.type === 'job') {
        setJobLabel(e.done ? null : e.stage);
        if (e.error) toast(e.error);
      }
    });
    return off;
  }, [toast]);

  useEffect(() => {
    const hash = location.hash.replace(/^#/, '');
    if (!hash.startsWith('shot=')) return;
    const leadMatch = hash.match(/(?:^|&)lead=(\d+)/);
    if (leadMatch) setLeadId(Number(leadMatch[1]));
    if (hash.includes('orders')) setCrmCollapsed(false);
    const shot = hash.match(/shot=([^&]+)/)?.[1] ?? '';
    const map: Record<string, NavView> = {
      main: 'inbox',
      inbox: 'inbox',
      funnel: 'funnel',
      projects: 'projects',
      'project-editor': 'projects',
      sources: 'projects',
      broadcasts: 'broadcasts',
      settings: 'settings',
      services: 'services',
      'service-editor': 'services',
      orders: 'inbox',
      accounts: 'accounts',
      dialog: 'inbox',
      subscriptions: 'subscriptions',
      'client-memory': 'inbox',
      'client-files': 'inbox',
      'client-money': 'inbox',
      'agent-trace': 'inbox',
    };
    if (map[shot]) setView(map[shot]);
  }, []);

  const filteredLeads = useMemo(() => {
    let list = [...leads];
    if (projectFilterId != null) list = list.filter((l) => l.projectId === projectFilterId);
    if (view === 'inbox') {
      list = list.filter((l) => l.handoff || l.status === 'dialog' || (l.status === 'new' && l.score >= 80));
    }
    return list;
  }, [leads, projectFilterId, view]);

  const visibleLeads = useMemo(() => {
    let list = [...filteredLeads];
    if (leadFilters.chip === 'new') list = list.filter((l) => l.status === 'new');
    if (leadFilters.chip === 'handoff') list = list.filter((l) => l.handoff);
    if (leadFilters.chip === 'dialog') list = list.filter((l) => l.status === 'dialog');
    if (leadFilters.chip === 'replied') list = list.filter((l) => l.status === 'replied');
    if (leadFilters.chip === 'hidden') list = list.filter((l) => l.status === 'hidden');
    else list = list.filter((l) => l.status !== 'hidden');
    if (leadFilters.sort === 'score') list.sort((a, b) => b.score - a.score);
    else list.sort((a, b) => b.date - a.date);
    return list;
  }, [filteredLeads, leadFilters]);

  const hiddenCount = useMemo(() => filteredLeads.filter((l) => l.status === 'hidden').length, [filteredLeads]);
  const sourcesForLeads = allSources;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!['inbox', 'leads'].includes(view)) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const i = visibleLeads.findIndex((l) => l.id === leadId);
        const next = visibleLeads[Math.min(i + 1, visibleLeads.length - 1)];
        if (next) setLeadId(next.id);
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const i = visibleLeads.findIndex((l) => l.id === leadId);
        const next = visibleLeads[Math.max(i - 1, 0)];
        if (next) setLeadId(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, visibleLeads, leadId]);

  useEffect(() => {
    if (['inbox', 'leads'].includes(view) && !leadId && visibleLeads[0]) setLeadId(visibleLeads[0].id);
  }, [visibleLeads, leadId, view]);

  const onFeedback = async (id: number, value: 'up' | 'down' | null) => {
    try {
      const l = await getApi().leads.feedback(id, value);
      setLeads((prev) => prev.map((x) => (x.id === l.id ? l : x)));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const openLeadFromFunnel = (id: number) => {
    setLeadId(id);
    setView('leads');
  };

  const onNav = (v: NavView) => {
    setView(v);
    if (v === 'accounts') setAccountsOpen(true);
  };

  const showMailColumns = view === 'inbox' || view === 'leads';
  const listTitle = view === 'inbox' ? 'Входящие' : 'Лиды';

  return (
    <div className="app-shell" data-ui-ready={leads.length > 0 ? '1' : '0'}>
      <NavRail
        view={view === 'accounts' ? 'accounts' : view}
        collapsed={navCollapsed}
        accounts={accounts}
        onView={onNav}
        onToggleCollapse={() => setNavCollapsed((c) => !c)}
      />
      <div className="app-main">
        {showMailColumns && (
          <>
            <aside className="list-column">
              <div className="list-column__head no-drag">
                <select
                  className="project-switcher"
                  value={projectFilterId ?? ''}
                  onChange={(e) => setProjectFilterId(e.target.value ? Number(e.target.value) : null)}
                  aria-label="Тематика"
                >
                  <option value="">Все тематики</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <LeadsPanel
                title={listTitle}
                leads={visibleLeads}
                sources={sourcesForLeads}
                selectedLeadId={leadId}
                freshIds={freshIds}
                search={leadSearch}
                filters={leadFilters}
                hiddenCount={hiddenCount}
                jobLabel={jobLabel}
                onSearch={setLeadSearch}
                onFilters={setLeadFilters}
                onSelect={setLeadId}
                onFeedback={onFeedback}
              />
            </aside>
            <ChatPanel
              lead={selectedLead}
              source={selectedSource}
              project={leadProject}
              onLeadChange={(l) => setLeads((prev) => prev.map((x) => (x.id === l.id ? l : x)))}
            />
            <CrmPanel lead={selectedLead} collapsed={crmCollapsed} onToggleCollapse={() => setCrmCollapsed((c) => !c)} />
          </>
        )}
        {view === 'chats' && <ChatsView accounts={accounts} projects={projects} />}
        {view === 'funnel' && <FunnelView projectId={projectFilterId} onOpenLead={openLeadFromFunnel} />}
        {view === 'projects' && (
          <ProjectsView
            projectList={projects}
            accounts={accounts}
            onRefresh={() => refreshProjects()}
            onOpenServices={() => setView('services')}
          />
        )}
        {view === 'stats' && <StatsView />}
        {view === 'broadcasts' && <BroadcastsView accounts={accounts} />}
        {view === 'services' && <ServicesView />}
        {view === 'subscriptions' && <SubscriptionsView />}
        {view === 'settings' && <SettingsView />}
      </div>
      {accountsOpen && (
        <AccountsDialog onClose={() => { setAccountsOpen(false); setView('inbox'); }} onChange={() => refreshAccounts()} />
      )}
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AppWithErrors />
    </ToastProvider>
  );
}

function AppWithErrors() {
  const toast = useToast();
  useEffect(() => {
    installGlobalErrors(toast);
  }, [toast]);
  return <AppInner />;
}
