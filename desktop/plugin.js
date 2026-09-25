/**
 * workflow-cron — desktop half.
 * Folder: ~/.hermes/plugins/workflow-cron/desktop/plugin.js
 * Backend: ~/.hermes/plugins/workflow-cron/dashboard/plugin_api.py (mounted at
 * /api/plugins/workflow-cron/*, reached here only via ctx.rest).
 *
 * Two tabs on one page:
 *  - "Crons" (default, primary): every cron job across every served profile
 *    in one list — status, schedule, next actions (pause/resume/fire now/
 *    delete) and recent runs. This is the central visual management the
 *    Cron sidebar panel doesn't give you (that one is scoped to one profile
 *    at a time).
 *  - "Workflows" (secondary): an ordered list of typed step cards (cron_step,
 *    http_request, condition, delay, notify) sequenced top-to-bottom into a
 *    cross-profile pipeline, backed by the plugin's own SQLite engine.
 */

import {
  Badge, Button, cn, EmptyState, host, Input, ROUTES_AREA, ScrollArea, Select,
  SelectContent, SelectItem, SelectTrigger, SelectValue, SIDEBAR_NAV_AREA,
  StatusDot, Textarea, useQuery, useQueryClient, usePluginI18n
} from '@hermes/plugin-sdk'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'
import { useMemo, useState } from 'react'

const ID = 'workflow-cron'
const PATH = '/workflow-cron'

let _restFn = null
const rest = (path, opts) => _restFn(path, opts)

// =====================================================================
// Shared bits
// =====================================================================

const STATUS_COLOR = {
  running: 'info',
  completed: 'success',
  failed: 'error',
  skipped_branch: 'warning',
  cancelled: 'neutral',
  pending: 'neutral'
}

function StepBadge({ status }) {
  return jsx(Badge, { variant: STATUS_COLOR[status] || 'neutral', children: status })
}

function PageTabs({ tab, onChange }) {
  const tabs = [
    { id: 'crons', label: 'Crons' },
    { id: 'workflows', label: 'Workflows' }
  ]
  return jsx('div', {
    className: 'flex items-center gap-1 border-b border-(--ui-stroke-secondary) px-3 pt-2',
    children: tabs.map(t => jsx('button', {
      type: 'button',
      onClick: () => onChange(t.id),
      className: cn(
        'rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium transition-colors',
        tab === t.id
          ? 'border-(--ui-stroke-secondary) bg-(--ui-bg-primary) text-(--ui-text-primary)'
          : 'border-transparent text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)'
      ),
      children: t.label
    }, t.id))
  })
}

// =====================================================================
// CRONS tab — primary cross-profile management surface.
// =====================================================================

function relTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const diffMs = d.getTime() - Date.now()
  const abs = Math.abs(diffMs)
  const mins = Math.round(abs / 60000)
  const label =
    mins < 1 ? 'now' :
    mins < 60 ? `${mins}m` :
    mins < 1440 ? `${Math.round(mins / 60)}h` :
    `${Math.round(mins / 1440)}d`
  return diffMs >= 0 ? `in ${label}` : `${label} ago`
}

const PROFILE_COLORS = ['#818cf8', '#34d399', '#fbbf24', '#f472b6', '#38bdf8', '#a78bfa', '#fb923c']
function profileColor(name) {
  let h = 0
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PROFILE_COLORS[h % PROFILE_COLORS.length]
}

function ProfileChip({ name }) {
  const color = profileColor(name)
  return jsx('span', {
    className: 'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium',
    style: { backgroundColor: `${color}22`, color },
    children: name || 'unknown'
  })
}

function CronRuns({ job }) {
  const { data, isLoading } = useQuery({
    queryKey: [ID, 'cron-runs', job.id, job.profile],
    queryFn: () => rest(`/cron/jobs/${job.id}/runs?profile=${encodeURIComponent(job.profile)}&limit=5`)
  })
  const runs = data?.runs || []
  if (isLoading) return jsx('div', { className: 'p-2 text-[0.6875rem] text-(--ui-text-tertiary)', children: 'loading runs…' })
  if (!runs.length) return jsx('div', { className: 'p-2 text-[0.6875rem] text-(--ui-text-tertiary)', children: 'No runs yet.' })
  return jsx('div', {
    className: 'flex flex-col gap-1 border-t border-(--ui-stroke-secondary) p-2',
    children: runs.map(r => jsxs('div', {
      className: 'flex items-center justify-between gap-2 text-[0.6875rem]',
      children: [
        jsx('span', { className: 'text-(--ui-text-tertiary)', children: new Date(r.started_at || r.created_at).toLocaleString() }),
        jsx(StepBadge, { status: r.status || 'completed' })
      ]
    }, r.id || r.started_at))
  })
}

