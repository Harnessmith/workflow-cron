"""workflow-cron — cross-profile workflow engine over Hermes cron jobs.

Runs INSIDE the gateway process (same pipeline as the kanban dashboard plugin),
so it can import hermes_cli internals directly (no HTTP hop needed) to fire and
inspect cron jobs across every served profile.

Storage: one SQLite DB at ``<default hermes home>/plugins/workflow-cron/workflows.db``
(shared across profiles on purpose — workflows sequence steps that may each
target a different profile's cron store).

Node types (v1):
  - cron_step:     {profile, job_id, wait_for_completion=True, timeout_s=600}
                    Fires an existing cron job (force run) and, optionally,
                    waits for its next completed run to show up in that job's
                    history before advancing.
  - delay:         {seconds}
                    Waits N seconds before advancing.
  - http_request:  {method, url, headers?, json?, timeout_s=30}
                    Fires an HTTP request; response status/body become the
                    step's output (available to later condition steps as
                    ``last_output``).
  - condition:     {expr}
                    A tiny boolean expression evaluated against
                    ``{"last_output": ..., "context": {...}}``. True -> advance
                    normally; False -> the run is marked ``skipped_branch`` and
                    stops (v1 has no branch-merge; a condition is a gate).
  - notify:        {deliver, message}
                    Delivers a message via an existing cron job's delivery
                    machinery is out of scope for v1 — notify just records the
                    message in the run's log (dashboard-visible) so the desktop
                    UI can render a completed "notify" node without needing a
                    live channel yet.

The engine is a single background thread ticking every ``TICK_SECONDS``,
advancing every ``running`` workflow run by at most one step-transition per
tick (keeps a single tick bounded and avoids thundering-herd on the cron
history DB).
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import threading
import time
import uuid
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger("workflow_cron")

router = APIRouter()

TICK_SECONDS = 15
_DEFAULT_CRON_STEP_TIMEOUT = 600


def _db_path() -> Path:
    from hermes_constants import get_default_hermes_root

    root = get_default_hermes_root() / "plugins" / "workflow-cron"
    root.mkdir(parents=True, exist_ok=True)
    return root / "workflows.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


_SCHEMA = """
CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    status TEXT NOT NULL,               -- running | completed | failed | skipped_branch | cancelled
    current_step_index INTEGER NOT NULL DEFAULT 0,
    step_state_json TEXT NOT NULL DEFAULT '{}',   -- transient state for the in-flight step
    context_json TEXT NOT NULL DEFAULT '{}',      -- accumulated outputs, incl. last_output
    error TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_index INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    status TEXT NOT NULL,               -- pending | running | completed | failed | skipped
    output_json TEXT,
    error TEXT,
    started_at TEXT,
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_run_steps_run ON workflow_run_steps(run_id);
"""


def _ensure_schema() -> None:
    with closing(_connect()) as conn:
        conn.executescript(_SCHEMA)
        conn.commit()


# --------------------------------------------------------------------------
# Cron bridge — in-process calls into hermes_cli's dashboard cron helpers.
# No HTTP hop: this module is imported inside the same gateway process.
# --------------------------------------------------------------------------

def _cron_get_job(profile: str, job_id: str) -> Optional[dict]:
    from hermes_cli.web_server_cron import _call_cron_for_profile

    try:
        return _call_cron_for_profile(profile, "get_job", job_id)
    except Exception:
        log.exception("workflow-cron: get_job failed (profile=%s job=%s)", profile, job_id)
        return None


def _cron_list_runs(profile: str, job_id: str, limit: int = 5) -> list[dict]:
    """Recent run/session records for a job, newest first. Best-effort: returns
    [] on any failure rather than raising, since this is only used for
    completion polling."""
    try:
        from hermes_cli.web_routers.cron import _list_cron_job_runs_sync

        result = _list_cron_job_runs_sync(job_id, profile=profile, limit=limit)
        if isinstance(result, dict):
            return result.get("runs") or result.get("items") or []
        if isinstance(result, list):
            return result
        return []
    except Exception:
        log.exception("workflow-cron: list_job_runs failed (profile=%s job=%s)", profile, job_id)
        return []


def _cron_fire(profile: str, job_id: str) -> bool:
    from hermes_cli.web_server_cron import _fire_cron_job_for_profile

    try:
        return bool(_fire_cron_job_for_profile(profile, job_id, force=True))
    except Exception:
        log.exception("workflow-cron: fire failed (profile=%s job=%s)", profile, job_id)
        return False


# --------------------------------------------------------------------------
# Condition expression — deliberately tiny, no eval() of arbitrary code.
# Supports: last_output.<path> <op> <literal>, combined with and/or.
# --------------------------------------------------------------------------

_COND_RE = re.compile(
    r"^\s*([\w.\[\]]+)\s*(==|!=|>=|<=|>|<|contains)\s*(.+?)\s*$"
)


def _resolve_path(data: Any, path: str) -> Any:
    cur = data
    for part in path.split("."):
        m = re.match(r"^(\w+)(\[(\d+)\])?$", part)
        if not m:
            return None
        key, _, idx = m.groups()
        if isinstance(cur, dict):
            cur = cur.get(key)
        else:
            return None
        if idx is not None:
            try:
                cur = cur[int(idx)]
            except Exception:
                return None
    return cur


def _parse_literal(text: str) -> Any:
    text = text.strip()
    if text.lower() in ("true", "false"):
        return text.lower() == "true"
    if re.match(r"^-?\d+(\.\d+)?$", text):
        return float(text) if "." in text else int(text)
    return text.strip("'\"")


def evaluate_condition(expr: str, data: dict) -> bool:
    clauses = re.split(r"\s+and\s+", expr, flags=re.IGNORECASE)
    for clause in clauses:
        m = _COND_RE.match(clause)
        if not m:
            raise ValueError(f"unparseable condition clause: {clause!r}")
        path, op, literal_raw = m.groups()
        left = _resolve_path(data, path)
        right = _parse_literal(literal_raw)
        if op == "==":
            ok = left == right
        elif op == "!=":
            ok = left != right
        elif op == ">":
            ok = (left or 0) > right
        elif op == "<":
            ok = (left or 0) < right
        elif op == ">=":
            ok = (left or 0) >= right
        elif op == "<=":
            ok = (left or 0) <= right
        elif op == "contains":
            ok = right in (left or "")
        else:
            ok = False
        if not ok:
            return False
    return True


# --------------------------------------------------------------------------
# Engine
# --------------------------------------------------------------------------

class Engine:
    def __init__(self) -> None:
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        _ensure_schema()
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="workflow-cron-engine", daemon=True)
        self._thread.start()
        log.info("workflow-cron: engine started (tick=%ss)", TICK_SECONDS)

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception:
                log.exception("workflow-cron: tick failed")
            self._stop.wait(TICK_SECONDS)

    def _tick(self) -> None:
        with closing(_connect()) as conn:
            runs = conn.execute(
                "SELECT * FROM workflow_runs WHERE status = 'running'"
            ).fetchall()
        for run in runs:
            try:
                self._advance_run(dict(run))
            except Exception:
                log.exception("workflow-cron: advancing run %s failed", run["id"])

    def _advance_run(self, run: dict) -> None:
        run_id = run["id"]
        with closing(_connect()) as conn:
            wf = conn.execute(
                "SELECT * FROM workflows WHERE id = ?", (run["workflow_id"],)
            ).fetchone()
        if not wf:
            self._fail_run(run_id, "workflow deleted")
            return

        definition = json.loads(wf["definition_json"])
        steps = definition.get("steps", [])
        idx = run["current_step_index"]

        if idx >= len(steps):
            self._complete_run(run_id)
            return

        node = steps[idx]
        context = json.loads(run["context_json"] or "{}")
        step_state = json.loads(run["step_state_json"] or "{}")

        row = self._current_step_row(run_id, idx)
        if row is None:
            row = self._start_step(run_id, idx, node)

        if row["status"] == "running":
            done, ok, output, error = self._poll_step(node, step_state, context)
            if not done:
                return  # still in flight; check again next tick
            self._finish_step(row["id"], ok, output, error)
            if not ok:
                self._fail_run(run_id, error or "step failed")
                return
            context["last_output"] = output
            context[node.get("id", f"step_{idx}")] = output
            if node.get("type") == "condition" and output.get("passed") is False:
                self._mark_run(run_id, "skipped_branch", context=context)
                return
            self._mark_run(run_id, "running", context=context, next_index=idx + 1, step_state={})

    def _current_step_row(self, run_id: str, idx: int) -> Optional[dict]:
        with closing(_connect()) as conn:
            row = conn.execute(
                "SELECT * FROM workflow_run_steps WHERE run_id = ? AND step_index = ?",
                (run_id, idx),
            ).fetchone()
        return dict(row) if row else None

    def _start_step(self, run_id: str, idx: int, node: dict) -> dict:
        step_id = str(uuid.uuid4())
        node_type = node.get("type", "unknown")
        node_id = node.get("id", f"step_{idx}")
        started_at = _now()
        with closing(_connect()) as conn:
            conn.execute(
                "INSERT INTO workflow_run_steps "
                "(id, run_id, step_index, node_id, node_type, status, started_at) "
                "VALUES (?, ?, ?, ?, ?, 'running', ?)",
                (step_id, run_id, idx, node_id, node_type, started_at),
            )
            conn.commit()

        # Kick the step's SIDE EFFECT once at start (e.g. fire the cron job,
        # send the http request); _poll_step below only checks for completion.
        state: dict[str, Any] = {"started_at": time.time()}
        if node_type == "cron_step":
            profile = node.get("profile", "default")
            job_id = node["job_id"]
            baseline = _cron_list_runs(profile, job_id, limit=1)
            state["baseline_run_ts"] = (baseline[0].get("started_at") if baseline else None)
            fired = _cron_fire(profile, job_id)
            state["fired"] = fired
            if not fired:
                self._finish_step(step_id, False, None, "cron fire failed")
        elif node_type == "http_request":
            state["dispatched"] = False  # dispatched lazily in poll (keeps side effect single-shot below)
        with closing(_connect()) as conn:
            conn.execute(
                "UPDATE workflow_runs SET step_state_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(state), _now(), run_id),
            )
            conn.commit()
        return self._current_step_row(run_id, idx)

    def _poll_step(self, node: dict, state: dict, context: dict) -> tuple[bool, bool, Any, Optional[str]]:
        node_type = node.get("type")
        started_at = state.get("started_at", time.time())

        if node_type == "delay":
            elapsed = time.time() - started_at
            seconds = float(node.get("seconds", 0))
            if elapsed >= seconds:
                return True, True, {"waited_s": elapsed}, None
            return False, True, None, None

        if node_type == "cron_step":
            if state.get("fired") is False:
                return True, False, None, "cron fire failed"
            profile = node.get("profile", "default")
            job_id = node["job_id"]
            if not node.get("wait_for_completion", True):
                return True, True, {"fired": True}, None
            timeout_s = float(node.get("timeout_s", _DEFAULT_CRON_STEP_TIMEOUT))
            runs = _cron_list_runs(profile, job_id, limit=3)
            baseline = state.get("baseline_run_ts")
            newest = runs[0] if runs else None
            if newest and newest.get("started_at") != baseline:
                status = (newest.get("status") or "").lower()
                if status in ("completed", "success", "ok", "finished"):
                    return True, True, newest, None
                if status in ("failed", "error"):
                    return True, False, newest, f"cron job run failed: {status}"
                # still running under a new run record: keep polling
            if time.time() - started_at > timeout_s:
                return True, False, None, f"cron_step timed out after {timeout_s}s"
            return False, True, None, None

        if node_type == "http_request":
            if not state.get("dispatched"):
                # Single-shot dispatch on first poll after start (kept out of
                # _start_step so a slow request doesn't block step insertion).
                try:
                    import httpx

                    method = node.get("method", "GET").upper()
                    resp = httpx.request(
                        method,
                        node["url"],
                        headers=node.get("headers") or {},
                        json=node.get("json"),
                        timeout=float(node.get("timeout_s", 30)),
                    )
                    body: Any
                    try:
                        body = resp.json()
                    except Exception:
                        body = resp.text
                    return True, resp.status_code < 400, {"status": resp.status_code, "body": body}, (
                        None if resp.status_code < 400 else f"HTTP {resp.status_code}"
                    )
                except Exception as exc:
                    return True, False, None, str(exc)
            return True, True, {}, None

        if node_type == "condition":
            try:
                passed = evaluate_condition(node["expr"], context)
                return True, True, {"passed": passed}, None
            except Exception as exc:
                return True, False, None, f"condition error: {exc}"

        if node_type == "notify":
            return True, True, {"message": node.get("message", "")}, None

        return True, False, None, f"unknown node type: {node_type}"

    def _finish_step(self, step_id: str, ok: bool, output: Any, error: Optional[str]) -> None:
        with closing(_connect()) as conn:
            conn.execute(
                "UPDATE workflow_run_steps SET status = ?, output_json = ?, error = ?, finished_at = ? "
                "WHERE id = ?",
                (
                    "completed" if ok else "failed",
                    json.dumps(output) if output is not None else None,
                    error,
                    _now(),
                    step_id,
                ),
            )
            conn.commit()

    def _mark_run(
        self,
        run_id: str,
        status: str,
        *,
        context: Optional[dict] = None,
        next_index: Optional[int] = None,
        step_state: Optional[dict] = None,
    ) -> None:
        fields = ["status = ?", "updated_at = ?"]
        values: list[Any] = [status, _now()]
        if context is not None:
            fields.append("context_json = ?")
            values.append(json.dumps(context))
        if next_index is not None:
            fields.append("current_step_index = ?")
            values.append(next_index)
        if step_state is not None:
            fields.append("step_state_json = ?")
            values.append(json.dumps(step_state))
        if status in ("completed", "failed", "skipped_branch", "cancelled"):
            fields.append("finished_at = ?")
            values.append(_now())
        values.append(run_id)
        with closing(_connect()) as conn:
            conn.execute(f"UPDATE workflow_runs SET {', '.join(fields)} WHERE id = ?", values)
            conn.commit()

    def _complete_run(self, run_id: str) -> None:
        self._mark_run(run_id, "completed")

    def _fail_run(self, run_id: str, error: str) -> None:
        with closing(_connect()) as conn:
            conn.execute(
                "UPDATE workflow_runs SET status = 'failed', error = ?, updated_at = ?, finished_at = ? "
                "WHERE id = ?",
                (error, _now(), _now(), run_id),
            )
            conn.commit()


_engine = Engine()


def _start_engine_once() -> None:
    _engine.start()


_start_engine_once()


# --------------------------------------------------------------------------
# REST API — mounted at /api/plugins/workflow-cron/*
# --------------------------------------------------------------------------

class WorkflowCreate(BaseModel):
    name: str
    steps: list[dict] = Field(default_factory=list)
    enabled: bool = True


class WorkflowUpdate(BaseModel):
    name: Optional[str] = None
    steps: Optional[list[dict]] = None
    enabled: Optional[bool] = None


def _workflow_row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["definition"] = json.loads(d.pop("definition_json"))
    d["enabled"] = bool(d["enabled"])
    return d


def _run_row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["context"] = json.loads(d.pop("context_json") or "{}")
    d.pop("step_state_json", None)
    return d


@router.get("/health")
async def health():
    return {"ok": True, "engine_alive": bool(_engine._thread and _engine._thread.is_alive())}


@router.get("/cron/jobs")
async def list_all_cron_jobs():
    """Aggregate cron jobs across every served profile — feeds both the
    primary Crons dashboard and the workflow canvas's node picker."""
    from hermes_cli.web_routers.cron import _list_cron_jobs_sync

    jobs = _list_cron_jobs_sync("all")
    return {"jobs": jobs}


