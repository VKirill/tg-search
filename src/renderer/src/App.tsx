import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Account, Lead, Project, Source } from '../../shared/types';
import { AccountsDialog } from './components/AccountsDialog';
import { AutopilotDialog } from './components/AutopilotDialog';
import { ChatPanel } from './components/ChatPanel';
import { LeadsPanel, type LeadFilters } from './components/LeadsPanel';
import { ProjectDialog } from './components/ProjectDialog';
import { ProjectsPanel } from './components/ProjectsPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { SourcesDialog } from './components/SourcesDialog';
import { TopBar } from './components/TopBar';
import { ToastProvider, installGlobalErrors, useToast } from './components/Toast';
import { getApi } from './hooks/useApi';

export type DialogKind =
  | 'project-new'
  | 'project-edit'
  | 'sources'
  | 'autopilot'
  | 'accounts'
  | 'settings'
  | null;

function AppInner() {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [allSources, setAllSources] = useState<Source[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [leadId, setLeadId] = useState<number | null>(null);
  const [projectSearch, setProjectSearch] = useState('');
  const [leadSearch, setLeadSearch] = useState('');
  const [leadFilters, setLeadFilters] = useState<LeadFilters>({
    likedOnly: false,
    repliedOnly: false,
    showHidden: false,
    sort: 'newest',
  });
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());
  const [jobLabel, setJobLabel] = useState<string | null>(null);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const selectedLead = leads.find((l) => l.id === leadId) ?? null;
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

  const refreshLeads = useCallback(async (pid: number, search?: string) => {
    setLeads(await getApi().leads.list(pid, search ? { search } : undefined));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [list] = await Promise.all([refreshProjects(), refreshAccounts()]);
        const pid = list[0]?.id ?? null;
        if (pid != null) {
          setProjectId(pid);
          await Promise.all([refreshLeads(pid), refreshAllSources(list)]);
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [refreshProjects, refreshAccounts, refreshLeads, refreshAllSources, toast]);

  useEffect(() => {
    if (projectId == null) return;
    refreshLeads(projectId, leadSearch).catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }, [projectId, leadSearch, refreshLeads, toast]);

  useEffect(() => {
    const off = getApi().onEvent((e) => {
      if (e.type === 'lead:new' && e.lead.projectId === projectId) {
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
      if (e.type === 'lead:update' && e.lead.projectId === projectId) {
        setLeads((prev) => prev.map((l) => (l.id === e.lead.id ? e.lead : l)));
      }
      if (e.type === 'project:update') {
        setProjects((prev) => prev.map((p) => (p.id === e.project.id ? e.project : p)));
      }
      if (e.type === 'account:update') {
        setAccounts((prev) => prev.map((a) => (a.id === e.account.id ? e.account : a)));
      }
      if (e.type === 'job' && e.projectId === projectId) {
        setJobLabel(e.done ? null : e.stage);
        if (e.error) toast(e.error);
      }
    });
    return off;
  }, [projectId, toast]);

  useEffect(() => {
    const hash = location.hash.replace(/^#/, '');
    if (!hash.startsWith('shot=')) return;
    const leadMatch = hash.match(/(?:^|&)lead=(\d+)/);
    if (leadMatch) setLeadId(Number(leadMatch[1]));

    const shot = hash.replace(/&?lead=\d+/, '').replace(/^&/, '').slice(5);
    if (shot === 'main' || shot === '') {
      setDialog(null);
      return;
    }
    if (shot === 'project-new' || shot === 'accounts' || shot === 'settings') {
      setDialog(shot as DialogKind);
      return;
    }
    if (projectId != null) setDialog(shot as DialogKind);
  }, [projectId]);

  const hiddenCount = useMemo(() => leads.filter((l) => l.status === 'hidden').length, [leads]);
  const projectSources = allSources.filter((s) => s.projectId === projectId);
  const sourcesForLeads = allSources.filter((s) => s.projectId === projectId);

  const visibleLeads = useMemo(() => {
    let list = [...leads];
    if (leadFilters.likedOnly) list = list.filter((l) => l.feedback === 'up');
    if (leadFilters.repliedOnly) list = list.filter((l) => l.status === 'replied' || l.status === 'dialog');
    if (!leadFilters.showHidden) list = list.filter((l) => l.status !== 'hidden');
    if (leadFilters.sort === 'score') list.sort((a, b) => b.score - a.score);
    else list.sort((a, b) => b.date - a.date);
    return list;
  }, [leads, leadFilters]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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
  }, [dialog, visibleLeads, leadId]);

  useEffect(() => {
    if (!leadId && visibleLeads[0]) setLeadId(visibleLeads[0].id);
  }, [visibleLeads, leadId]);

  const onFeedback = async (id: number, value: 'up' | 'down' | null) => {
    try {
      const l = await getApi().leads.feedback(id, value);
      setLeads((prev) => prev.map((x) => (x.id === l.id ? l : x)));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const ready = projects.length > 0 && projectId != null;

  return (
    <div className="app-shell" data-ui-ready={ready ? '1' : '0'}>
      <TopBar
        project={project}
        accounts={accounts}
        sourceCount={projectSources.length}
        onSources={() => project && setDialog('sources')}
        onAutopilot={() => project && setDialog('autopilot')}
        onSettings={() => setDialog('settings')}
      />
      <div className="columns">
        <ProjectsPanel
          projects={projects}
          accounts={accounts}
          sources={allSources}
          selectedId={projectId}
          search={projectSearch}
          onSearch={setProjectSearch}
          onSelect={(id) => {
            setProjectId(id);
            setLeadId(null);
          }}
          onNewProject={() => setDialog('project-new')}
          onAccounts={() => setDialog('accounts')}
        />
        <LeadsPanel
          leads={leads}
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
        <ChatPanel lead={selectedLead} source={selectedSource} />
      </div>

      {dialog === 'project-new' && (
        <ProjectDialog
          project={null}
          accounts={accounts}
          onClose={() => setDialog(null)}
          onSaved={() => refreshProjects()}
        />
      )}
      {dialog === 'project-edit' && project && (
        <ProjectDialog
          project={project}
          accounts={accounts}
          onClose={() => setDialog(null)}
          onSaved={() => refreshProjects()}
        />
      )}
      {dialog === 'sources' && project && (
        <SourcesDialog
          project={project}
          onClose={() => setDialog(null)}
          onChange={() => refreshAllSources(projects).catch(() => {})}
        />
      )}
      {dialog === 'autopilot' && project && (
        <AutopilotDialog
          project={project}
          accounts={accounts}
          onClose={() => setDialog(null)}
          onChange={(p) => setProjects((prev) => prev.map((x) => (x.id === p.id ? p : x)))}
        />
      )}
      {dialog === 'accounts' && (
        <AccountsDialog onClose={() => setDialog(null)} onChange={() => refreshAccounts()} />
      )}
      {dialog === 'settings' && <SettingsDialog onClose={() => setDialog(null)} />}
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