function CronCard({ job, onChanged }) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const paused = job.enabled === false || job.status === 'paused'

  async function act(action) {
    setBusy(true)
    try {
      if (action === 'delete' && !window.confirm(`Delete cron "${job.name}"? This cannot be undone.`)) {
        setBusy(false)
        return
      }
      const method = action === 'delete' ? 'DELETE' : 'POST'
      const path = action === 'delete'
        ? `/cron/jobs/${job.id}?profile=${encodeURIComponent(job.profile)}`
        : `/cron/jobs/${job.id}/${action}?profile=${encodeURIComponent(job.profile)}`
      await rest(path, { method })
      host.notify({ kind: 'success', message: `Cron "${job.name}" — ${action} ok.` })
      onChanged()
    } catch (e) {
      host.notify({ kind: 'error', message: `Failed to ${action}: ${e?.message || e}` })
    } finally {
      setBusy(false)
    }
  }

  return jsxs('div', {
    className: 'flex flex-col rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) shadow-sm',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-3 p-3',
        children: [
          jsx(StatusDot, { status: paused ? 'neutral' : 'success' }),
          jsxs('div', {
            className: 'flex min-w-0 flex-1 flex-col gap-1',
            children: [
              jsxs('div', {
                className: 'flex items-center gap-2',
                children: [
                  jsx('span', { className: 'truncate text-sm font-medium', children: job.name || job.id }),
                  jsx(ProfileChip, { name: job.profile })
                ]
              }),
              jsxs('div', {
                className: 'flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-(--ui-text-tertiary)',
                children: [
                  jsx('span', { className: 'font-mono', children: job.schedule || job.cron_expr || '—' }),
                  job.next_run_at && jsx('span', { children: `next: ${relTime(job.next_run_at)}` }),
                  job.last_run_at && jsx('span', { children: `last: ${relTime(job.last_run_at)}` }),
                  paused && jsx(Badge, { variant: 'neutral', children: 'paused' })
                ]
              })
            ]
          }),
          jsxs('div', {
            className: 'flex items-center gap-1',
            children: [
              jsx(Button, {
                size: 'xs', variant: 'outline', disabled: busy,
                onClick: () => act('trigger'),
                children: '▶ Fire now'
              }),
              jsx(Button, {
                size: 'xs', variant: 'outline', disabled: busy,
                onClick: () => act(paused ? 'resume' : 'pause'),
                children: paused ? 'Resume' : 'Pause'
              }),
              jsx(Button, {
                size: 'xs', variant: 'ghost', disabled: busy,
                onClick: () => act('delete'),
                children: '✕'
              }),
              jsx(Button, {
                size: 'icon-sm', variant: 'ghost',
                onClick: () => setExpanded(v => !v),
                children: expanded ? '▲' : '▼'
              })
            ]
          })
        ]
      }),
      expanded && jsx(CronRuns, { job })
    ]
  })
}

