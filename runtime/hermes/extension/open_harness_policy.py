"""Managed Hermes middleware. Run grants are immutable for a gateway's lifetime.

Tool switches restrict Hermes dispatch, not arbitrary programs run by Terminal.
This module deliberately returns errors rather than raising inside middleware:
Hermes skips middleware exceptions, which would otherwise fail open.
"""
import json
from pathlib import Path

_GRANT = None
_REGISTERED = False

def load_grant():
    global _GRANT
    if _GRANT is None:
        try:
            grant = json.loads(Path('/run/open-harness/policy.json').read_text())
            names = grant['allowedTools']
            if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
                raise ValueError('Invalid tool grant')
            _GRANT = frozenset(names)
        except Exception:
            _GRANT = frozenset()
    return _GRANT

def permitted(name):
    return isinstance(name, str) and name in load_grant()

def tool_execution(tool_name=None, args=None, next_call=None, **kwargs):
    if not permitted(tool_name):
        return json.dumps({'error': 'Tool access is disabled in this agent profile.', 'tool': tool_name, 'code': 'tool_disabled'})
    return next_call(args)

def filter_request(request):
    result = dict(request)
    # Hermes supports both chat-completions and native Anthropic schemas.
    tools = result.get('tools')
    if isinstance(tools, list):
        result['tools'] = [tool for tool in tools if isinstance(tool, dict) and permitted(tool.get('function', {}).get('name') if isinstance(tool.get('function'), dict) else tool.get('name'))]
        choice = result.get('tool_choice')
        if isinstance(choice, dict):
            name = choice.get('function', {}).get('name') if isinstance(choice.get('function'), dict) else choice.get('name')
            if name and not permitted(name):
                result.pop('tool_choice', None)
        if not result['tools']:
            result.pop('tools', None)
            result.pop('tool_choice', None)
            result.pop('parallel_tool_calls', None)
    return result

def llm_execution(request=None, next_call=None, **kwargs):
    # The denial path must never raise and let the middleware runner skip us.
    try:
        filtered = filter_request(request)
    except Exception:
        return {'error': 'Open Harness could not validate the model tool grant.'}
    return next_call(filtered)

def register(ctx):
    global _REGISTERED
    load_grant()
    ctx.register_middleware('tool_execution', tool_execution)
    ctx.register_middleware('llm_execution', llm_execution)
    _REGISTERED = True
