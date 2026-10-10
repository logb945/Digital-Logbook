import { useState, useMemo, useEffect, useCallback, useRef, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { ProfileMenu } from '@/components/ProfileMenu';
import { NotificationsBell } from '@/components/NotificationsBell';
import { SettingsPanel } from '@/components/SettingsPanel';
import { Stats } from '@/components/Stats';
import { ProjectSettingsPanel } from '@/components/ProjectSettingsPanel';
import { QuickEntryBar } from '@/components/QuickEntryBar';
import { ProjectFilterBlock } from '@/components/SearchFilters';
import {
  applyProjectFilters,
  defaultProjectFilters,
  matchesTextQuery,
  pinFirst,
  projectMatchesSearch,
  type ProjectFilters,
} from '@/lib/entryFilters';
import { ActivityFeed } from '@/components/ActivityFeed';
import { ActivitySummary } from '@/components/ActivitySummary';
import { addProject } from '@/functions/project/project.js';
import { addField, getFields } from '@/functions/project/fields.js';
import { getArchives } from '@/functions/project/archives.js';
import { setPriority } from '@/functions/project/priority.js';
import { checkUser } from '@/functions/profile/login.js';
import { cacheGet, cacheSubscribe, CACHE_STORES } from '@/lib/cache';
import { syncAllData } from '@/CacheFunctions';
import { buildProjectColorMap, resolveProjectColor, colorForName } from '@/lib/projectColorMap';
import { normalizeField } from '@/lib/fieldSchema';
import { EntryBox } from '@/pages/NewEntry';
import { DueSoonRail } from '@/components/DueSoonRail';
import { AddEntry } from '@/pages/AddEntry';
import VoiceFeature from '@/pages/VoiceFeature';
import { askAI } from '@/functions/ai.js';
import { getToneInstruction } from '@/functions/tone';
import { useAiMessagesEnabled } from '@/functions/aiMessages';
import { entryDurationMs, formatTimer } from '@/functions/dashboard/stats.js';
import { isDueSoon } from '@/functions/dashboard/overdue.js';
import {
  getEffectiveArchivedProjectNames,
  getLocallyArchivedProjectNames,
} from '@/functions/project/archiveState.js';
import { useNow } from '@/hooks/useNow';
import { useTimerActions } from '@/hooks/useTimerActions';
import { useSSEEntries } from '@/hooks/useSSEEntries';
import { TemplatePicker } from '@/components/fields/TemplatePicker';
import type { Template } from '@/lib/templateApi';
import { FiArchive, FiEdit2, FiRotateCcw, FiX } from 'react-icons/fi';
import { isOverdue } from '@/functions/dashboard/overdue.js';
import {
  type CalendarEntry,
  buildMonthGrid,
  formatMonthYear,
  formatShortDay,
  formatDayNumber,
  getEntriesForDay,
  getEntryTitle,
  isSameDay,
  addDays,
  addMonths,
} from '@/lib/calendar';
import '@/pages/Calendar.css';
import { AbandonedTimerBanner } from '@/components/AbandonedTimerBanner';
import { startAppTour, shouldOfferTour, markTourOffered } from '@/lib/tour';

// ── Timer Banner Component ────────────────────────────────────────────────────
// Small component for the Home page timer banner with pause/resume controls.
// Uses the shared useTimerActions hook for consistent state management.
interface TimerBannerProps {
  entry: any;
  projectName: string;
  elapsed: string;
  extraCount: number;
  onUpdated: (entry: any) => void;
}

function TimerBanner({ entry, projectName, elapsed, extraCount, onUpdated }: TimerBannerProps) {
  const { timerAction, isActionInFlight, pause, resume } = useTimerActions({ entry, onUpdated });
  const isPaused = Boolean(entry.started_at && !entry.ended_at && entry.paused_at);

  return (
    <div className="dash-timer-banner animate-in" role="status" aria-live="polite">
      <span className="dash-timer-dot" />
      <span className="dash-timer-label">
        {timerAction === 'pending-sync'
          ? 'Pending sync'
          : isPaused
            ? 'Timer paused'
            : 'Timer running'}
      </span>
      <span className="dash-timer-project">{projectName}</span>
      <span className="dash-timer-elapsed">{elapsed}</span>
      {extraCount > 0 && <span className="dash-timer-extra">+{extraCount} more</span>}
      <button
        type="button"
        className="dash-timer-control"
        onClick={isPaused ? resume : pause}
        disabled={isActionInFlight}
        aria-label={isPaused ? 'Resume timer' : 'Pause timer'}
        title={isPaused ? 'Resume' : 'Pause'}
      >
        {timerAction === 'pausing' ? '…' : timerAction === 'resuming' ? '…' : isPaused ? '▶' : '❚❚'}
      </button>
    </div>
  );
}

/** Parse AI response ΓÇö handles JSON {"message":"..."}, {"instruction":"..."}, etc. or plain text */
function parseAIResponse(response: string): string {
  try {
    const parsed = JSON.parse(response);
    if (typeof parsed === 'string') return parsed;
    if (Array.isArray(parsed)) {
      if (parsed.length > 0) {
        const first = parsed[0];
        if (typeof first === 'string') return first;
        if (typeof first === 'object' && first !== null) {
          const inner = parseAIResponse(JSON.stringify(first));
          if (inner) return inner;
        }
      }
      return '';
    }
    if (typeof parsed === 'object' && parsed !== null) {
      for (const key of [
        'placeholder',
        'message',
        'instruction',
        'response',
        'text',
        'content',
        'reply',
      ]) {
        if (typeof parsed[key] === 'string' && parsed[key].trim()) return parsed[key];
      }
      for (const val of Object.values(parsed)) {
        if (typeof val === 'string' && val.trim()) return val;
        if (typeof val === 'object' && val !== null) {
          const nested = parseAIResponse(JSON.stringify(val));
          if (nested) return nested;
        }
      }
    }
    return '';
  } catch {
    return typeof response === 'string' ? response : String(response);
  }
}

type Entry = Record<string, unknown>;
type Project = Record<string, unknown>;

type ProjectFieldDraft = {
  field_name: string;
  data_type:
    | 'text'
    | 'markdown'
    | 'integer'
    | 'float'
    | 'number'
    | 'date'
    | 'timestamp'
    | 'boolean'
    | 'geolocation'
    | 'currency'
    | 'file'
    | 'image'
    | 'entity_link'
    | 'tags'
    | 'checklist'
    | 'computed'
    | 'custom';
  is_required: boolean;
  custom_options?: string[];
};

type DashboardProps = {
  defaultView?: string;
};

export function Dashboard({ defaultView = 'all' }: DashboardProps) {
  const { user, signOut, deleteAccount, resetPassword } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'profile' | 'preferences' | 'account'>('profile');
  // One-time guided-tour offer for new users (see lib/tour.ts)
  const [showTourOffer, setShowTourOffer] = useState<boolean>(() => shouldOfferTour());

  useEffect(() => {
    if (showTourOffer) markTourOffered();
  }, [showTourOffer]);
  const navigate = useNavigate();

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The guided tour (lib/tour.ts) asks the shell to open/close the drawer so
  // its steps can anchor to drawer items. Dashboard renders its own inline
  // nav (not the shared NavBar), so it needs its own listeners.
  useEffect(() => {
    const open = () => setDrawerOpen(true);
    const close = () => setDrawerOpen(false);
    window.addEventListener('dl-tour-open-drawer', open);
    window.addEventListener('dl-tour-close-drawer', close);
    return () => {
      window.removeEventListener('dl-tour-open-drawer', open);
      window.removeEventListener('dl-tour-close-drawer', close);
    };
  }, []);
  const [activeView, setActiveView] = useState<'all' | 'recent' | 'drafts' | 'archives' | string>(
    defaultView
  );

  // Regular (non-AI) search over the current feed
  const [pageSearch, setPageSearch] = useState('');
  // Feed filters — the home feed is mixed across projects, so the panel narrows
  // it by project-level criteria (project name, entry count, field count),
  // matching the entries page. Field counts are read from the fields cache.
  const [projectFilters, setProjectFilters] = useState<ProjectFilters>(() =>
    defaultProjectFilters()
  );
  const [fieldCounts, setFieldCounts] = useState<Record<string, number>>({});
  // Field data types and field names per project — the field-type filter and
  // the projects-tab search (project name or any of its field names).
  const [fieldTypes, setFieldTypes] = useState<Record<string, string[]>>({});
  const [fieldNames, setFieldNames] = useState<Record<string, string[]>>({});

  // Data state
  const [projects, setProjects] = useState<Project[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  // Names of effectively archived parent projects — server flag or the local
  // fallback (shared with StatsView so Due Soon surfaces agree). Their active
  // entries are never due soon.
  const archivedProjectNames = useMemo(
    () => getEffectiveArchivedProjectNames(user?.email || '', projects),
    [user, projects]
  );
  // Global due-soon count, derived live from the shared eligibility rule so
  // the Stats card, the AI greeting and the feed can never disagree with the
  // displayed entries — even between due-soon cache recomputes.
  const dueSoonCount = useMemo(
    () =>
      entries.filter((e) =>
        isDueSoon(
          e.due_date as string | null,
          e.status as string | null,
          e.archived as boolean,
          archivedProjectNames.has(e.project_name as string)
        )
      ).length,
    [entries, archivedProjectNames]
  );
  // Archive state
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([]);
  const [archivedEntries, setArchivedEntries] = useState<Entry[]>([]);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [localArchived, setLocalArchived] = useState<Set<string>>(new Set());
  // Pinned projects — localStorage-backed (like the local archived set) so pins
  // survive reloads; pinned projects sort to the front of the home cards.
  const [pinnedProjects, setPinnedProjects] = useState<Set<string>>(new Set());
  // Project card delete flow — inline confirm per card
  const [confirmDeleteProject, setConfirmDeleteProject] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState<string | null>(null);
  const [profileAvatar, setProfileAvatar] = useState<string | null>(null);
  const [profileUsername, setProfileUsername] = useState<string | null>(null);

  // Calendar state (used in dashboard mode)
  const [calDate, setCalDate] = useState(() => new Date());
  const calDays = useMemo(() => buildMonthGrid(calDate, 0), [calDate]);
  const calHeaderDays = useMemo(() => {
    const start = calDays[0];
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [calDays]);
  const calEntries = useMemo(() => {
    return entries.filter((e: any) => e.due_date && !e.archived) as unknown as CalendarEntry[];
  }, [entries]);
  const isCalDayOverdue = useCallback((date: Date) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date < today;
  }, []);

  // Voice recorder
  const [voiceOpen, setVoiceOpen] = useState(false);

  // AI-generated messages
  const [aiGreeting, setAiGreeting] = useState('');
  const [showGreetingToast, setShowGreetingToast] = useState(false);
  // Reactive AI-messages preference — toast disappears the instant the user
  // flips the Settings toggle, no reload required.
  const aiMessagesOn = useAiMessagesEnabled();

  // Derived early so the deleted-account safety check can use it.
  const email = user?.email || '';

  // Safety check: soft-deleted accounts should not access the dashboard.
  // They are redirected to the sign-in restore prompt.
  useEffect(() => {
    if (!email) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await checkUser(email);
        if (!cancelled && result.exists && result.deleted) {
          try {
            await signOut();
          } catch {
            /* best effort */
          }
          const scheduled = result.deletion_scheduled_at || new Date().toISOString();
          navigate(
            `/signin?restore_email=${encodeURIComponent(email)}&restore_scheduled_at=${encodeURIComponent(scheduled)}`,
            { replace: true }
          );
        }
      } catch (err) {
        console.error('Dashboard deleted-check failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email, navigate, signOut]);
  const [, setAiEmptyMessage] = useState('No items to show right now.');

  // New project modal
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const [projectFields, setProjectFields] = useState<ProjectFieldDraft[]>([]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  // New entry modal
  const [newEntryOpen, setNewEntryOpen] = useState(false);
  const [newEntryProject, setNewEntryProject] = useState('');

  // Project settings panel
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  // Project the settings panel edits — set by the Edit button on a project card
  const [settingsProjectName, setSettingsProjectName] = useState('');
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  // Sequence counter guarding loadData against concurrent invocations.
  // Multiple callers fire this function near-simultaneously (mount effect,
  // three cacheSubscribe listeners, SSE onEntry, visibilitychange). Without
  // a guard, a call that started earlier can finish LATER than a newer call
  // and clobber fresh state with a stale snapshot. Only the newest call
  // (highest seq) is allowed to commit state.
  const loadSeq = useRef(0);

  // Load data — local-first: read ONLY from IndexedDB
  // Initial sync on login populates IndexedDB. Mutations update it directly.
  // No server calls here — SSE handles real-time updates from backend.
  const loadData = useCallback(async () => {
    if (!email) return;
    const seq = ++loadSeq.current;
    console.log('[Dashboard] loadData START, email=', email, 'seq=', seq);
    try {
      console.log('[Dashboard] Reading cache...', { seq });
      const [cachedEntries, cachedProjects] = await Promise.all([
        cacheGet(CACHE_STORES.ALL_ENTRIES, email),
        cacheGet(CACHE_STORES.PROJECTS, email),
      ]);
      // A newer loadData call has started since our await — bail without
      // touching state so the fresher call wins cleanly.
      if (seq !== loadSeq.current) {
        console.log('[Dashboard] Stale loadData after cache read, skipping commit', {
          seq,
          latest: loadSeq.current,
        });
        return;
      }
      console.log(
        '[Dashboard] Cache read done. entries:',
        !!cachedEntries?.data,
        'projects:',
        !!(cachedProjects?.data || cachedProjects?.projects)
      );
      // Apply whatever is already cached — instant, zero-spinner render.
      const applyProjectsCache = (row: Record<string, unknown> | null) => {
        const rawProjects = row?.data || row?.projects || [];
        const allProjects = (Array.isArray(rawProjects) ? rawProjects : []) as Project[];
        // Guard: an empty read — a row caught mid-invalidation or a partial
        // refill — must never wipe a populated project list. A genuine cold
        // start has nothing cached yet, so `projects` is already empty here.
        if (allProjects.length === 0) return;
        const localArch = getLocallyArchivedProjectNames(email);
        setLocalArchived(localArch);
        const merged = allProjects.map((p) => ({
          ...p,
          archived: p.archived === true || localArch.has(p.project_name as string),
        }));
        setProjects(merged);
        setArchivedProjects(merged.filter((p) => p.archived));
      };
      const applyCacheRows = (
        eRow: Record<string, unknown> | null,
        pRow: Record<string, unknown> | null
      ) => {
        if (eRow?.data) {
          const next = (Array.isArray(eRow.data) ? eRow.data : []) as Entry[];
          // Don't commit an empty result over a non-empty previous state — a
          // concurrent read can catch the row mid-invalidation and return [].
          setEntries((prev) => (next.length === 0 && prev.length > 0 ? prev : next));
        }
        if (pRow?.data || pRow?.projects) applyProjectsCache(pRow);
      };

      applyCacheRows(cachedEntries, cachedProjects);

      // A *missing* row (cacheGet returned null — not an empty array) means the
      // store was never populated OR was just invalidated by a mutation/SSE
      // event. Quick-add (addNaturalLanguageEntry) does NOT write optimistically:
      // the backend creates the row and SSE deletes our cache expecting a refill.
      // So we must pull from the server whenever a row is absent, independent of
      // whether the other store is still cached — a naive "any cache?" check left
      // freshly created entries invisible until a manual refresh. This never runs
      // while optimistic rows exist, so it can't clobber an in-flight mutation.
      const rowsMissing = !cachedEntries || !cachedProjects;
      if (rowsMissing) {
        if (!navigator.onLine) {
          console.log('[Dashboard] Rows missing and offline — nothing to fetch');
          return;
        }
        console.log('[Dashboard] Cache rows missing — force syncAllData (bypass throttle)...');
        await syncAllData(email, { force: true });
        const [freshEntries, freshProjects] = await Promise.all([
          cacheGet(CACHE_STORES.ALL_ENTRIES, email),
          cacheGet(CACHE_STORES.PROJECTS, email),
        ]);
        // syncAllData + the re-read are long-running; a subscriber-triggered
        // reload may have overtaken us. Only the newest call commits.
        if (seq !== loadSeq.current) {
          console.log('[Dashboard] Stale loadData after syncAllData, skipping commit', {
            seq,
            latest: loadSeq.current,
          });
          return;
        }
        applyCacheRows(freshEntries, freshProjects);
      }
    } catch (err) {
      console.error('[Dashboard] loadData exception:', err);
    } finally {
      // Only the newest call is allowed to flip the loading flag off; a
      // stale call finishing late would otherwise clear a spinner that a
      // fresher call still needs.
      if (seq === loadSeq.current) {
        console.log('[Dashboard] loadData FINALLY — setting loading=false', { seq });
        setLoading(false);
      } else {
        console.log('[Dashboard] Stale loadData in finally, leaving loading flag alone', {
          seq,
          latest: loadSeq.current,
        });
      }
    }
  }, [email]);

  // Single stable callback reused for every cache subscription. cacheDeleteMany
  // de-duplicates by callback identity, so a batched SSE invalidation that drops
  // ALL_ENTRIES + PROJECTS in one event reloads the Dashboard exactly once here
  // instead of once per store (which is what used to fan out into racing
  // loadData() calls).
  const reload = useCallback(() => {
    void loadData();
  }, [loadData]);

  // SSE: When the backend finishes parsing a natural language entry it pushes
  // the data via SSE; useSSEEntries batch-invalidates the affected cache rows,
  // which reloads this page through the shared `reload` subscription above.
  useSSEEntries();

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Subscribe to IndexedDB cache changes — when syncAllData finishes writing
  // data on first login, this triggers a re-load so data appears without refresh.
  useEffect(() => {
    if (!email) return;
    const unsubs = [
      cacheSubscribe(CACHE_STORES.ALL_ENTRIES, email, reload),
      cacheSubscribe(CACHE_STORES.PROJECTS, email, reload),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, [email, reload]);

  // Re-read from IndexedDB when the tab/page becomes visible again.
  // This catches the case where the user creates a project on another page
  // (e.g. Projects page) and navigates back to the Dashboard.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadData();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [loadData]);

  // Load archived entries when archives view is active
  useEffect(() => {
    if (activeView !== 'archives' || !email) return;
    const loadArchives = async () => {
      try {
        const result = await getArchives(email, null);
        if (result?.success !== false) {
          setArchivedEntries(result?.data || []);
        }
      } catch (err) {
        console.error('Failed to load archived entries:', err);
      }
    };
    loadArchives();
    // Re-read when archives cache changes (e.g., after archive/unarchive actions)
    const unsub = cacheSubscribe(CACHE_STORES.ARCHIVES, `${email}:all`, () => loadArchives());
    return () => unsub();
  }, [activeView, email]);

  // AI-generated greeting ΓÇö shown as a toast (respects AI messages preference)
  useEffect(() => {
    if (!aiMessagesOn) {
      // Preference flipped off — tear down any toast already on screen.
      setShowGreetingToast(false);
      setAiGreeting('');
      return;
    }
    if (!loading && projects.length > 0) {
      const hour = new Date().getHours();
      const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      const entryCount = entries.length;
      const dueCount = dueSoonCount;
      let cancelled = false;

      (async () => {
        const tone = getToneInstruction();
        const result = await askAI(
          `Generate a ${timeOfDay} greeting for a user with ${entryCount} entries and ${dueCount} due soon. Make it 3-4 sentences long. If the tone is casual or cynical, roast the user playfully and be funny ΓÇö tease them about their productivity, their procrastination, or their life choices. Be witty and entertaining. ${tone}`
        );
        // Re-check on resolve: the user may have flipped the Settings toggle
        // while the AI request was in flight.
        if (!cancelled && result.success && result.response) {
          const msg = parseAIResponse(result.response);
          setAiGreeting(msg);
          setShowGreetingToast(true);
        }
      })();
      return () => {
        cancelled = true;
      };
    } else if (!loading) {
      setAiGreeting("Welcome! Let's get you started.");
      setShowGreetingToast(true);
    }
  }, [aiMessagesOn, loading, projects, entries, dueSoonCount]);

  // Auto-dismiss greeting toast after 30 seconds
  useEffect(() => {
    if (showGreetingToast) {
      const t = setTimeout(() => setShowGreetingToast(false), 30000);
      return () => clearTimeout(t);
    }
  }, [showGreetingToast]);

  // Simple, static placeholder for quick entry (no AI)
  const aiPlaceholder = 'Capture quick entry';

  // Close drawer on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawerOpen(false);
        setProjectMenuOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Close project menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Project colour map — computed once per projects change
  const dashColorMap = useMemo(
    () => buildProjectColorMap(projects as Array<Record<string, unknown>>),
    [projects]
  );

  // Field counts, field types and field names for the filters and the
  // projects-tab search. Field definitions live per project, so each project's
  // rows are read from the cache and only fetched when missing.
  useEffect(() => {
    if (!email) return;
    const names = Array.from(
      new Set([
        ...projects.map((p) => p.project_name as string),
        ...entries.map((e) => e.project_name as string),
      ])
    ).filter(Boolean);
    if (names.length === 0) return;
    let cancelled = false;
    (async () => {
      const nextCounts: Record<string, number> = {};
      const nextTypes: Record<string, string[]> = {};
      const nextNames: Record<string, string[]> = {};
      await Promise.all(
        names.map(async (name) => {
          try {
            let cached = await cacheGet(CACHE_STORES.FIELDS, `${email}:${name}`);
            if (!cached?.data) cached = await getFields(email, name);
            const rows = Array.isArray(cached?.data) ? cached.data : [];
            const fields = rows.filter((r: Record<string, unknown>) => r?.field_name);
            nextCounts[name] = fields.length;
            nextTypes[name] = Array.from(
              new Set(fields.map((r: Record<string, unknown>) => normalizeField(r).data_type))
            );
            nextNames[name] = fields.map((r: Record<string, unknown>) => String(r.field_name));
          } catch {
            nextCounts[name] = 0;
            nextTypes[name] = [];
            nextNames[name] = [];
          }
        })
      );
      if (!cancelled) {
        setFieldCounts(nextCounts);
        setFieldTypes(nextTypes);
        setFieldNames(nextNames);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email, projects, entries]);

  // Entry counts per project — powers the "entry count" filter
  const entryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of entries) {
      const name = (e.project_name as string) || '';
      if (name) counts[name] = (counts[name] || 0) + 1;
    }
    return counts;
  }, [entries]);

  // Projects offered in the filter panel — anything with entries or fields
  const projectNames = useMemo(
    () =>
      Array.from(new Set([...Object.keys(entryCounts), ...Object.keys(fieldCounts)])).sort(
        (a, b) => a.localeCompare(b)
      ),
    [entryCounts, fieldCounts]
  );

  // Load pinned project names for this user (localStorage — no backend column).
  useEffect(() => {
    if (!email) return;
    try {
      const stored = localStorage.getItem(`dl_pinned_projects_${email}`);
      setPinnedProjects(new Set(stored ? JSON.parse(stored) : []));
    } catch {
      setPinnedProjects(new Set());
    }
  }, [email]);

  // Active projects with pinned ones first — drives the home-page card grid.
  const activeProjects = useMemo(() => {
    const active = projects.filter((p) => !p.archived);
    const pinned = active.filter((p) => pinnedProjects.has(p.project_name as string));
    const rest = active.filter((p) => !pinnedProjects.has(p.project_name as string));
    return [...pinned, ...rest];
  }, [projects, pinnedProjects]);

  // Every field type used across the projects — the field-type filter options
  const fieldTypeOptions = useMemo(
    () =>
      Array.from(new Set(Object.values(fieldTypes).flat()))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    [fieldTypes]
  );

  // Project cards after the regular search and the filters. Search matches the
  // project name or any of its field names; the filter criteria (entry count,
  // field count, field type) apply to each project — same as the entries page.
  const visibleProjects = useMemo(() => {
    let list = applyProjectFilters(activeProjects, projectFilters, {
      entryCounts,
      fieldCounts,
      fieldTypes,
    });
    if (pageSearch.trim()) {
      list = list.filter((p) =>
        projectMatchesSearch(
          (p.project_name as string) || '',
          fieldNames[(p.project_name as string) || ''] ?? [],
          pageSearch
        )
      );
    }
    return list;
  }, [activeProjects, projectFilters, entryCounts, fieldCounts, fieldTypes, fieldNames, pageSearch]);

  // Filtered entries — uses provided sort/search/archive functions
  const filteredEntries = useMemo(() => {
    // Use all entries (unarchived) — ALL_ENTRIES also holds archived rows, so
    // drop them here; the Archives view sources its list from getArchives.
    let filtered = entries.filter((e) => !e.archived);

    if (activeView === 'recent') {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      filtered = filtered.filter((e) => new Date(e.created_at as string) >= weekAgo);
    } else if (activeView !== 'all' && activeView !== 'drafts' && activeView !== 'archives') {
      filtered = filtered.filter((e) => e.project_name === activeView);
    }

    // Always apply "due soon" filter through the shared eligibility rule —
    // identical to the Stats count, the rail guard and the sync cache, so a
    // completed, archived or past-due entry can never linger as due soon.
    filtered = filtered.filter((e) =>
      isDueSoon(
        e.due_date as string | null,
        e.status as string | null,
        e.archived as boolean,
        archivedProjectNames.has(e.project_name as string)
      )
    );

    // Regular search — summary, project name and every field value
    if (pageSearch.trim()) {
      filtered = filtered.filter((e) => matchesTextQuery(e, pageSearch));
    }

    // Project filters — project name, entry count, field count, field type
    filtered = applyProjectFilters(filtered, projectFilters, {
      entryCounts,
      fieldCounts,
      fieldTypes,
    });

    return pinFirst(filtered);
  }, [
    entries,
    activeView,
    archivedProjectNames,
    pageSearch,
    projectFilters,
    entryCounts,
    fieldCounts,
    fieldTypes,
  ]);

  // In-progress entries (started but not ended). Drives the live dashboard timer.
  const inProgressEntries = useMemo(
    () => entries.filter((e) => e.started_at && !e.ended_at),
    [entries]
  );
  // Tick every second only while a task is running.
  const liveNow = useNow(1000, inProgressEntries.length > 0);
  const primaryTimer = useMemo(() => {
    if (inProgressEntries.length === 0) return null;
    const first = inProgressEntries[0];
    return {
      entry: first,
      projectName: (first.project_name as string) || 'Unknown',
      elapsed: formatTimer(entryDurationMs(first, liveNow)),
      extraCount: inProgressEntries.length - 1,
    };
  }, [inProgressEntries, liveNow]);

  // AI-generated empty state message
  useEffect(() => {
    if (!aiMessagesOn) return;
    if (!loading && filteredEntries.length === 0) {
      let cancelled = false;
      (async () => {
        const tone = getToneInstruction();
        const result = await askAI(
          `Generate a motivating message for when there are no items to show. Make it 3-4 sentences long. If the tone is casual or cynical, roast the user playfully and be funny ΓÇö tease them about being lazy, having nothing to do, or wasting their day. Be witty and entertaining. ${tone}`
        );
        if (!cancelled && result.success && result.response) {
          setAiEmptyMessage(parseAIResponse(result.response));
        }
      })();
      return () => {
        cancelled = true;
      };
    }
  }, [aiMessagesOn, loading, filteredEntries.length]);

  // User info
  const fullDisplayName =
    user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || 'User';
  const preferredName = (() => {
    // Priority: profile-service username > localStorage preferred name > full name
    if (profileUsername?.trim()) return profileUsername.trim();
    if (!user?.id) return fullDisplayName;
    try {
      const raw = localStorage.getItem(`dl_settings_profile_${user.id}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.preferredName?.trim()) return parsed.preferredName.trim();
      }
    } catch {}
    return fullDisplayName;
  })();
  // Profile-service avatar/username take priority over Google/OAuth profile data
  const avatarUrl = profileAvatar || user?.user_metadata?.avatar_url;
  const provider = user?.app_metadata?.provider || 'email';

  // Load avatar and username from IndexedDB cache (populated by syncAllData on login)
  useEffect(() => {
    if (!email) return;
    const loadProfile = async () => {
      try {
        const cached = await cacheGet(CACHE_STORES.PROFILE, email);
        const profileData = cached?.data || cached?.profile || cached;
        const avatar = (profileData as Record<string, unknown>)?.avatar as string;
        const username = (profileData as Record<string, unknown>)?.username as string;
        if (avatar) setProfileAvatar(avatar);
        if (username) setProfileUsername(username);
      } catch (err) {
        console.error('[Dashboard] Failed to load profile from cache:', err);
      }
    };
    loadProfile();
    // Re-read when syncAllData or mutations write the profile to IndexedDB
    const unsub = cacheSubscribe(CACHE_STORES.PROFILE, email, () => loadProfile());
    return () => unsub();
  }, [email]);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await signOut();
      navigate('/signin');
    } catch (err) {
      console.error('Logout error:', err);
      setLoggingOut(false);
    }
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAccount();
      // deleteAccount now signs the user out; ProtectedRoute will redirect to /signin.
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete account');
    } finally {
      setDeleting(false);
    }
  };

  const openSettings = (tab: 'profile' | 'preferences' | 'account') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  const resetProjectForm = () => {
    setNewProjectName('');
    setNewProjectDescription('');
    setNewProjectError(null);
    setProjectFields([]);
  };

  const addProjectField = () => {
    setProjectFields((prev) => [
      ...prev,
      { field_name: '', data_type: 'markdown', is_required: false, custom_options: [] },
    ]);
  };

  const removeProjectField = (index: number) => {
    setProjectFields((prev) => prev.filter((_, i) => i !== index));
  };

  const updateProjectField = (index: number, updates: Partial<ProjectFieldDraft>) => {
    setProjectFields((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...updates };
      return next;
    });
  };

  const addCustomOption = (index: number, option: string) => {
    setProjectFields((prev) => {
      const next = [...prev];
      const opts = next[index].custom_options || [];
      if (option.trim() && !opts.includes(option.trim())) {
        next[index] = { ...next[index], custom_options: [...opts, option.trim()] };
      }
      return next;
    });
  };

  const removeCustomOption = (index: number, option: string) => {
    setProjectFields((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        custom_options: (next[index].custom_options || []).filter((o) => o !== option),
      };
      return next;
    });
  };

  const handleTemplateSelect = (template: Template) => {
    const fields: ProjectFieldDraft[] = template.fields.map((field) => ({
      field_name: field.field_name,
      data_type: field.data_type as ProjectFieldDraft['data_type'],
      is_required: field.is_required,
      custom_options: field.options?.map((o: { label: string }) => o.label) || [],
    }));
    setProjectFields(fields);
    setTemplatePickerOpen(false);
  };

  const handleCreateProject = async () => {
    if (!newProjectName.trim() || !email) return;

    // Validate fields before creating project
    const nonEmptyFields = projectFields.filter((f) => f.field_name.trim());
    if (nonEmptyFields.length > 0) {
      // Check for duplicate field names (case-insensitive)
      const fieldNames = nonEmptyFields.map((f) => f.field_name.trim().toLowerCase());
      const duplicates = fieldNames.filter((name, index) => fieldNames.indexOf(name) !== index);
      if (duplicates.length > 0) {
        const uniqueDuplicates = [...new Set(duplicates)];
        setNewProjectError(`Duplicate column names found: ${uniqueDuplicates.join(', ')}`);
        return;
      }
    }

    // Validate custom fields have at least one option
    const emptyCustomFields = nonEmptyFields.filter(
      (f) => f.data_type === 'custom' && (!f.custom_options || f.custom_options.length === 0)
    );
    if (emptyCustomFields.length > 0) {
      setNewProjectError('Custom fields must have at least one option');
      return;
    }

    setCreatingProject(true);
    setNewProjectError(null);

    try {
      const projectName = newProjectName.trim();
      await addProject(email, projectName, newProjectDescription.trim() || undefined);

      // Immediately add the project to local state so the entry picker sees it
      setProjects((prev) => {
        if (prev.some((p) => p.project_name === projectName)) return prev;
        return [
          ...prev,
          {
            project_name: projectName,
            description: newProjectDescription.trim() || '',
            archived: false,
            created_at: new Date().toISOString(),
          },
        ];
      });

      // Save any non-empty project fields (best-effort after project is created)
      // Fields must be added sequentially to avoid cache race conditions
      if (nonEmptyFields.length > 0) {
        const failures: string[] = [];
        for (const f of nonEmptyFields) {
          const dataType =
            f.data_type === 'custom' ? `custom:${(f.custom_options || []).join(',')}` : f.data_type;
          const result = await addField(
            email,
            projectName,
            f.field_name.trim(),
            dataType,
            f.is_required
          );
          if (result?.success === false) {
            failures.push(f.field_name);
          }
        }
        if (failures.length > 0) {
          setNewProjectError(
            `Project created, but these fields could not be saved: ${failures.join(', ')}`
          );
        }
      }

      setNewProjectOpen(false);
      resetProjectForm();
      await loadData();

      // Navigate to the newly created project's page
      navigate(`/project/${encodeURIComponent(projectName)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create project';
      console.error('Failed to create project:', err);
      setNewProjectError(message);
    } finally {
      setCreatingProject(false);
    }
  };

  // Archive project ΓÇö uses localStorage (DB UPDATE blocked by RLS)
  const handleArchiveProject = async (projectName: string) => {
    if (!email) {
      setArchiveError('Cannot archive: no email');
      return;
    }
    setArchiveError(null);
    // Update local state immediately for instant UI feedback
    setProjects((prev) =>
      prev.map((p) => (p.project_name === projectName ? { ...p, archived: true } : p))
    );
    const project = projects.find((p) => p.project_name === projectName);
    if (project) {
      setArchivedProjects((prev) => [...prev, { ...project, archived: true }]);
    }
    // Save to localStorage for persistence across reloads
    const next = new Set(localArchived);
    next.add(projectName);
    setLocalArchived(next);
    try {
      localStorage.setItem(`dl_archived_${email}`, JSON.stringify([...next]));
    } catch {}
    // Sync to server via project-service
    try {
      const { archiveProject } = await import('@/functions/project/archives.js');
      await archiveProject(email, projectName);
    } catch {}
  };

  // Pin/unpin a project — local-only ordering, persisted per user.
  const togglePinProject = (projectName: string) => {
    if (!email) return;
    setPinnedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectName)) next.delete(projectName);
      else next.add(projectName);
      try {
        localStorage.setItem(`dl_pinned_projects_${email}`, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  };

  // Delete a project (project-service cascades its entries server-side).
  const handleDeleteProject = async (projectName: string) => {
    if (!email || deletingProject) return;
    setDeletingProject(projectName);
    setArchiveError(null);
    try {
      const { deleteProject } = await import('@/functions/project/project.js');
      const result = await deleteProject(email, projectName);
      if (result?.success === false) {
        throw new Error(result.message || 'Failed to delete project');
      }
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : 'Failed to delete project');
      setDeletingProject(null);
      setConfirmDeleteProject(null);
      return;
    }
    // Drop it from the in-memory lists immediately; deleteProject already
    // updated the IndexedDB cache optimistically.
    setProjects((prev) => prev.filter((p) => p.project_name !== projectName));
    setArchivedProjects((prev) => prev.filter((p) => p.project_name !== projectName));
    setDeletingProject(null);
    setConfirmDeleteProject(null);
    await loadData();
  };

  const handleUnarchiveProject = async (projectName: string) => {
    if (!email) return;
    setArchiveError(null);
    try {
      const { unarchiveProject } = await import('@/functions/project/archives.js');
      const result = await unarchiveProject(email, projectName);
      if (result?.success === false)
        throw new Error(result.message || 'Failed to unarchive project');
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : 'Failed to unarchive project');
      return;
    }
    // Update local state
    setProjects((prev) =>
      prev.map((p) => (p.project_name === projectName ? { ...p, archived: false } : p))
    );
    setArchivedProjects((prev) => prev.filter((p) => p.project_name !== projectName));
    const next = new Set(localArchived);
    next.delete(projectName);
    setLocalArchived(next);
    try {
      localStorage.setItem(`dl_archived_${email}`, JSON.stringify([...next]));
    } catch {}
  };

  const PRIORITY_LABELS: Record<string, string> = {
    '0': 'Urgent and important',
    '1': 'Urgent but not important',
    '2': 'Not urgent, not important',
  };

  const handleSetPriority = async (entryId: string, projectName: string, priorityValue: string) => {
    if (!email) return;
    try {
      const priorityLabel = priorityValue === '3' ? null : PRIORITY_LABELS[priorityValue];
      const result = await setPriority(email, priorityValue, projectName, entryId);
      if (result?.success === false) {
        console.error('Failed to set priority:', result.message);
        return;
      }
      // Update the entry in local state
      setEntries((prev: Entry[]) =>
        prev.map((e: Entry) => (e.id === entryId ? { ...e, priority: priorityLabel } : e))
      );
    } catch (err) {
      console.error('Failed to set priority:', err);
    }
  };

  // True when the feed is showing a single project (not a meta view)
  const isProjectView =
    activeView !== 'all' &&
    activeView !== 'recent' &&
    activeView !== 'drafts' &&
    activeView !== 'archives' &&
    activeView !== 'activity';

  return (
    <div className="dash-layout">
      <div className="bg-mesh" />

      {/* Top Navigation */}
      <nav className="navbar">
        <div className="navbar-inner">
          <div className="nav-left-group">
            <button
              className="nav-hamburger"
              data-tour="menu"
              onClick={() => setDrawerOpen(!drawerOpen)}
              aria-label="Toggle menu"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <button
              className="nav-back-btn"
              onClick={() => navigate(-1)}
              aria-label="Go back"
              title="Back"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <button
              className="nav-forward-btn"
              onClick={() => navigate(1)}
              aria-label="Go forward"
              title="Forward"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            <button
              className="nav-home-btn"
              onClick={() => navigate('/dashboard')}
              aria-label="Go to dashboard"
              title="Dashboard"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </button>
          </div>

          <div className="nav-right-group">
            <button
              type="button"
              className="nav-tour-btn"
              data-tour="nav-guide"
              onClick={() => startAppTour()}
              aria-label="Start the guided tour"
              title="Take the tour"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span className="nav-tour-label">Guide</span>
            </button>
            <div data-tour="nav-bell">
              <NotificationsBell email={email} />
            </div>
            <div className="nav-user" data-tour="nav-profile">
              <ProfileMenu
                displayName={preferredName}
                email={user?.email || ''}
                avatarUrl={avatarUrl}
                onManageProfile={() => openSettings('profile')}
                onSettings={() => openSettings('preferences')}
                onSignOut={handleLogout}
                signingOut={loggingOut}
              />
            </div>
          </div>
        </div>
      </nav>

      {/* Left Drawer Overlay */}
      {drawerOpen && <div className="drawer-overlay" onClick={() => setDrawerOpen(false)} />}

      {/* Left Drawer */}
      <aside className={`drawer ${drawerOpen ? 'drawer-open' : ''}`}>
        <div className="drawer-header">
          <span className="drawer-title">Navigation</span>
          <button className="drawer-close" onClick={() => setDrawerOpen(false)}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="drawer-section">
          <p className="drawer-section-title">Views</p>
          <button
            className={`drawer-item ${activeView === 'all' ? 'active' : ''}`}
            data-tour="drawer-home"
            onClick={() => {
              navigate('/dashboard/all');
              setDrawerOpen(false);
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            Home
            <span className="drawer-badge">{entries.length}</span>
          </button>
          <button
            className="drawer-item"
            onClick={() => {
              navigate('/entries');
              setDrawerOpen(false);
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            All Items
          </button>
          <button
            className={`drawer-item ${activeView === 'archives' ? 'active' : ''}`}
            onClick={() => {
              setActiveView('archives');
              setDrawerOpen(false);
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />
            </svg>
            Archives
          </button>
          <button
            className="drawer-item"
            data-tour="drawer-calendar"
            onClick={() => {
              navigate('/calendar');
              setDrawerOpen(false);
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            Calendar
          </button>
          <button
            className="drawer-item"
            data-tour="drawer-kanban"
            onClick={() => {
              navigate('/kanban');
              setDrawerOpen(false);
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
            </svg>
            Kanban
          </button>
          <button
            className="drawer-item"
            data-tour="drawer-timeline"
            onClick={() => {
              navigate('/timeline');
              setDrawerOpen(false);
            }}
            title="See a chronological timeline of all your items across projects"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="3" y1="12" x2="21" y2="12" />
              <polyline points="8 8 12 4 16 8" />
              <polyline points="8 16 12 20 16 16" />
            </svg>
            Timeline
          </button>
          <button
            className="drawer-item"
            data-tour="drawer-import-export"
            onClick={() => {
              navigate('/data-portability');
              setDrawerOpen(false);
            }}
            title="Export all your data or import from a backup"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Import & Export
          </button>
          <button
            className="drawer-item"
            onClick={() => {
              navigate('/data-disclaimer-info');
              setDrawerOpen(false);
            }}
            title="Learn how your data is stored and how AI is used"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            Disclaimer
          </button>
          <button
            className="drawer-item"
            data-tour="drawer-stats"
            onClick={() => {
              navigate('/stats');
              setDrawerOpen(false);
            }}
            title="View statistics and insights about your items"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            My Stats
          </button>
          <button
            className={`drawer-item ${activeView === 'activity' ? 'active' : ''}`}
            onClick={() => {
              navigate('/dashboard/activity');
              setDrawerOpen(false);
            }}
            title="See a feed of recent activity across all projects"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            Activity Log
          </button>
        </div>

        <div className="drawer-section drawer-projects">
          <p className="drawer-section-title" data-tour="drawer-projects">
            Projects
          </p>
          <div className="drawer-project-list">
            {projects
              .filter((p) => !p.archived)
              .map((project) => {
                const name = project.project_name as string;
                const count = entries.filter((e) => e.project_name === name).length;
                const projColor = (project.project_color as string) || colorForName(name);
                return (
                  <div
                    key={name}
                    className={`drawer-item ${activeView === name ? 'active' : ''}`}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        navigate(`/project/${encodeURIComponent(name)}`);
                        setDrawerOpen(false);
                      }}
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        background: 'none',
                        border: 'none',
                        color: 'inherit',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          background: projColor,
                          flexShrink: 0,
                        }}
                      />
                      {name}
                      <span className="drawer-badge">{count}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleArchiveProject(name)}
                      title="Archive project"
                      style={{
                        background: 'transparent',
                        border: '1px solid rgba(139, 115, 85, 0.3)',
                        color: 'var(--text-secondary, #6b7280)',
                        borderRadius: '0.4rem',
                        padding: '0.2rem 0.5rem',
                        fontSize: '0.7rem',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                      }}
                    >
                      <FiArchive size={12} />
                      Archive
                    </button>
                  </div>
                );
              })}
            {projects.filter((p) => !p.archived).length === 0 && (
              <p className="drawer-empty">No projects yet. Create one below.</p>
            )}
          </div>
        </div>

        <div className="drawer-footer">
          <button
            className="btn-primary drawer-new-btn"
            data-tour="drawer-new-project"
            onClick={() => {
              setNewProjectOpen(true);
              setDrawerOpen(false);
            }}
            title="Create a new project to organize your items"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Project
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              navigate('/projects');
              setDrawerOpen(false);
            }}
            style={{ marginTop: '0.5rem', width: '100%' }}
            title="View and manage all your projects"
          >
            Manage Projects
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="dash-main">
        {/* Timer abandonment banner — shows when entries have active timers past thresholds */}
        <AbandonedTimerBanner
          entries={entries as any}
          onNavigate={(projectName) => navigate(`/project/${encodeURIComponent(projectName)}`)}
        />

        {/* One-time guided-tour offer for new users */}
        {showTourOffer && (
          <div className="tour-offer" role="status">
            <p className="tour-offer-text">
              <strong>New here?</strong> Take the two-minute tour to learn your way around.
            </p>
            <div className="tour-offer-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setShowTourOffer(false);
                  startAppTour();
                }}
              >
                Start tour
              </button>
              <button
                type="button"
                className="tour-offer-dismiss"
                onClick={() => setShowTourOffer(false)}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* AI Greeting Toast */}
        {showGreetingToast && aiGreeting && (
          <div className="ai-toast animate-in">
            <p>{aiGreeting}</p>
          </div>
        )}

        {/* Feed Header */}
        <div className="feed-header animate-in">
          <div className="feed-header-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <h1 className="feed-title">
                {activeView === 'all'
                  ? 'Home'
                  : activeView === 'recent'
                    ? 'Recent'
                    : activeView === 'drafts'
                      ? 'Drafts'
                      : activeView === 'archives'
                        ? 'Archives'
                        : activeView === 'activity'
                          ? 'Activity Log'
                          : activeView}
              </h1>
              {/* Project settings three-dots menu - only show for specific projects */}
              {activeView !== 'all' &&
                activeView !== 'recent' &&
                activeView !== 'drafts' &&
                activeView !== 'archives' &&
                activeView !== 'activity' && (
                  <div
                    className="project-menu-wrap"
                    ref={projectMenuRef}
                    style={{ position: 'relative' }}
                  >
                    <button
                      type="button"
                      className="entry-box__menu-btn"
                      onClick={() => setProjectMenuOpen((v) => !v)}
                      aria-label="Project settings"
                      aria-expanded={projectMenuOpen}
                      style={{ position: 'static' }}
                    >
                      ⋯
                    </button>
                    {projectMenuOpen && (
                      <div
                        className="entry-box__menu"
                        style={{ top: '100%', right: 'auto', left: 0 }}
                      >
                        <button
                          type="button"
                          className="entry-box__menu-item"
                          onClick={() => {
                            setSettingsProjectName(activeView);
                            setProjectSettingsOpen(true);
                            setProjectMenuOpen(false);
                          }}
                        >
                          Project Settings
                        </button>
                        <button
                          type="button"
                          className="entry-box__menu-item"
                          onClick={() => {
                            handleArchiveProject(activeView);
                            setProjectMenuOpen(false);
                          }}
                          style={{
                            color: 'var(--text-secondary, #6b7280)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                          }}
                        >
                          <FiArchive size={16} /> Archive Project
                        </button>
                      </div>
                    )}
                  </div>
                )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Stats
                entries={entries}
                projects={projects}
                dueSoonCount={dueSoonCount}
                activeProject={isProjectView ? activeView : undefined}
              />
            </div>
          </div>
        </div>

        {/* Live running-timer banner — shows when a task is in progress */}
        {primaryTimer && activeView !== 'activity' && activeView !== 'archives' && (
          <TimerBanner
            entry={primaryTimer.entry}
            projectName={primaryTimer.projectName}
            elapsed={primaryTimer.elapsed}
            extraCount={primaryTimer.extraCount}
            onUpdated={() => loadData()}
          />
        )}

        {/* Search bar inline for mobile */}
        {activeView === 'activity' ? (
          <>
            <ActivitySummary />
            <ActivityFeed />
          </>
        ) : activeView === 'archives' ? (
          <div className="archives-section">
            {archiveError && (
              <div className="auth-error" style={{ marginBottom: '1rem' }}>
                {archiveError}
              </div>
            )}

            {/* Archived Projects */}
            <h2 className="archives-section-title">
              <FiArchive size={16} /> Archived Projects
              <span className="archives-section-count">({archivedProjects.length})</span>
            </h2>
            {archivedProjects.length === 0 ? (
              <p className="archives-empty-line">No archived projects</p>
            ) : (
              <div className="archived-projects-grid">
                {archivedProjects.map((project, i) => {
                  const name = project.project_name as string;
                  return (
                    <div key={`archived-${name}-${i}`} className="glass archived-project-card">
                      <FiArchive size={18} className="archived-project-icon" />
                      <div className="archived-project-info">
                        <span className="archived-project-name">{name}</span>
                        <span className="archived-project-status">Archived · read-only</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleUnarchiveProject(name)}
                        className="btn-secondary archived-project-unarchive"
                      >
                        <FiRotateCcw size={13} /> Unarchive
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Archived Entries */}
            <h2 className="archives-section-title archives-entries-title">
              <FiArchive size={16} /> Archived Entries
              <span className="archives-section-count">({archivedEntries.length})</span>
            </h2>
            {archivedEntries.length === 0 ? (
              <div className="empty-state animate-in">
                <div className="empty-icon">
                  <FiArchive size={40} />
                </div>
                <h2 className="empty-title">No archived entries</h2>
                <p className="empty-desc">Archive an entry from the ⋯ menu to see it here.</p>
              </div>
            ) : (
              <div className="entries-feed">
                {archivedEntries.map((row, i) => (
                  <EntryBox
                    key={`archived-entry-${row.id || i}`}
                    entry={row as any}
                    onUpdated={() => loadData()}
                    onPriorityChanged={handleSetPriority}
                    onArchiveToggled={(entryId, isArchived) => {
                      if (!isArchived) {
                        setArchivedEntries((prev) => prev.filter((e) => e.id !== entryId));
                      }
                    }}
                    projectColor={resolveProjectColor(
                      (row.project_name as string) || '',
                      dashColorMap
                    )}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Search + AI quick-add bar — project-level filters match the
                entries page so the funnel icon is available on Home too. */}
            <div className="search-ai-row">
              <ProjectFilterBlock
                query={pageSearch}
                onQueryChange={setPageSearch}
                placeholder="Search projects or entries..."
                projectNames={projectNames}
                filters={projectFilters}
                onFiltersChange={setProjectFilters}
                showProjectName={false}
                fieldTypeOptions={fieldTypeOptions}
              />
              <div data-tour="quick-entry" className="search-ai-row__ai">
                <QuickEntryBar
                  onEntryCreated={(info) => {
                    loadData();
                    // Only navigate when there's exactly one clear target — a
                    // multi-match spread across projects must not yank the user
                    // into an arbitrary one.
                    if ((info?.created?.length ?? 0) === 1 && info?.projectName) {
                      navigate(`/project/${encodeURIComponent(info.projectName)}`);
                    }
                  }}
                  onVoiceOpen={() => setVoiceOpen(true)}
                  placeholder={aiPlaceholder}
                />
              </div>
            </div>

            {/* Page switcher: Projects / Entries — sits above the split so the
                due-soon rail's top lines up with the project cards. */}
            <div className="page-switcher-row">
              <div
                className="feed-view-toggle"
                role="group"
                aria-label="Switch between entries and projects"
              >
                <button
                  type="button"
                  className="feed-view-btn active"
                  aria-current="page"
                  onClick={() => navigate('/dashboard')}
                  title="Back to projects"
                >
                  Projects
                </button>
                <button
                  type="button"
                  className="feed-view-btn"
                  onClick={() => navigate('/entries')}
                  title="Browse all entries"
                >
                  Entries
                </button>
              </div>
            </div>

            {/* Two-column split: projects + calendar on the left, the due-soon
                quick list on the right. */}
            <div className="dash-split">
              <div className="dash-split__main">

            {/* Projects — inline card grid with quick actions */}
            <section className="home-projects animate-in" data-tour="home-projects">
              <div className="projects-grid">
                {/* Create-new-project card leads the grid so it is always first. */}
                <button
                  type="button"
                  className="project-card project-card--add"
                  data-tour="home-new-project"
                  onClick={() => setNewProjectOpen(true)}
                  title="Create a new project"
                >
                  <span className="project-card-add-plus" aria-hidden>
                    +
                  </span>
                  <span className="project-card-add-label">Add New Project</span>
                </button>
                {visibleProjects.map((project) => {
                  const name = project.project_name as string;
                  const count = entries.filter((e) => e.project_name === name).length;
                  const inMotionCount = entries.filter(
                    (e) => e.project_name === name && e.status === 'in_motion'
                  ).length;
                  const doneCount = entries.filter(
                    (e) => e.project_name === name && e.status === 'done_and_dusted'
                  ).length;
                  const isPinned = pinnedProjects.has(name);
                  const isConfirmingDelete = confirmDeleteProject === name;
                  const cardAccent = resolveProjectColor(name, dashColorMap);
                  return (
                    <div
                      key={name}
                      className={`project-card project-card--actionable ${isPinned ? 'is-pinned' : ''}`}
                      style={{
                        borderLeft: `3px solid ${cardAccent}`,
                        background: `linear-gradient(0deg, ${cardAccent}18, ${cardAccent}18), var(--surface)`,
                      }}
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(`/project/${encodeURIComponent(name)}`)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          navigate(`/project/${encodeURIComponent(name)}`);
                        }
                      }}
                    >
                      <div className="project-card-header">
                        <h3 className="project-card-name">{name}</h3>
                        <span className="project-card-count">{count} entries</span>
                      </div>
                      <div className="project-card-stats">
                        {inMotionCount > 0 && (
                          <span className="project-card-stat project-card-stat--active">
                            {inMotionCount} in progress
                          </span>
                        )}
                        {doneCount > 0 && (
                          <span className="project-card-stat project-card-stat--done">
                            {doneCount} done
                          </span>
                        )}
                      </div>
                      {isConfirmingDelete ? (
                        <div
                          className="project-card-confirm"
                          role="group"
                          aria-label="Confirm project deletion"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <span className="project-card-confirm-text">Delete this project?</span>
                          <button
                            type="button"
                            className="project-card-confirm-yes"
                            disabled={deletingProject === name}
                            onClick={() => handleDeleteProject(name)}
                          >
                            {deletingProject === name ? 'Deleting…' : 'Yes, delete'}
                          </button>
                          <button
                            type="button"
                            className="project-card-confirm-cancel"
                            onClick={() => setConfirmDeleteProject(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div
                          className="project-card-actions"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="project-card-action-btn"
                            onClick={() => {
                              setSettingsProjectName(name);
                              setProjectSettingsOpen(true);
                            }}
                            title="Edit project"
                          >
                            <FiEdit2 size={12} />
                            Edit
                          </button>
                          <button
                            type="button"
                            className={`project-card-action-btn project-card-pin-btn ${isPinned ? 'is-pinned' : ''}`}
                            aria-pressed={isPinned}
                            onClick={() => togglePinProject(name)}
                            title={isPinned ? 'Unpin project' : 'Pin project'}
                          >
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill={isPinned ? 'currentColor' : 'none'}
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <line x1="12" y1="17" x2="12" y2="22" />
                              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z" />
                            </svg>
                            {isPinned ? 'Pinned' : 'Pin'}
                          </button>
                          <button
                            type="button"
                            className="project-card-action-btn"
                            onClick={() => handleArchiveProject(name)}
                            title="Archive project"
                          >
                            <FiArchive size={12} />
                            Archive
                          </button>
                          <button
                            type="button"
                            className="project-card-action-btn project-card-action-btn--danger"
                            onClick={() => setConfirmDeleteProject(name)}
                            title="Delete project"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {visibleProjects.length === 0 && (
                <p className="projects-empty-note">No projects match your search or filters.</p>
              )}
            </section>

            {/* Due-soon feed removed — the same entries now live in the right rail. */}

            {/* Entries feed removed — the due-soon entries live in the right rail. */}

            {/* Calendar Section */}
            <div className="dashboard-calendar-section">
              <div className="calendar-toolbar" style={{ marginBottom: '0.5rem' }}>
                <div className="calendar-nav">
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => setCalDate((d) => addMonths(d, -1))}
                    aria-label="Previous month"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setCalDate(new Date())}
                    style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => setCalDate((d) => addMonths(d, 1))}
                    aria-label="Next month"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                </div>
                <h2 className="calendar-period" style={{ fontSize: '1rem', fontWeight: 600 }}>
                  {formatMonthYear(calDate)}
                </h2>
              </div>
              <div className="calendar-grid">
                {calHeaderDays.map((day) => (
                  <div key={day.toISOString()} className="calendar-header-cell">
                    {formatShortDay(day)}
                  </div>
                ))}
                {calDays.map((day) => {
                  const isCurrentMonth = day.getMonth() === calDate.getMonth();
                  const dayEntries = getEntriesForDay(calEntries, day);
                  const isToday = isSameDay(day, new Date());
                  const dayOverdue = isCalDayOverdue(day);
                  return (
                    <div
                      key={day.toISOString()}
                      className={[
                        'calendar-day',
                        !isCurrentMonth && 'calendar-day--outside',
                        isToday && 'calendar-day--today',
                        dayOverdue && 'calendar-day--overdue',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <div className="calendar-day-header">
                        <span className="calendar-day-number">{formatDayNumber(day)}</span>
                        {isToday && <span className="calendar-day-today-label">Today</span>}
                      </div>
                      <div className="calendar-day-entries">
                        {dayEntries.slice(0, 3).map((entry) => {
                          const entryColor = resolveProjectColor(
                            entry.project_name || '',
                            dashColorMap
                          );
                          return (
                            <div
                              key={entry.id}
                              className={[
                                'calendar-entry',
                                entry.status === 'done_and_dusted' && 'calendar-entry--completed',
                                isOverdue(entry.due_date ?? null, entry.status ?? 'up_next') &&
                                  'calendar-entry--overdue',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              title={getEntryTitle(entry)}
                              onClick={() =>
                                navigate(`/project/${encodeURIComponent(entry.project_name)}`)
                              }
                              style={{ borderLeft: `3px solid ${entryColor}` }}
                            >
                              <span className="calendar-entry-title">{getEntryTitle(entry)}</span>
                              <span className="calendar-entry-project">{entry.project_name}</span>
                            </div>
                          );
                        })}
                        {dayEntries.length > 3 && (
                          <span className="calendar-more-label">+{dayEntries.length - 3} more</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="calendar-legend">
                <span className="calendar-legend-item">
                  <span className="calendar-legend-dot calendar-legend-dot--overdue" />
                  Overdue
                </span>
                <span className="calendar-legend-item">
                  <span className="calendar-legend-dot calendar-legend-dot--completed" />
                  Completed
                </span>
                <span className="calendar-legend-item">
                  <span className="calendar-legend-dot calendar-legend-dot--upcoming" />
                  Upcoming
                </span>
              </div>
            </div>
              </div>

              <DueSoonRail entries={filteredEntries} />
            </div>
          </>
        )}
      </main>

      {/* New Project Modal */}
      {newProjectOpen && (
        <div className="modal-overlay" onClick={() => setNewProjectOpen(false)}>
          <div className="modal-card glass modal-card-wide" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">New Project</h2>
            <input
              type="text"
              placeholder="Project name"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              className="field-input"
              autoFocus
            />
            <textarea
              placeholder="Description (optional)"
              value={newProjectDescription}
              onChange={(e) => setNewProjectDescription(e.target.value)}
              className="field-input"
              rows={3}
              style={{ resize: 'vertical', minHeight: '60px' }}
            />

            {/* Template Picker */}
            <div style={{ marginBottom: '1rem' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setTemplatePickerOpen(true)}
                style={{ width: '100%', padding: '0.75rem' }}
              >
                📋 Choose a Template (optional)
              </button>
            </div>

            {/* Project Fields */}
            <div className="project-fields-section" style={{ marginTop: '1rem' }}>
              <h3
                className="project-fields-title"
                style={{ fontSize: '0.95rem', fontWeight: 600, margin: '0 0 0.5rem' }}
              >
                Project Columns
              </h3>
              {projectFields.length === 0 && (
                <p
                  style={{
                    fontSize: '0.875rem',
                    color: 'var(--text-secondary)',
                    margin: '0 0 0.5rem',
                  }}
                >
                  No columns defined. Add columns to build the entry form for this project.
                </p>
              )}
              {projectFields.map((field, index) => (
                <Fragment key={index}>
                  <div
                    className="project-field-row"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto auto auto',
                      gap: '0.5rem',
                      alignItems: 'center',
                      marginBottom: '0.5rem',
                    }}
                  >
                    <input
                      type="text"
                      placeholder="Column name"
                      value={field.field_name}
                      onChange={(e) => updateProjectField(index, { field_name: e.target.value })}
                      className="field-input"
                    />
                    <select
                      value={field.data_type}
                      onChange={(e) =>
                        updateProjectField(index, {
                          data_type: e.target.value as ProjectFieldDraft['data_type'],
                        })
                      }
                      className="field-input"
                      style={{ width: 'auto' }}
                    >
                      <option value="text">Text</option>
                      <option value="markdown">Markdown</option>
                      <option value="integer">Integer</option>
                      <option value="float">Float</option>
                      <option value="number">Number</option>
                      <option value="date">Date</option>
                      <option value="timestamp">Timestamp</option>
                      <option value="boolean">Boolean</option>
                      <option value="geolocation">Geolocation</option>
                      <option value="currency">Currency</option>
                      <option value="file">File</option>
                      <option value="image">Image</option>
                      <option value="entity_link">Entity Link</option>
                      <option value="tags">Tags</option>
                      <option value="checklist">Checklist</option>
                      <option value="custom">Custom (Legacy)</option>
                    </select>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        fontSize: '0.875rem',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={field.is_required}
                        onChange={(e) =>
                          updateProjectField(index, { is_required: e.target.checked })
                        }
                      />
                      Required
                    </label>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => removeProjectField(index)}
                      title="Remove column"
                    >
                      <FiX size={16} />
                    </button>
                  </div>
                  {field.data_type === 'custom' && (
                    <div style={{ marginBottom: '0.5rem', paddingLeft: '0.5rem' }}>
                      <div
                        style={{
                          display: 'flex',
                          gap: '0.5rem',
                          alignItems: 'center',
                          marginBottom: '0.25rem',
                        }}
                      >
                        <input
                          type="text"
                          placeholder="Add option..."
                          className="field-input"
                          style={{ flex: 1 }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const val = (e.target as HTMLInputElement).value.trim();
                              if (val) {
                                addCustomOption(index, val);
                                (e.target as HTMLInputElement).value = '';
                              }
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="btn-secondary"
                          style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
                          onClick={(e) => {
                            const input = (e.target as HTMLElement)
                              .previousElementSibling as HTMLInputElement;
                            const val = input.value.trim();
                            if (val) {
                              addCustomOption(index, val);
                              input.value = '';
                            }
                          }}
                        >
                          +
                        </button>
                      </div>
                      {(field.custom_options || []).length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                          {(field.custom_options || []).map((opt) => (
                            <span
                              key={opt}
                              className="field-badge"
                              style={{ cursor: 'pointer' }}
                              onClick={() => removeCustomOption(index, opt)}
                              title="Click to remove"
                            >
                              {opt} ×
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </Fragment>
              ))}
              <button
                type="button"
                className="btn-secondary"
                onClick={addProjectField}
                style={{ marginTop: '0.25rem' }}
              >
                + Add Another Project Column
              </button>
            </div>

            {newProjectError && (
              <div className="auth-error" style={{ marginBottom: '0.75rem', marginTop: '0.75rem' }}>
                {newProjectError}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="btn-secondary"
                onClick={() => {
                  setNewProjectOpen(false);
                  resetProjectForm();
                }}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={handleCreateProject}
                disabled={creatingProject || !newProjectName.trim()}
              >
                {creatingProject ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Template Picker Modal */}
      {templatePickerOpen && (
        <div className="modal-overlay" onClick={() => setTemplatePickerOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
            <TemplatePicker
              onSelect={handleTemplateSelect}
              onCancel={() => setTemplatePickerOpen(false)}
            />
          </div>
        </div>
      )}

      {/* New Entry Modal */}
      {newEntryOpen && (
        <div
          className="modal-overlay"
          onClick={() => {
            setNewEntryOpen(false);
            setNewEntryProject('');
          }}
        >
          <div
            className={`modal-card glass modal-card-wide${newEntryProject ? ' modal-card--entry' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            {!newEntryProject ? (
              <>
                <h2 className="modal-title">New Item</h2>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: 0 }}>
                  Select a project:
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                  {projects
                    .filter((p) => !p.archived)
                    .map((p) => (
                      <button
                        key={p.project_name as string}
                        className="drawer-item"
                        onClick={() => setNewEntryProject(p.project_name as string)}
                        style={{ textAlign: 'left', justifyContent: 'flex-start' }}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                        </svg>
                        {p.project_name as string}
                      </button>
                    ))}
                  {projects.filter((p) => !p.archived).length === 0 && (
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                      No projects yet. Create one first.
                    </p>
                  )}
                </div>
                <div className="modal-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      setNewEntryOpen(false);
                      setNewEntryProject('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <AddEntry
                user_email={email}
                project_name={newEntryProject}
                onAdded={() => {
                  setNewEntryOpen(false);
                  setNewEntryProject('');
                  loadData();
                  // Navigate to the project page where the entry was created
                  navigate(`/project/${encodeURIComponent(newEntryProject)}`);
                }}
                onCancel={() => {
                  setNewEntryOpen(false);
                  setNewEntryProject('');
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* Voice Feature Modal */}
      {voiceOpen && (
        <VoiceFeature
          onClose={() => setVoiceOpen(false)}
          onEntryCreated={() => {
            setVoiceOpen(false);
            loadData();
          }}
        />
      )}

      {/* Settings Panel */}
      <SettingsPanel
        open={settingsOpen}
        initialTab={settingsTab}
        userId={user?.id || ''}
        displayName={fullDisplayName}
        email={user?.email || ''}
        avatarUrl={avatarUrl}
        provider={provider}
        onClose={() => setSettingsOpen(false)}
        onDeleteAccount={handleDeleteAccount}
        onResetPassword={resetPassword}
        deleting={deleting}
        deleteError={deleteError}
      />

      {/* Project Settings Panel */}
      <ProjectSettingsPanel
        open={projectSettingsOpen}
        projectName={settingsProjectName}
        userEmail={email}
        currentColor={dashColorMap[settingsProjectName] || null}
        onClose={() => setProjectSettingsOpen(false)}
        onProjectUpdated={() => {
          setActiveView('all');
          loadData();
        }}
        onProjectDeleted={() => {
          setActiveView('all');
          loadData();
        }}
      />
    </div>
  );
}
