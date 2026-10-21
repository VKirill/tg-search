import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, Category, Lead, Project, Source } from '../../shared/types';
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
import { AgentsView } from './components/AgentsView';
import { SkillsView } from './components/SkillsView';
import { ApprovalsView } from './components/ApprovalsView';
import { SpamTemplatesView } from './components/SpamTemplatesView';
import { NewsView } from './components/NewsView';
import { GroupsView } from './components/GroupsView';
import { ToastProvider, installGlobalErrors, useToast } from './components/Toast';
import { getApi } from './hooks/useApi';
import { getShotBootstrap } from './mockApi';
import type { ChatOpenTarget } from './components/ChatsView';

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
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const [allSources, setAllSources] = useState<Source[]>([]);
  const [leads, setLeads] = useState<Lead[]>(shotSeed?.leads ?? []);
  const [projectFilterId, setProjectFilterId] = useState<number | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<number | 'none' | null>(null);
  const [leadId, setLeadId] = useState<number | null>(hashLeadId());
  const [leadSearch, setLeadSearch] = useState('');
  const [leadFilters, setLeadFilters] = useState<LeadFilters>({ chip: null, sort: 'newest' });
  const [view, setView] = useState<NavView>(hashNavView());
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [crmCollapsed, setCrmCollapsed] = useState(false);
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());
  const [jobLabel, setJobLabel] = useState<string | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [chatTarget, setChatTarget] = useState<ChatOpenTarget | null>(null);

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

  // Categories are edited in Statistics; reload when coming back to the lists
  useEffect(() => {
    if (!['inbox', 'leads'].includes(view)) return;
    getApi().categories.list().then(setCategories, () => {});
  }, [view]);

  useEffect(() => {
    if (projects.length === 0) return;
    refreshLeads(projects, leadSearch).catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }, [leadSearch, projects, refreshLeads, toast]);

  useEffect(() => {
    const off = getApi().onEvent((e) => {
      if (e.type === 'link:open') {
        void openTelegramLink(e.url);
        return;
      }
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
      if (e.type === 'approval:update') {
        if (e.approval.status === 'pending') {
          setPendingApprovals((n) => n + 1);
          toast(`Новое согласование: ${e.approval.summary}`);
        } else {
          getApi()
            .approvals.list('pending')
            .then((list) => setPendingApprovals(list.length))
            .catch(() => {});
        }
      }
    });
    return off;
  }, [toast]);

  useEffect(() => {
    getApi()
      .approvals.list('pending')
      .then((list) => setPendingApprovals(list.length))
      .catch(() => {});
  }, []);

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
      agents: 'agents',
      'agents-editor': 'agents',
      'agent-rules': 'agents',
      skills: 'skills',
      'skills-draft': 'skills',
      approvals: 'approvals',
      spam: 'spam',
      news: 'news',
      publication: 'chats',
      'lead-repeat': 'leads',
    };
    if (map[shot]) setView(map[shot]);
    if (shot === 'lead-repeat') {
      setLeadId(2);
      setView('leads');
    }
    if (shot === 'publication') {
      setChatTarget({ accountId: 1, chatId: 101, messageId: 8801 });
    }
  }, []);

  const scopedLeads = useMemo(() => {
    let list = [...leads];
    if (projectFilterId != null) list = list.filter((l) => l.projectId === projectFilterId);
    if (view === 'inbox') {
      list = list.filter((l) => l.handoff || l.status === 'dialog' || (l.status === 'new' && l.score >= 80));
    }
    return list;
  }, [leads, projectFilterId, view]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<number | 'none', number>();
    for (const l of scopedLeads) {
      if (l.status === 'hidden') continue;
      const k = l.categoryId ?? 'none';
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }, [scopedLeads]);

  const filteredLeads = useMemo(() => {
    if (categoryFilter == null) return scopedLeads;
    return scopedLeads.filter((l) => (l.categoryId ?? 'none') === categoryFilter);
  }, [scopedLeads, categoryFilter]);

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

  // Any Telegram link (news, statistics, links in messages) opens in «Чаты» at its message
  const openTelegramLink = async (url: string) => {
    const accountId = accountsRef.current.find((a) => a.status === 'authorized')?.id;
    if (accountId == null) {
      toast('Нет авторизованного аккаунта для просмотра чата');
      return;
    }
    toast('Открываю ссылку в «Чатах»…');
    try {
      const { chat, messageId } = await getApi().chats.resolveLink(accountId, url);
      setChatTarget({ accountId, chatId: chat.chatId, messageId, chat });
      setView('chats');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const openPublication = (lead: Lead) => {
    const accountId =
      lead.accountId ?? accounts.find((a) => a.status === 'authorized')?.id ?? null;
    if (accountId == null) {
      toast('Нет авторизованного аккаунта для просмотра чата');
      return;
    }
    setChatTarget({ accountId, chatId: lead.tgChatId, messageId: lead.tgMessageId });
    setView('chats');
  };

  const markSpamLead = async (lead: Lead) => {
    try {
      const l = await getApi().spam.markSpam(lead.id);
      setLeads((prev) => prev.map((x) => (x.id === l.id ? l : x)));
      if (leadId === l.id) setLeadId(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const showMailColumns = view === 'inbox' || view === 'leads';
  const listTitle = view === 'inbox' ? 'Входящие' : 'Лиды';

  return (
    <div className="app-shell" data-ui-ready={leads.length > 0 ? '1' : '0'}>
      <NavRail
        view={view === 'accounts' ? 'accounts' : view}
        collapsed={navCollapsed}
        accounts={accounts}
        pendingApprovals={pendingApprovals}
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
                  value={categoryFilter == null ? '' : `c:${categoryFilter}`}
                  onChange={(e) => {
                    const v = e.target.value.slice(2);
                    setCategoryFilter(!v ? null : v === 'none' ? 'none' : Number(v));
                  }}
                  aria-label="Тематика"
                >
                  <option value="">Все тематики · {[...categoryCounts.values()].reduce((a, b) => a + b, 0)}</option>
                  {categories.filter((c) => c.enabled || categoryCounts.has(c.id)).map((c) => (
                    <option key={c.id} value={`c:${c.id}`}>{c.name} · {categoryCounts.get(c.id) ?? 0}</option>
                  ))}
                  {categoryCounts.has('none') && <option value="c:none">Без тематики · {categoryCounts.get('none')}</option>}
                </select>
                {projects.length > 1 && (
                  <select
                    className="project-switcher"
                    value={projectFilterId ?? ''}
                    onChange={(e) => setProjectFilterId(e.target.value ? Number(e.target.value) : null)}
                    aria-label="Поиск"
                  >
                    <option value="">Все поиски</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                )}
              </div>
              <LeadsPanel
                title={listTitle}
                leads={visibleLeads}
                sources={sourcesForLeads}
                categories={categories}
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
                onMarkSpam={markSpamLead}
              />
            </aside>
            <ChatPanel
              lead={selectedLead}
              source={selectedSource}
              project={leadProject}
              onLeadChange={(l) => setLeads((prev) => prev.map((x) => (x.id === l.id ? l : x)))}
              onOpenPublication={openPublication}
              onMarkSpam={(l) => setLeads((prev) => prev.map((x) => (x.id === l.id ? l : x)))}
            />
            <CrmPanel lead={selectedLead} collapsed={crmCollapsed} onToggleCollapse={() => setCrmCollapsed((c) => !c)} />
          </>
        )}
        {view === 'chats' && (
          <ChatsView
            accounts={accounts}
            projects={projects}
            initialTarget={chatTarget}
            onConsumeTarget={() => setChatTarget(null)}
          />
        )}
        {view === 'agents' && <AgentsView />}
        {view === 'skills' && <SkillsView />}
        {view === 'approvals' && (
          <ApprovalsView leads={leads} onPendingCount={setPendingApprovals} />
        )}
        {view === 'spam' && <SpamTemplatesView />}
        {view === 'news' && <NewsView />}
        {view === 'groups' && <GroupsView />}
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
