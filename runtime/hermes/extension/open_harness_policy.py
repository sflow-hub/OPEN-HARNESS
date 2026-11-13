"""Managed Hermes middleware. Run grants are immutable for a gateway's lifetime.

Tool switches restrict Hermes dispatch, not arbitrary programs run by Terminal.
This module deliberately returns errors rather than raising inside middleware:
Hermes skips middleware exceptions, which would otherwise fail open.
"""
import json
import os
import time
import math
import hashlib
import http.client
import re
import socket
import uuid
import base64
import stat
import struct
import zlib
from urllib.parse import urlsplit
from pathlib import Path

_GRANT = None
_REGISTERED = False
_REVIEW_UNCLASSIFIED = False

def load_grant():
    global _GRANT, _REVIEW_UNCLASSIFIED
    if _GRANT is None:
        try:
            grant = json.loads(Path(os.environ.get('OPEN_HARNESS_POLICY_PATH', '/run/open-harness/policy.json')).read_text())
            names = grant['allowedTools']
            if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
                raise ValueError('Invalid tool grant')
            _GRANT = frozenset(names)
            _REVIEW_UNCLASSIFIED = grant.get('reviewUnclassified') is True
        except Exception:
            _GRANT = frozenset()
    return _GRANT

def permitted(name):
    return active_lease() and isinstance(name, str) and name in load_grant()

def active_lease():
    path = os.environ.get('OPEN_HARNESS_RUN_LEASE')
    if not path:
        return True
    try:
        lease = json.loads(Path(path).read_text())
        expiry = lease.get('expiresAt')
        return lease.get('active') is True and isinstance(lease.get('runId'), str) and bool(lease.get('runId')) and type(expiry) in (float, int) and math.isfinite(expiry) and expiry > time.time() * 1000
    except Exception:
        return False

def tool_execution(tool_name=None, args=None, next_call=None, **kwargs):
    if not permitted(tool_name):
        return json.dumps({'error': 'Tool access is disabled in this agent profile.', 'tool': tool_name, 'code': 'tool_disabled'})
    reviewed = None
    if _REVIEW_UNCLASSIFIED and unclassified(tool_name):
        try:
            reviewed = review_tool(tool_name, args)
        except Exception:
            return json.dumps({'error': 'This action could not be reviewed. No tool was dispatched.', 'code': 'review_unavailable'})
        if reviewed is None:
            return json.dumps({'error': 'The operator did not approve this unclassified action.', 'code': 'review_denied'})
    try:
        result = next_call(args)
    except Exception:
        if reviewed:
            try:
                coordination('/internal/tool-receipt', {'requestId': reviewed, 'resultHash': hashlib.sha256(b'completion-unconfirmed').hexdigest(), 'uncertain': True})
            except Exception:
                pass
        return json.dumps({'error': 'Tool completion was not confirmed. Check its destination before repeating it.', 'code': 'execution_uncertain'})
    if reviewed:
        try:
            coordination('/internal/tool-receipt', {'requestId': reviewed, 'resultHash': hashlib.sha256(str(result).encode()).hexdigest()})
        except Exception:
            # Execution must not be repeated when receipt delivery is uncertain.
            pass
    if tool_name == 'mcp__open_harness__computer' and isinstance(args, dict) and args.get('action') == 'capture':
        try:
            if not permitted(tool_name):
                raise ValueError('The capture lease expired')
            return computer_capture_result(result)
        except Exception:
            return json.dumps({'error': 'The managed computer capture could not be attached safely. Capture again while this task owns the computer.', 'code': 'capture_unavailable'})
    return result

def computer_image_cache_root():
    from hermes_constants import get_hermes_dir
    return Path(get_hermes_dir('cache/images', 'image_cache'))