@router.post("/cron/jobs/{job_id}/pause")
async def pause_cron_job(job_id: str, profile: Optional[str] = None):
    from hermes_cli.web_routers.cron import _pause_cron_job_sync

    return _pause_cron_job_sync(job_id, profile)


@router.post("/cron/jobs/{job_id}/resume")
async def resume_cron_job(job_id: str, profile: Optional[str] = None):
    from hermes_cli.web_routers.cron import _resume_cron_job_sync

    return _resume_cron_job_sync(job_id, profile)


@router.post("/cron/jobs/{job_id}/trigger")
async def trigger_cron_job(job_id: str, profile: Optional[str] = None):
    from hermes_cli.web_routers.cron import _trigger_cron_job_sync

    return _trigger_cron_job_sync(job_id, profile)


@router.delete("/cron/jobs/{job_id}")
async def delete_cron_job(job_id: str, profile: Optional[str] = None):
    from hermes_cli.web_routers.cron import _delete_cron_job_sync

    return _delete_cron_job_sync(job_id, profile)


@router.get("/cron/jobs/{job_id}/runs")
async def list_cron_job_runs(job_id: str, profile: Optional[str] = None, limit: int = 20):
    from hermes_cli.web_routers.cron import _list_cron_job_runs_sync

    return _list_cron_job_runs_sync(job_id, profile, limit)