function CronsPage() {
  const [filterProfile, setFilterProfile] = useState('all')
  const [search, setSearch] = useState('')
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: [ID, 'cron-jobs'],
    queryFn: () => rest('/cron/jobs'),
    refetchInterval: 30000
  })
  const jobs = data?.jobs || []

  const profiles = useMemo(() => {
    const set = new Set(jobs.map(j => j.profile).filter(Boolean))
    return Array.from(set).sort()
  }, [jobs])

  const filtered = jobs.filter(j => {
    if (filterProfile !== 'all' && j.profile !== filterProfile) return false
    if (search && !`${j.name} ${j.profile}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  return jsxs('div', {
    className: 'flex h-full flex-col',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) p-3',
        children: [
          jsxs('div', { className: 'text-sm font-medium', children: [
            'All cron jobs',
            jsx('span', { className: 'ml-2 text-(--ui-text-tertiary)', children: `(${jobs.length} across ${profiles.length} profile${profiles.length === 1 ? '' : 's'})` })
          ] }),
          jsx('div', { className: 'flex-1' }),
          jsx(Input, {
            placeholder: 'Search name or profile…', className: 'h-7 w-48',
            value: search, onChange: e => setSearch(e.target.value)
          }),
          jsx(Select, {
            value: filterProfile,
            onValueChange: setFilterProfile,
            children: jsxs(Fragment, {
              children: [
                jsx(SelectTrigger, { className: 'h-7 w-36', children: jsx(SelectValue, {}) }),
                jsx(SelectContent, {
                  children: [
                    jsx(SelectItem, { value: 'all', children: 'All profiles' }, 'all'),
                    ...profiles.map(p => jsx(SelectItem, { value: p, children: p }, p))
                  ]
                })
              ]
            })
          }),
          jsx(Button, { size: 'xs', variant: 'outline', disabled: isFetching, onClick: () => refetch(), children: isFetching ? '…' : '↻ Refresh' })
        ]
      }),
      jsx(ScrollArea, {
        className: 'flex-1',
        children: jsx('div', {
          className: 'flex flex-col gap-2 p-3',
          children: isLoading
            ? jsx('div', { className: 'p-4 text-xs text-(--ui-text-tertiary)', children: 'Loading cron jobs from every profile…' })
            : isError
              ? jsx('div', { className: 'p-4 text-xs text-(--ui-danger)', children: `Failed to load: ${error?.message || error}` })
              : !filtered.length
                ? jsx(EmptyState, { title: 'No cron jobs found', description: jobs.length ? 'No job matches this filter.' : 'No cron jobs exist in any served profile yet — create one from a chat with /cron.' })
                : filtered.map(j => jsx(CronCard, { key: j.id, job: j, onChanged: refetch }))
        })
      })
    ]
  })
}

// =====================================================================
// WORKFLOWS tab — secondary: sequence cron_step / http_request / condition /
// delay / notify nodes into a cross-profile pipeline.
// =====================================================================

const NODE_TYPES = [
  { value: 'cron_step', label: 'Cron step (fire + wait)' },
  { value: 'http_request', label: 'HTTP request' },
  { value: 'condition', label: 'Condition (gate)' },
  { value: 'delay', label: 'Delay' },
  { value: 'notify', label: 'Notify (log message)' }
]

function newNode(type) {
  const id = `${type}_${Math.random().toString(36).slice(2, 8)}`
  if (type === 'cron_step') return { id, type, profile: '', job_id: '', wait_for_completion: true, timeout_s: 600 }
  if (type === 'http_request') return { id, type, method: 'GET', url: '', timeout_s: 30 }
  if (type === 'condition') return { id, type, expr: 'last_output.status == 200' }
  if (type === 'delay') return { id, type, seconds: 30 }
  if (type === 'notify') return { id, type, message: '' }
  return { id, type }
}

function CronJobsField({ node, onChange }) {
  const { data, isLoading } = useQuery({
    queryKey: [ID, 'cron-jobs'],
    queryFn: () => rest('/cron/jobs'),
    staleTime: 15000
  })
  const jobs = data?.jobs || []
  const current = jobs.find(j => j.id === node.job_id)

  return jsxs('div', {
    className: 'flex flex-col gap-1.5',
    children: [
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: isLoading ? 'loading cron jobs…' : `${jobs.length} cron job(s) across all profiles` }),
      jsx(Select, {
        value: node.job_id || '',
        onValueChange: (jobId) => {
          const job = jobs.find(j => j.id === jobId)
          onChange({ ...node, job_id: jobId, profile: job?.profile || node.profile })
        },
        children: jsxs(Fragment, {
          children: [
            jsx(SelectTrigger, { children: jsx(SelectValue, { placeholder: 'Pick a cron job…', children: current ? `[${current.profile}] ${current.name}` : undefined }) }),
            jsx(SelectContent, {
              children: jobs.map(j => jsx(SelectItem, { value: j.id, children: `[${j.profile}] ${j.name}` }, j.id))
            })
          ]
        })
      })
    ]
  })
}

function StepCard({ node, index, total, onChange, onRemove, onMove }) {
  const set = (patch) => onChange({ ...node, ...patch })

  let fields = null
  if (node.type === 'cron_step') {
    fields = jsxs('div', {
      className: 'flex flex-col gap-2',
      children: [
        jsx(CronJobsField, { node, onChange }),
        jsxs('label', {
          className: 'flex items-center gap-2 text-[0.6875rem] text-(--ui-text-secondary)',
          children: [
            jsx('input', {
              type: 'checkbox', checked: !!node.wait_for_completion,
              onChange: e => set({ wait_for_completion: e.target.checked })
            }),
            'wait for completion before advancing'
          ]
        }),
        node.wait_for_completion && jsxs('div', {
          className: 'flex items-center gap-2',
          children: [
            jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: 'timeout (s)' }),
            jsx(Input, {
              type: 'number', value: node.timeout_s, className: 'h-7 w-24',
              onChange: e => set({ timeout_s: Number(e.target.value) })
            })
          ]
        })
      ]
    })
  } else if (node.type === 'http_request') {
    fields = jsxs('div', {
      className: 'flex flex-col gap-2',
      children: [
        jsxs('div', {
          className: 'flex gap-2',
          children: [
            jsx(Select, {
              value: node.method || 'GET',
              onValueChange: m => set({ method: m }),
              children: jsxs(Fragment, {
                children: [
                  jsx(SelectTrigger, { className: 'w-24', children: jsx(SelectValue, {}) }),
                  jsx(SelectContent, {
                    children: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map(m => jsx(SelectItem, { value: m, children: m }, m))
                  })
                ]
              })
            }),
            jsx(Input, {
              placeholder: 'https://…', value: node.url || '', className: 'h-7 flex-1',
              onChange: e => set({ url: e.target.value })
            })
          ]
        }),
        jsx(Textarea, {
          placeholder: 'JSON body (optional)', className: 'h-16 font-mono text-[0.6875rem]',
          value: node.json ? JSON.stringify(node.json, null, 2) : '',
          onChange: e => {
            try { set({ json: e.target.value ? JSON.parse(e.target.value) : undefined }) } catch { /* keep typing */ }
          }
        })
      ]
    })
  } else if (node.type === 'condition') {
    fields = jsxs('div', {
      className: 'flex flex-col gap-1',
      children: [
        jsx(Input, {
          placeholder: 'last_output.status == 200', value: node.expr || '',
          className: 'h-7 font-mono text-[0.6875rem]',
          onChange: e => set({ expr: e.target.value })
        }),
        jsx('div', {
          className: 'text-[0.625rem] text-(--ui-text-tertiary)',
          children: 'Gate: false stops the run as "skipped_branch". Supports ==, !=, >, <, >=, <=, contains, joined with "and".'
        })
      ]
    })
  } else if (node.type === 'delay') {
    fields = jsxs('div', {
      className: 'flex items-center gap-2',
      children: [
        jsx(Input, {
          type: 'number', value: node.seconds, className: 'h-7 w-28',
          onChange: e => set({ seconds: Number(e.target.value) })
        }),
        jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: 'seconds' })
      ]
    })
  } else if (node.type === 'notify') {
    fields = jsx(Input, {
      placeholder: 'Message to record in the run log', value: node.message || '',
      className: 'h-7', onChange: e => set({ message: e.target.value })
    })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2 rounded-md border border-(--ui-stroke-secondary) p-3',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx('span', { className: 'font-mono text-[0.6875rem] text-(--ui-text-tertiary)', children: `#${index + 1}` }),
              jsx(Badge, { variant: 'neutral', children: node.type })
            ]
          }),
          jsxs('div', {
            className: 'flex items-center gap-1',
            children: [
              jsx(Button, { size: 'icon-sm', variant: 'ghost', disabled: index === 0, onClick: () => onMove(-1), children: '↑' }),
              jsx(Button, { size: 'icon-sm', variant: 'ghost', disabled: index === total - 1, onClick: () => onMove(1), children: '↓' }),
              jsx(Button, { size: 'icon-sm', variant: 'ghost', onClick: onRemove, children: '✕' })
            ]
          })
        ]
      }),
      fields
    ]
  })
}

