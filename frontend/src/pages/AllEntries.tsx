import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { NavBar } from '@/components/NavBar';
import { Header } from '@/components/Header';
import { QuickEntryBar } from '@/components/QuickEntryBar';
import { ProjectFilterBlock } from '@/components/SearchFilters';
import { ToolbarDropdown } from '@/components/ToolbarDropdown';
import { DueSoonRail } from '@/components/DueSoonRail';
import { setPriority } from '@/functions/project/priority.js';
import { getFields } from '@/functions/project/fields.js';
import { checkUser } from '@/functions/profile/login.js';
import { cacheGet, cacheSubscribe, CACHE_STORES } from '@/lib/cache';
import { syncAllData } from '@/CacheFunctions';
import { trackCreatedEntry } from '@/lib/recentlyCreated';
import { EntryBox } from '@/pages/NewEntry';
import { AddEntry } from '@/pages/AddEntry';
import { KanbanBoardView } from '@/pages/Kanban';
import { TimelineView } from '@/pages/Timeline';
import { ChecklistView } from '@/Templates/EntryTemplates/EntryChecklist';
import EntriesByDueDateBoard from '@/Templates/ProjectTemplates/EntriesByDueDateBoard';
import ProjectTaskTable from '@/Templates/ProjectTemplates/ProjectTable';
import VoiceFeature from '@/pages/VoiceFeature';
import { type EntryPayload } from '@/lib/entryPayload';
import { type CalendarEntry } from '@/lib/calendar';
import { buildProjectColorMap, resolveProjectColor } from '@/lib/projectColorMap';
import { normalizeField } from '@/lib/fieldSchema';
import {
  activeProjectFilterCount,
  applyProjectFilters,
  defaultProjectFilters,
  matchesTextQuery,
  pinFirst,
  type ProjectFilters,
} from '@/lib/entryFilters';
import { usePref, setPref } from '@/functions/preferences';
import { isActiveEntry } from '@/functions/dashboard/overdue.js';
import { getEffectiveArchivedProjectNames } from '@/functions/project/archiveState.js';

type Entry = Record<string, unknown>;
type DisplayMode = 'cards' | 'checklist' | 'board' | 'table' | 'kanban' | 'timeline';

