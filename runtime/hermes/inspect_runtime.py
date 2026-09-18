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
    if spec['action'] == 'computer':
        import os
        probe = os.path.expanduser('~/.open-harness-access-check')
        with open(probe, 'w', encoding='utf-8') as handle:
            handle.write('ready')
        os.remove(probe)
        if spec.get('desktop') in ('existing', 'virtual'):
            import io
            try:
                from tools.computer_use.doctor import run_doctor
            except ImportError:
                return {'ok': False, 'message': 'Hermes desktop helper is missing. Run hermes computer-use install on this computer.'}
            output = io.StringIO()
            try:
                with contextlib.redirect_stdout(output):
                    status = run_doctor(json_output=True)
            except Exception:
                return {'ok': False, 'message': 'Desktop helper could not run. Run hermes computer-use doctor in the runner session for setup instructions.'}
            try:
                report = json.loads(output.getvalue())
            except (ValueError, TypeError):
                return {'ok': False, 'message': 'Desktop helper is unavailable. Run hermes computer-use doctor in the runner session for setup instructions.'}
            failed = [check for check in report.get('checks', []) if check.get('status') == 'fail']
            if status or report.get('overall') != 'ok':
                detail = ' '.join(f"{check.get('name', 'Desktop check')}: {check.get('hint') or check.get('message', 'needs attention')}" for check in failed[:4])
                return {'ok': False, 'message': detail or 'Desktop helper is not ready. Run hermes computer-use doctor in the runner session.'}
            return {'ok': True, 'message': 'Commands, files, and desktop control are ready.'}
        return {'ok': True, 'message': 'Commands and private file access are ready.'}
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