@router.get("/profiles")
async def list_profiles():
    """Names of every served profile, for the create-cron-job form's profile picker."""
    from hermes_cli.web_server_cron import _cron_profile_dicts

    names = sorted({str(item.get("name") or "") for item in _cron_profile_dicts()} - {""})
    return {"profiles": names}


class CronJobCreateProxy(BaseModel):
    profile: str
    name: str = ""
    prompt: str = ""
    schedule: str
    deliver: str = "local"


@router.post("/cron/jobs")
async def create_cron_job(body: CronJobCreateProxy):
    from hermes_cli.web_models import CronJobCreate
    from hermes_cli.web_server_cron import _create_cron_job_sync

    inner = CronJobCreate(prompt=body.prompt, schedule=body.schedule, name=body.name, deliver=body.deliver)
    return _create_cron_job_sync(inner, body.profile)


@router.get("/workflows")
async def list_workflows():
    _ensure_schema()
    with closing(_connect()) as conn:
        rows = conn.execute("SELECT * FROM workflows ORDER BY updated_at DESC").fetchall()
    return {"workflows": [_workflow_row_to_dict(r) for r in rows]}


@router.post("/workflows")
async def create_workflow(body: WorkflowCreate):
    _ensure_schema()
    wf_id = str(uuid.uuid4())
    now = _now()
    with closing(_connect()) as conn:
        conn.execute(
            "INSERT INTO workflows (id, name, definition_json, enabled, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (wf_id, body.name, json.dumps({"steps": body.steps}), int(body.enabled), now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM workflows WHERE id = ?", (wf_id,)).fetchone()
    return _workflow_row_to_dict(row)