function RunsPanel({ workflowId }) {
  const { data, refetch } = useQuery({
    queryKey: [ID, 'runs', workflowId],
    queryFn: () => rest(`/workflows/${workflowId}/runs`),
    enabled: !!workflowId,
    refetchInterval: 4000
  })
  const runs = data?.runs || []

  if (!workflowId) return null
  if (!runs.length) return jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: 'No runs yet.' })

  return jsx('div', {
    className: 'flex flex-col gap-1.5',
    children: runs.map(r => jsxs('div', {
      className: 'flex items-center justify-between gap-2 rounded border border-(--ui-stroke-secondary) px-2 py-1.5 text-[0.6875rem]',
      children: [
        jsxs('div', {
          className: 'flex items-center gap-2',
          children: [
            jsx(StepBadge, { status: r.status }),
            jsx('span', { className: 'text-(--ui-text-tertiary)', children: new Date(r.started_at).toLocaleString() }),
            jsx('span', { className: 'text-(--ui-text-quaternary)', children: `step ${r.current_step_index}` })
          ]
        }),
        r.status === 'running' && jsx(Button, {
          size: 'xs', variant: 'ghost',
          onClick: async () => { await rest(`/runs/${r.id}/cancel`, { method: 'POST' }); refetch() },
          children: 'cancel'
        })
      ]
    }, r.id))
  })
}

