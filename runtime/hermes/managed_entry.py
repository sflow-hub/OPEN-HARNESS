"""Require the managed extension before exposing the upstream TUI gateway."""
import runpy
import os
from pathlib import Path
import yaml
from hermes_cli.plugins import discover_plugins
import open_harness_policy

# Saved profiles use Open Harness's original MCP IDs. The pinned Hermes registry
# uses mcp__server__tool. Translate once at the managed boundary, preserving the
# coordinator's persisted grant IDs and using the same names for exposure/dispatch.
grant = open_harness_policy.load_grant()
if any(name.startswith('mcp_') and not name.startswith('mcp__') for name in grant):
    from tools.mcp_tool_schema import mcp_prefixed_tool_name
    config = yaml.safe_load((Path(os.environ['HERMES_HOME']) / 'config.yaml').read_text()) or {}
    servers = config.get('mcp_servers') or {}
    translated = set()
    for tool in grant:
        if not tool.startswith('mcp_') or tool.startswith('mcp__'):
            translated.add(tool)
            continue
        matches = [(server, tool[len(f'mcp_{server}_'):]) for server in servers if tool.startswith(f'mcp_{server}_')]
        if len(matches) != 1 or not matches[0][1]:
            raise SystemExit('Managed MCP grant does not identify one configured server. Re-save the agent connection settings.')
        translated.add(mcp_prefixed_tool_name(*matches[0]))
    open_harness_policy._GRANT = frozenset(translated)

discover_plugins()
if not open_harness_policy._REGISTERED:
    raise SystemExit('Open Harness policy extension failed to load. Rebuild the Hermes image.')
# Register a named, explicit toolset in the upstream registry. Keeping even an
# empty grant as a *named* toolset avoids Hermes's empty-selection => defaults.
import toolsets
name = 'open-harness-grant'
toolsets.TOOLSETS[name] = {'description': 'Managed Open Harness run grant', 'tools': sorted(open_harness_policy.load_grant()), 'includes': []}
os.environ['HERMES_TUI_TOOLSETS'] = name
runpy.run_module('tui_gateway.entry', run_name='__main__')
