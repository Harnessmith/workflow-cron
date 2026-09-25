/**
 * workflow-cron — desktop half.
 * Folder: ~/.hermes/plugins/workflow-cron/desktop/plugin.js
 * Backend: ~/.hermes/plugins/workflow-cron/dashboard/plugin_api.py (mounted at
 * /api/plugins/workflow-cron/*, reached here only via ctx.rest — namespaced,
 * traversal-safe by construction).
 *
 * A full-page workflow canvas (n8n-style: an ordered list of typed step
 * "cards" you wire top-to-bottom — no free-form drag/drop wiring in v1, just
 * reorder + add/remove) plus a sidebar nav entry and a run-history view.
 * Cron jobs across every profile are aggregated by GET /cron/jobs (the
 * backend calls hermes_cli's own dashboard-cron listing in-process) so
 * "cron_step" nodes can be picked from a real cross-profile list.
 */

import {
  Badge, Button, cn, EmptyState, host, Input, ROUTES_AREA, ScrollArea, Select,
  SelectContent, SelectItem, SelectTrigger, SelectValue, SIDEBAR_NAV_AREA,
  StatusDot, Textarea, useQuery, useMutation, useQueryClient, usePluginI18n
} from '@hermes/plugin-sdk'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'
import { useState } from 'react'

const ID = 'workflow-cron'
const PATH = '/workflow-cron'

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

// ---------------------------------------------------------------------
// Cron job picker — feeds cron_step.profile / job_id from the real
// cross-profile aggregation, so users never hand-type a job id.
// ctx.rest is only available inside register(); components reach it through
// a small closure captured at registration time (see CronJobsField below).
let _restFn = null

function CronJobsField({ node, onChange }) {
  const { data, isLoading } = useQuery({
    queryKey: [ID, 'cron-jobs'],
    queryFn: () => _restFn('/cron/jobs'),
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

// ---------------------------------------------------------------------
// One step card: type-specific fields + reorder/remove controls.
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Run history + live status for the selected workflow.
// ---------------------------------------------------------------------
function RunsPanel({ workflowId }) {
  const { data, refetch } = useQuery({
    queryKey: [ID, 'runs', workflowId],
    queryFn: () => _restFn(`/workflows/${workflowId}/runs`),
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
          onClick: async () => { await _restFn(`/runs/${r.id}/cancel`, { method: 'POST' }); refetch() },
          children: 'cancel'
        })
      ]
    }, r.id))
  })
}

// ---------------------------------------------------------------------
// Main page: workflow list (left) + editor/runs (right).
// ---------------------------------------------------------------------
function WorkflowPage() {
  const t = usePluginI18n(ID)
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState(null)
  const [draftName, setDraftName] = useState('')
  const [draftSteps, setDraftSteps] = useState([])
  const [dirty, setDirty] = useState(false)

  const { data: wfData, isLoading } = useQuery({
    queryKey: [ID, 'workflows'],
    queryFn: () => _restFn('/workflows')
  })
  const workflows = wfData?.workflows || []
  const selected = workflows.find(w => w.id === selectedId)

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
      const created = await _restFn('/workflows', { method: 'POST', body: { name: draftName, steps: draftSteps } })
      setSelectedId(created.id)
    } else {
      await _restFn(`/workflows/${selectedId}`, { method: 'PUT', body: { name: draftName, steps: draftSteps } })
    }
    setDirty(false)
    qc.invalidateQueries({ queryKey: [ID, 'workflows'] })
    host.notify({ kind: 'success', message: 'Workflow saved.' })
  }

  async function run() {
    if (!selectedId || selectedId === '__new__') return
    await _restFn(`/workflows/${selectedId}/run`, { method: 'POST' })
    qc.invalidateQueries({ queryKey: [ID, 'runs', selectedId] })
    host.notify({ kind: 'info', message: 'Workflow started.' })
  }

  async function del() {
    if (!selectedId || selectedId === '__new__') return
    await _restFn(`/workflows/${selectedId}`, { method: 'DELETE' })
    setSelectedId(null)
    qc.invalidateQueries({ queryKey: [ID, 'workflows'] })
  }

  function addNode(type) {
    setDraftSteps(s => [...s, newNode(type)])
    setDirty(true)
  }
  function updateNode(i, node) {
    setDraftSteps(s => s.map((n, idx) => idx === i ? node : n))
    setDirty(true)
  }
  function removeNode(i) {
    setDraftSteps(s => s.filter((_, idx) => idx !== i))
    setDirty(true)
  }
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
      // Left: workflow list
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
                ? jsx(EmptyState, { title: 'No workflows yet', description: 'Create one to sequence cron jobs across profiles.' })
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
      // Right: editor + runs
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

export default {
  id: ID,
  name: 'Workflow Cron',
  register(ctx) {
    _restFn = (path, opts) => ctx.rest(path, opts)

    ctx.i18n.register({
      en: { navLabel: 'Workflows' }
    })

    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: PATH }, render: () => jsx(WorkflowPage, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: PATH, label: 'Workflows', codicon: 'combine' } }
    ])

    ctx.socket('/events', () => {
      // Backend has no push events yet (v1 relies on refetchInterval); this
      // is a no-op subscription so a future SSE/WS stream on the Python side
      // "just works" without another desktop change.
    })
  }
}