function WorkflowsPage() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState(null)
  const [draftName, setDraftName] = useState('')
  const [draftSteps, setDraftSteps] = useState([])
  const [dirty, setDirty] = useState(false)

  const { data: wfData, isLoading } = useQuery({
    queryKey: [ID, 'workflows'],
    queryFn: () => rest('/workflows')
  })
  const workflows = wfData?.workflows || []

  function loadWorkflow(wf) {
    setSelectedId(wf.id)
    setDraftName(wf.name)
    setDraftSteps(wf.definition.steps || [])
    setDirty(false)
  }

  function startNew() {
    setSelectedId('__new__')
    setDraftName('New workflow')
    setDraftSteps([])
    setDirty(true)
  }

  async function save() {
    if (selectedId === '__new__') {
      const created = await rest('/workflows', { method: 'POST', body: { name: draftName, steps: draftSteps } })
      setSelectedId(created.id)
    } else {
      await rest(`/workflows/${selectedId}`, { method: 'PUT', body: { name: draftName, steps: draftSteps } })
    }
    setDirty(false)
    qc.invalidateQueries({ queryKey: [ID, 'workflows'] })
    host.notify({ kind: 'success', message: 'Workflow saved.' })
  }

  async function run() {
    if (!selectedId || selectedId === '__new__') return
    await rest(`/workflows/${selectedId}/run`, { method: 'POST' })
    qc.invalidateQueries({ queryKey: [ID, 'runs', selectedId] })
    host.notify({ kind: 'info', message: 'Workflow started.' })
  }

  async function del() {
    if (!selectedId || selectedId === '__new__') return
    if (!window.confirm('Delete this workflow?')) return
    await rest(`/workflows/${selectedId}`, { method: 'DELETE' })
    setSelectedId(null)
    qc.invalidateQueries({ queryKey: [ID, 'workflows'] })
  }

  function addNode(type) { setDraftSteps(s => [...s, newNode(type)]); setDirty(true) }
  function updateNode(i, node) { setDraftSteps(s => s.map((n, idx) => idx === i ? node : n)); setDirty(true) }
  function removeNode(i) { setDraftSteps(s => s.filter((_, idx) => idx !== i)); setDirty(true) }
  function moveNode(i, dir) {
    setDraftSteps(s => {
      const arr = [...s]
      const j = i + dir
      if (j < 0 || j >= arr.length) return arr
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
      return arr
    })
    setDirty(true)
  }

  return jsxs('div', {
    className: 'flex h-full',
    children: [
      jsxs('div', {
        className: 'flex w-64 shrink-0 flex-col border-r border-(--ui-stroke-secondary)',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between border-b border-(--ui-stroke-secondary) p-2',
            children: [
              jsx('span', { className: 'text-xs font-medium', children: 'Workflows' }),
              jsx(Button, { size: 'xs', onClick: startNew, children: '+ New' })
            ]
          }),
          jsx(ScrollArea, {
            className: 'flex-1',
            children: isLoading
              ? jsx('div', { className: 'p-3 text-[0.6875rem] text-(--ui-text-tertiary)', children: 'Loading…' })
              : !workflows.length
                ? jsx(EmptyState, { title: 'No workflows yet', description: 'Sequence cron jobs across profiles.' })
                : jsx('div', {
                    className: 'flex flex-col',
                    children: workflows.map(w => jsxs('button', {
                      type: 'button',
                      className: cn(
                        'flex items-center justify-between gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2 text-left text-xs',
                        'hover:bg-(--chrome-action-hover)',
                        w.id === selectedId && 'bg-(--chrome-action-hover)'
                      ),
                      onClick: () => loadWorkflow(w),
                      children: [
                        jsx('span', { className: 'truncate', children: w.name }),
                        jsx(StatusDot, { status: w.enabled ? 'success' : 'neutral' })
                      ]
                    }, w.id))
                  })
          })
        ]
      }),
      jsx('div', {
        className: 'flex-1 overflow-hidden',
        children: !selectedId
          ? jsx(EmptyState, { title: 'Select or create a workflow', description: 'Sequence cron_step, http_request, condition, delay and notify nodes into a cross-profile pipeline.' })
          : jsx(ScrollArea, {
              className: 'h-full',
              children: jsxs('div', {
                className: 'flex flex-col gap-4 p-4',
                children: [
                  jsxs('div', {
                    className: 'flex items-center gap-2',
                    children: [
                      jsx(Input, {
                        value: draftName, className: 'h-8 flex-1 font-medium',
                        onChange: e => { setDraftName(e.target.value); setDirty(true) }
                      }),
                      jsx(Button, { size: 'sm', variant: dirty ? 'default' : 'outline', onClick: save, children: dirty ? 'Save*' : 'Saved' }),
                      selectedId !== '__new__' && jsx(Button, { size: 'sm', variant: 'outline', onClick: run, children: '▶ Run' }),
                      selectedId !== '__new__' && jsx(Button, { size: 'sm', variant: 'ghost', onClick: del, children: 'Delete' })
                    ]
                  }),
                  jsxs('div', {
                    className: 'flex flex-col gap-2',
                    children: [
                      jsx('div', { className: 'text-xs font-medium text-(--ui-text-secondary)', children: 'Steps (top → bottom order of execution)' }),
                      draftSteps.map((node, i) => jsx(StepCard, {
                        node, index: i, total: draftSteps.length,
                        onChange: n => updateNode(i, n),
                        onRemove: () => removeNode(i),
                        onMove: dir => moveNode(i, dir)
                      }, node.id)),
                      jsx('div', {
                        className: 'flex flex-wrap gap-1.5',
                        children: NODE_TYPES.map(nt => jsx(Button, {
                          size: 'xs', variant: 'outline', onClick: () => addNode(nt.value),
                          children: `+ ${nt.label}`
                        }, nt.value))
                      })
                    ]
                  }),
                  selectedId !== '__new__' && jsxs('div', {
                    className: 'flex flex-col gap-2',
                    children: [
                      jsx('div', { className: 'text-xs font-medium text-(--ui-text-secondary)', children: 'Runs' }),
                      jsx(RunsPanel, { workflowId: selectedId })
                    ]
                  })
                ]
              })
            })
      })
    ]
  })
}

// =====================================================================
// Root page: tab switcher, Crons default.
// =====================================================================

function RootPage() {
  usePluginI18n(ID)
  const [tab, setTab] = useState('crons')
  return jsxs('div', {
    className: 'flex h-full flex-col',
    children: [
      jsx(PageTabs, { tab, onChange: setTab }),
      jsx('div', {
        className: 'flex-1 overflow-hidden',
        children: tab === 'crons' ? jsx(CronsPage, {}) : jsx(WorkflowsPage, {})
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Crons & Workflows',
  register(ctx) {
    _restFn = (path, opts) => ctx.rest(path, opts)

    ctx.i18n.register({
      en: { navLabel: 'Crons' }
    })

    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: PATH }, render: () => jsx(RootPage, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: PATH, label: 'Crons', codicon: 'clock' } }
    ])

    ctx.socket('/events', () => {
      // Backend has no push events yet (v1 relies on refetchInterval); this
      // is a no-op subscription so a future SSE/WS stream "just works".
    })
  }
}