export function AllEntriesPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  // Sort state - persisted per-user in the local preferences store
  const sortBy = usePref('allentries_sort_by') as 'priority' | 'date';
  const setSortBy = useCallback((next: 'priority' | 'date') => {
    void setPref('allentries_sort_by', next);
  }, []);

  // Display mode: cards, checklist, board, table, kanban, or timeline - persisted per-user
  const rawDisplayMode = usePref('allentries_display_mode');
  const displayMode = (
    rawDisplayMode === 'checklist' ||
    rawDisplayMode === 'board' ||
    rawDisplayMode === 'table' ||
    rawDisplayMode === 'kanban' ||
    rawDisplayMode === 'timeline'
      ? rawDisplayMode
      : 'cards'
  ) as DisplayMode;
  const setDisplayMode = useCallback((next: DisplayMode) => {
    void setPref('allentries_display_mode', next);
  }, []);

  // Data state
  const [entries, setEntries] = useState<Entry[]>([]);
  const [projects, setProjects] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);

  // Voice recorder
  const [voiceOpen, setVoiceOpen] = useState(false);

  // Corner add-entry button — project picker then the entry form
  const [newEntryOpen, setNewEntryOpen] = useState(false);
  const [newEntryProject, setNewEntryProject] = useState('');

  // Feed filters — entries are mixed across projects, so the panel narrows the
  // feed by project-level criteria (project name, entry count, field count)
  // instead of per-project field values.
  const [projectFilters, setProjectFilters] = useState<ProjectFilters>(() =>
    defaultProjectFilters()
  );
  // Field counts per project — read from the fields cache, fetched when missing.
  const [fieldCounts, setFieldCounts] = useState<Record<string, number>>({});
  // Field data types per project — powers the field-type filter.
  const [fieldTypes, setFieldTypes] = useState<Record<string, string[]>>({});

  // Static placeholder for quick entry (no AI) — kept in sync with the home page
  const aiPlaceholder = 'Capture quick entry';

  const email = user?.email || '';

  // Safety check for deleted accounts
  useEffect(() => {
    if (!email) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await checkUser(email);
        if (!cancelled && result.exists && result.deleted) {
          try {
            await signOut();
          } catch {}
        }
      } catch (err) {
        console.error('AllEntries deleted-check failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email, signOut]);

  // Load data — read ONLY from IndexedDB. Mutations update it directly.
  // Guard against overlapping calls: mount effect + two cacheSubscribe
  // listeners + SSE onEntry can all fire loadData within the same tick.
  const loadSeq = useRef(0);

  const loadData = useCallback(async () => {
    if (!email) return;
    const seq = ++loadSeq.current;
    try {
      const [cachedEntries, cachedProjects] = await Promise.all([
        cacheGet(CACHE_STORES.ALL_ENTRIES, email),
        cacheGet(CACHE_STORES.PROJECTS, email),
      ]);
      if (seq !== loadSeq.current) return;
      // Render whatever is cached immediately (zero spinner). Projects are stored
      // under `.projects` by the sync layer but `.data` by some getters, so read
      // both shapes here the way Dashboard does.
      const applyRows = (
        eRow: Record<string, unknown> | null,
        pRow: Record<string, unknown> | null
      ) => {
        if (eRow?.data) {
          const next = (Array.isArray(eRow.data) ? eRow.data : []) as Entry[];
          // Never commit an empty list over a populated one — a concurrent read
          // can catch the row mid-invalidation and return [].
          setEntries((prev) => (next.length === 0 && prev.length > 0 ? prev : next));
        }
        const rawProjects = pRow?.data || pRow?.projects;
        if (rawProjects) {
          const next = (Array.isArray(rawProjects) ? rawProjects : []) as typeof projects;
          setProjects((prev) => (next.length === 0 && prev.length > 0 ? prev : next));
        }
      };

      applyRows(cachedEntries, cachedProjects);

      // A missing row (never synced, or just invalidated by a mutation/SSE event)
      // must be refilled from the server — independent of whether the other row
      // is present. Only fires when there is no optimistic row to clobber.
      const rowsMissing = !cachedEntries || !cachedProjects;
      if (rowsMissing) {
        if (!navigator.onLine) return;
        setLoading(true);
        // force: bypass the 10s throttle so an invalidated cache always refills.
        await syncAllData(email, { force: true });
        const [freshEntries, freshProjects] = await Promise.all([
          cacheGet(CACHE_STORES.ALL_ENTRIES, email),
          cacheGet(CACHE_STORES.PROJECTS, email),
        ]);
        if (seq !== loadSeq.current) return;
        applyRows(freshEntries, freshProjects);
      }
    } catch (err) {
      console.error('[AllEntries] loadData error:', err);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [email]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Shared reload ref for every subscription so a batched cache invalidation
  // (cacheDeleteMany) triggers exactly one reload, not one per store.
  const reload = useCallback(() => {
    void loadData();
  }, [loadData]);

  // Subscribe to cache changes — re-load when syncAllData writes new data
  useEffect(() => {
    if (!email) return;
    const unsubs = [
      cacheSubscribe(CACHE_STORES.ALL_ENTRIES, email, reload),
      cacheSubscribe(CACHE_STORES.PROJECTS, email, reload),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, [email, reload]);

  // Field counts and field types for the filter panel. Field definitions live
  // per project, so each project's rows are read from the cache and only
  // fetched when missing.
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
          } catch {
            nextCounts[name] = 0;
            nextTypes[name] = [];
          }
        })
      );
      if (!cancelled) {
        setFieldCounts(nextCounts);
        setFieldTypes(nextTypes);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email, projects, entries]);

  const handleSetPriority = async (entryId: string, projectName: string, priorityValue: string) => {
    if (!email) return;
    await setPriority(email, priorityValue, projectName, entryId);
    loadData();
  };

  // Names of effectively archived parent projects — server flag or the local
  // fallback (same shared helper as Dashboard/StatsView). Their entries leave
  // the active list; archived content stays explicit in the Archives view.
  const archivedProjectNames = useMemo(
    () => getEffectiveArchivedProjectNames(email, projects),
    [email, projects]
  );

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

  // Every field type used across the projects — the field-type filter options
  const fieldTypeOptions = useMemo(
    () =>
      Array.from(new Set(Object.values(fieldTypes).flat()))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    [fieldTypes]
  );

  const activeFilters = activeProjectFilterCount(projectFilters);

  // Filtered entries
  const filteredEntries = useMemo(() => {
    // Active views only — no archived, deleted, or archived-project entries.
    let filtered = (entries as Entry[]).filter((e) =>
      isActiveEntry(e, archivedProjectNames.has(String(e.project_name || '')))
    );

    // Apply search filter — summary, project name and every field value
    if (searchQuery.trim()) {
      filtered = filtered.filter((e) => matchesTextQuery(e, searchQuery));
    }

    // Apply project filters — project name, entry count, field count, field type
    filtered = applyProjectFilters(filtered, projectFilters, {
      entryCounts,
      fieldCounts,
      fieldTypes,
    });

    // Apply sort
    if (sortBy === 'priority') {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      filtered.sort((a, b) => {
        const pa = priorityOrder[(a.priority as 'high' | 'medium' | 'low') || 'medium'];
        const pb = priorityOrder[(b.priority as 'high' | 'medium' | 'low') || 'medium'];
        return pa - pb;
      });
    } else {
      filtered.sort((a, b) => {
        const da = new Date((a.due_date as string) || (a.created_at as string) || 0);
        const db = new Date((b.due_date as string) || (b.created_at as string) || 0);
        return db.getTime() - da.getTime();
      });
    }

    return pinFirst(filtered);
  }, [
    entries,
    archivedProjectNames,
    searchQuery,
    sortBy,
    projectFilters,
    entryCounts,
    fieldCounts,
    fieldTypes,
  ]);

  // Entries due within the next 3 days — the same window the home page uses;
  // it feeds the right-hand due-soon rail.
  const dueSoonEntries = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const threeDaysFromNow = new Date(startOfToday.getTime() + 3 * 24 * 60 * 60 * 1000);
    return entries.filter((e) => {
      if (e.archived) return false;
      if (!e.due_date) return false;
      const due = new Date(e.due_date as string);
      if (isNaN(due.getTime())) return false;
      return due >= startOfToday && due <= threeDaysFromNow;
    });
  }, [entries]);

  const colorMap = useMemo(
    () => buildProjectColorMap(projects as Array<Record<string, unknown>>),
    [projects]
  );

  // Kanban groups by status and Timeline is chronological — sorting does not
  // apply there, so the Sort control is hidden while those views are active.
  const showSortControl = displayMode !== 'kanban' && displayMode !== 'timeline';

  // "New Entry" card that fronts the cards feed — opens the project picker,
  // then the entry form for the chosen project.
  const newEntryCard = (
    <button
      type="button"
      className="entry-card-new"
      onClick={() => setNewEntryOpen(true)}
      title="Create a new entry"
    >
      <span className="entry-card-new__icon">+</span>
      <span className="entry-card-new__title">New Entry</span>
      <span className="entry-card-new__hint">Pick a project and add an entry</span>
    </button>
  );

  return (
    <div className="dash-layout">
      <div className="bg-mesh" />

      <NavBar entries={entries} activeView="all" />

      <main className="dash-main">
        <Header title="My Entries" entries={entries} projects={projects} />

        {/* Search bar beside the AI quick-add bar */}
        <div className="search-ai-row">
          <ProjectFilterBlock
            query={searchQuery}
            onQueryChange={setSearchQuery}
            placeholder="Search entries..."
            projectNames={projectNames}
            filters={projectFilters}
            onFiltersChange={setProjectFilters}
            fieldTypeOptions={fieldTypeOptions}
          />

          {/* Quick Entry Bar */}
          <div className="search-ai-row__ai">
            <QuickEntryBar
              onEntryCreated={(info) => {
                loadData();
                // Track every created entry (single OR multi) in "Recently created".
                for (const item of info?.created ?? []) {
                  trackCreatedEntry(item);
                }
                // Navigate only when there's exactly one unambiguous target.
                if ((info?.created?.length ?? 0) === 1 && info?.projectName) {
                  navigate(`/project/${encodeURIComponent(info.projectName)}`);
                }
              }}
              onVoiceOpen={() => setVoiceOpen(true)}
              placeholder={aiPlaceholder}
            />
          </div>
        </div>

        {/* Page switcher: Entries / Projects */}
        <div className="page-switcher-row">
          <div
            className="feed-view-toggle"
            role="group"
            aria-label="Switch between entries and projects"
          >
            <button
              type="button"
              className="feed-view-btn"
              onClick={() => navigate('/dashboard')}
              title="Back to projects"
            >
              Projects
            </button>
            <button
              type="button"
              className="feed-view-btn active"
              aria-current="page"
              onClick={() => navigate('/entries')}
              title="Browse all entries"
            >
              Entries
            </button>
          </div>

          {/* View + Sort sit together opposite the Entries/Projects toggle,
              mirroring the search/AI bar row's layout. */}
          <div className="page-switcher-controls">
            <div className="feed-view-group">
              <span className="feed-view-label">View:</span>
              <ToolbarDropdown
                value={displayMode}
                onChange={setDisplayMode}
                options={[
                  { value: 'cards', label: 'Cards' },
                  { value: 'checklist', label: 'Checklist' },
                  { value: 'board', label: 'Board' },
                  { value: 'table', label: 'Table' },
                  { value: 'kanban', label: 'Kanban' },
                  { value: 'timeline', label: 'Timeline' },
                ]}
              />
            </div>

            {showSortControl && (
              <div className="feed-sort-group">
                <span className="feed-sort-label">Sort:</span>
                <ToolbarDropdown
                  value={sortBy}
                  onChange={setSortBy}
                  menuAlign="right"
                  options={[
                    { value: 'date', label: 'Date' },
                    { value: 'priority', label: 'Priority' },
                  ]}
                />
              </div>
            )}
          </div>
        </div>

        {/* "New Entry" card — fronts the split so the due-soon rail starts
            below it, beside the entries. */}
        {newEntryCard}

        {/* Two-column split: entries on the left, the due-soon quick list on
            the right. */}
        <div className="dash-split">
          <div className="dash-split__main">
        {/* Loading */}
        {loading && (
          <div className="feed-loading">
            <div className="animate-spin spinner-circle" style={{ width: 24, height: 24 }} />
            <p>Loading entries...</p>
          </div>
        )}

        {/* Entries feed */}
        {!loading && filteredEntries.length === 0 && (
          <div className="entries-feed">
            <div className="empty-state animate-in">
              <div className="empty-icon">
                <svg
                  width="48"
                  height="48"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>
              <h2 className="empty-title">
                {searchQuery
                  ? 'No results found'
                  : activeFilters > 0
                    ? 'No entries match your filters'
                    : 'No entries yet'}
              </h2>
              <p className="empty-desc">
                {searchQuery
                  ? `No entries match "${searchQuery}". Try a different search term.`
                  : activeFilters > 0
                    ? 'Try widening or clearing the filters.'
                    : 'No entries to show right now.'}
              </p>
              {activeFilters > 0 && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setProjectFilters(defaultProjectFilters())}
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        )}
        {!loading && filteredEntries.length > 0 && displayMode === 'board' && (
          <div className="allentries-board-grid">
            <EntriesByDueDateBoard
              entries={filteredEntries.map((r) => ({
                id: r.id as string,
                user_email: r.user_email as string,
                project_name: r.project_name as string,
                summary: (r.summary as string) || null,
                due_date: (r.due_date as string) || null,
                status: (r.status as 'up_next' | 'in_motion' | 'done_and_dusted') || 'up_next',
                entries: r.entries as EntryPayload,
                started_at: (r.started_at as string) || null,
              }))}
              onUpdated={() => loadData()}
              onDelete={() => loadData()}
              colorMap={colorMap}
            />
          </div>
        )}
        {!loading && filteredEntries.length > 0 && displayMode === 'checklist' && (
          <div className="allentries-checklist-grid">
            <ChecklistView
              entries={filteredEntries.map((r) => ({
                id: r.id as string,
                user_email: r.user_email as string,
                project_name: r.project_name as string,
                summary: (r.summary as string) || null,
                due_date: (r.due_date as string) || null,
                status: (r.status as 'up_next' | 'in_motion' | 'done_and_dusted') || 'up_next',
                entries: r.entries as EntryPayload,
                started_at: (r.started_at as string) || null,
              }))}
              onUpdated={() => loadData()}
              onDelete={() => loadData()}
              colorMap={colorMap}
            />
          </div>
        )}
        {!loading && filteredEntries.length > 0 && displayMode === 'table' && (
          <ProjectTaskTable
            rows={filteredEntries}
            onUpdate={async () => {
              await loadData();
            }}
            onDeleteSelected={async () => {
              await loadData();
            }}
            colorMap={colorMap}
          />
        )}
        {!loading && filteredEntries.length > 0 && displayMode === 'kanban' && (
          <KanbanBoardView
            entries={filteredEntries as unknown as CalendarEntry[]}
            email={email}
            colorMap={colorMap}
            onUpdated={() => loadData()}
          />
        )}
        {!loading && filteredEntries.length > 0 && displayMode === 'timeline' && (
          <TimelineView entries={filteredEntries as unknown as CalendarEntry[]} />
        )}
        {!loading && filteredEntries.length > 0 && displayMode === 'cards' && (
          <div className="entries-feed">
            {filteredEntries.map((row, i) => (
              <EntryBox
                key={`entry-${row.id || i}`}
                entry={row as any}
                onUpdated={() => loadData()}
                onPriorityChanged={handleSetPriority}
                onDelete={() => loadData()}
                projectColor={resolveProjectColor(
                  (row.project_name as string) || '',
                  buildProjectColorMap(projects as Array<Record<string, unknown>>)
                )}
              />
            ))}
          </div>
        )}
              </div>

              <DueSoonRail entries={dueSoonEntries} />
            </div>
      </main>

      {/* New Entry Modal — pick a project, then fill in the entry form */}
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
                <h2 className="modal-title">New Entry</h2>
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

      {/* Voice Feature */}
      {voiceOpen && (
        <VoiceFeature
          onClose={() => setVoiceOpen(false)}
          onEntryCreated={(info) => {
            loadData();
            setVoiceOpen(false);
            // Mirror the QuickEntryBar behaviour: track every created entry.
            for (const item of info?.created ?? []) {
              trackCreatedEntry(item);
            }
          }}
        />
      )}
    </div>
  );
}