def computer_capture_result(result):
    # Pinned Hermes renders MCP images as MEDIA files. Adapt only this trusted tool
    # to its existing native multimodal envelope; never broaden filesystem tools.
    value = json.loads(result) if isinstance(result, str) else result
    if isinstance(value, dict) and 'error' in value:
        return result
    rendered = value.get('result') if isinstance(value, dict) else None
    if not isinstance(rendered, str) or len(rendered) > 16000:
        raise ValueError('Invalid capture result')
    metadata_text, marker, filename = rendered.rpartition('\nMEDIA:')
    metadata = json.loads(metadata_text)
    width, height = metadata.get('width'), metadata.get('height')
    if not marker or metadata.get('ok') is not True or type(width) is not int or type(height) is not int or not 1 <= width <= 1440 or not 1 <= height <= 900:
        raise ValueError('Invalid capture metadata')
    root = computer_image_cache_root()
    path = Path(filename)
    if not root.is_absolute() or '..' in root.parts or path.parent != root or not re.fullmatch(r'img_[0-9a-f]{12}\.png', path.name):
        raise ValueError('Capture is outside the fixed image cache')
    directory = descriptor = None
    try:
        directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        for part in root.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or not 33 <= info.st_size <= 6000000:
            raise ValueError('Invalid cached capture file')
        chunks, size = [], 0
        while True:
            chunk = os.read(descriptor, min(65536, 6000001 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > 6000000:
                raise ValueError('Capture exceeds the image bound')
        raw = b''.join(chunks)
        if len(raw) != info.st_size or raw[:8] != b'\x89PNG\r\n\x1a\n' or raw[8:16] != b'\x00\x00\x00\rIHDR' or struct.unpack('>II', raw[16:24]) != (width, height) or zlib.crc32(raw[12:29]) != struct.unpack('>I', raw[29:33])[0]:
            raise ValueError('Invalid capture PNG header')
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if directory is not None:
            os.close(directory)
    summary = 'Managed computer capture. ' + json.dumps(metadata, separators=(',', ':'))
    return {'_multimodal': True, 'content': [{'type': 'text', 'text': summary}, {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + base64.b64encode(raw).decode('ascii')}}], 'text_summary': 'Managed computer screenshot requires a vision-capable model; capture again after choosing one.', 'meta': {'native_vision': True, 'size_bytes': len(raw)}}

def unclassified(name):
    known = {'read_file', 'write_file', 'patch', 'search_files', 'web_search', 'web_extract', 'session_search', 'skills_list', 'skill_view', 'clarify'}
    # These exact endpoints enforce their own permissions and action review. New tools
    # must not inherit that exemption just by sharing the coordination server name.
    reviewed_by_coordinator = {'mcp__open_harness__' + tool for tool in ('workspace', 'group_chat', 'task', 'delegate_named_agent', 'create_open_harness_routine', 'computer')}
    return name not in known and name not in reviewed_by_coordinator

def coordination(path, value):
    grant = json.loads(Path(os.environ.get('OPEN_HARNESS_POLICY_PATH', '/run/open-harness/policy.json')).read_text())
    env = grant['coordination']
    lease = json.loads(Path(os.environ.get('OPEN_HARNESS_RUN_LEASE', '/run/open-harness/run-lease.json')).read_text())
    if not active_lease():
        raise ValueError('No active task')
    headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env['OPEN_HARNESS_AGENT_TOKEN'], 'X-Open-Harness-Agent': env['OPEN_HARNESS_AGENT_ID'], 'X-Open-Harness-Run': lease['runId']}
    class UnixHTTP(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(10)
            self.sock.connect(env.get('OPEN_HARNESS_CONTROL_SOCKET', '/run/open-harness/coord.sock'))
    routes = [(lambda: UnixHTTP('localhost', timeout=10), '')]
    if env.get('OPEN_HARNESS_CONTROL_URL'):
        url = urlsplit(env['OPEN_HARNESS_CONTROL_URL'])
        routes.append((lambda: (http.client.HTTPSConnection if url.scheme == 'https' else http.client.HTTPConnection)(url.hostname, url.port, timeout=10), url.path.rstrip('/')))
    for route, prefix in routes:
        connection = route()
        try:
            connection.request('POST', prefix + path, body=json.dumps(value), headers=headers)
            response = connection.getresponse()
            raw = response.read(50000)
            if response.status >= 400:
                raise ValueError('Review was not authorized')
            return json.loads(raw)
        except (OSError, http.client.HTTPException):
            continue
        finally:
            connection.close()
    raise ValueError('Coordinator unavailable')

def review_tool(name, args):
    identity = str(uuid.uuid4())
    serialized = json.dumps(args, sort_keys=True, default=str)
    def redact(value):
        if isinstance(value, dict):
            return {key: '[private value omitted]' if re.search(r'password|secret|token|credential|authorization|api.?key|private.?key|cookie|text', key, re.I) else redact(item) for key, item in value.items()}
        if isinstance(value, list):
            return [redact(item) for item in value[:50]]
        if isinstance(value, str) and re.search(r'(?i)(?:password|secret|api.?key|access.?token)\s*[:=]', value):
            return '[private assignment omitted]'
        return value
    preview = redact(args if isinstance(args, dict) else {'arguments': '[omitted]'})
    summary = json.dumps(preview, default=str)
    summary = re.sub(r'(?i)(Bearer\s+|(?:sk|xai|ghp|github_pat)[-_])[A-Za-z0-9_.-]{12,}', '[credential omitted]', summary)[:3500]
    request = {'requestId': identity, 'tool': name, 'argumentHash': hashlib.sha256(serialized.encode()).hexdigest(), 'summary': summary}
    while active_lease():
        decision = coordination('/internal/review-tool', request)
        if decision.get('state') == 'approved':
            return identity
        if decision.get('state') != 'pending':
            return None
        time.sleep(1)
    return None

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
        if not active_lease():
            return {'error': 'No active task owns this runtime.'}
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