@router.put("/workflows/{workflow_id}")
async def update_workflow(workflow_id: str, body: WorkflowUpdate):
    with closing(_connect()) as conn:
        row = conn.execute("SELECT * FROM workflows WHERE id = ?", (workflow_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="workflow not found")
        current = _workflow_row_to_dict(row)
        name = body.name if body.name is not None else current["name"]
        steps = body.steps if body.steps is not None else current["definition"]["steps"]
        enabled = body.enabled if body.enabled is not None else current["enabled"]
        conn.execute(
            "UPDATE workflows SET name = ?, definition_json = ?, enabled = ?, updated_at = ? WHERE id = ?",
            (name, json.dumps({"steps": steps}), int(enabled), _now(), workflow_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM workflows WHERE id = ?", (workflow_id,)).fetchone()
    return _workflow_row_to_dict(row)


@router.delete("/workflows/{workflow_id}")
async def delete_workflow(workflow_id: str):
    with closing(_connect()) as conn:
        cur = conn.execute("DELETE FROM workflows WHERE id = ?", (workflow_id,))
        conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="workflow not found")
    return {"ok": True}


@router.post("/workflows/{workflow_id}/run")
async def run_workflow(workflow_id: str):
    with closing(_connect()) as conn:
        wf = conn.execute("SELECT * FROM workflows WHERE id = ?", (workflow_id,)).fetchone()
        if not wf:
            raise HTTPException(status_code=404, detail="workflow not found")
        run_id = str(uuid.uuid4())
        now = _now()
        conn.execute(
            "INSERT INTO workflow_runs "
            "(id, workflow_id, status, current_step_index, step_state_json, context_json, started_at, updated_at) "
            "VALUES (?, ?, 'running', 0, '{}', '{}', ?, ?)",
            (run_id, workflow_id, now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM workflow_runs WHERE id = ?", (run_id,)).fetchone()
    _engine.start()  # idempotent; ensures the loop is alive
    return _run_row_to_dict(row)


@router.get("/workflows/{workflow_id}/runs")
async def list_runs(workflow_id: str, limit: int = 20):
    with closing(_connect()) as conn:
        rows = conn.execute(
            "SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?",
            (workflow_id, limit),
        ).fetchall()
    return {"runs": [_run_row_to_dict(r) for r in rows]}


@router.get("/runs/{run_id}")
async def get_run(run_id: str):
    with closing(_connect()) as conn:
        row = conn.execute("SELECT * FROM workflow_runs WHERE id = ?", (run_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="run not found")
        steps = conn.execute(
            "SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY step_index ASC", (run_id,)
        ).fetchall()
    out = _run_row_to_dict(row)
    out["steps"] = [
        {**dict(s), "output": json.loads(s["output_json"]) if s["output_json"] else None}
        for s in steps
    ]
    for s in out["steps"]:
        s.pop("output_json", None)
    return out


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str):
    with closing(_connect()) as conn:
        cur = conn.execute(
            "UPDATE workflow_runs SET status = 'cancelled', finished_at = ?, updated_at = ? "
            "WHERE id = ? AND status = 'running'",
            (_now(), _now(), run_id),
        )
        conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="run not found or not running")
    return {"ok": True}
