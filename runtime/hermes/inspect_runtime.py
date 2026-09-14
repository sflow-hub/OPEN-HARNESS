"""Read-only runtime inventory and connection probes; JSON on stdout only."""
import contextlib
import json
import sys
import asyncio

async def mcp_check(spec):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    import os
    async with stdio_client(StdioServerParameters(command=spec['command'], args=spec.get('args', []), env={**os.environ, **spec.get('env', {})})) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()
            return {'status': 'connected', 'tools': [{'name': t.name, 'description': t.description or ''} for t in result.tools]}

def main(spec):
    if spec['action'] == 'mcp':
        return asyncio.run(asyncio.wait_for(mcp_check(spec), timeout=20))
    if spec['action'] == 'connection':
        import urllib.request
        endpoint = spec['baseUrl'].rstrip('/') + '/models'
        headers = {'Authorization': 'Bearer ' + spec['apiKey']} if spec.get('apiKey') else {}
        with urllib.request.urlopen(urllib.request.Request(endpoint, headers=headers), timeout=10) as response:
            return {'ok': response.status == 200, 'message': 'Endpoint reached from the agent container.'}
    import model_tools
    from tools.registry import registry
    definitions = model_tools.get_tool_definitions(quiet_mode=True, skip_tool_search_assembly=True)
    available = {d['function']['name'] for d in definitions}
    return {'tools': [{'id': e.name, 'name': e.name.replace('_', ' '), 'group': e.toolset, 'description': (registry.get_schema(e.name) or {}).get('description', '') or (registry.get_schema(e.name) or {}).get('function', {}).get('description', ''), 'available': e.name in available, 'reason': None if e.name in available else 'Runtime dependency or credentials are missing.'} for e in registry.get_all_entries()]}

if __name__ == '__main__':
    try:
        spec = json.loads(sys.stdin.readline())
        with contextlib.redirect_stdout(sys.stderr):
            result = main(spec)
        print(json.dumps(result))
    except Exception:
        # Do not expose provider response bodies, environment values or arguments.
        print(json.dumps({'error': 'Runtime check failed. Check the executable, endpoint, dependencies, and selected credentials.'}))
        sys.exit(1)
