"""workflow-cron plugin — agent-side half.

The engine itself lives entirely in dashboard/plugin_api.py (imported by the
gateway's plugin-backend mount, same pipeline as kanban). This top-level
__init__.py only needs to exist so the folder is recognized as a general
Hermes plugin by PluginManager; it registers no hooks/tools today.
"""

from __future__ import annotations
