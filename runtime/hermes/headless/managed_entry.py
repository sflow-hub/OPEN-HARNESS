"""Require the managed extension before exposing the upstream TUI gateway."""
import runpy
import os
from hermes_cli.plugins import discover_plugins
import open_harness_policy

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
