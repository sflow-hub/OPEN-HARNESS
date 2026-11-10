import importlib.util
import unittest
import os
import json
import tempfile
import time
import base64
from unittest.mock import patch, Mock
from pathlib import Path

spec = importlib.util.spec_from_file_location('policy', Path(__file__).parents[1] / 'runtime/hermes/extension/open_harness_policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

class PolicyTests(unittest.TestCase):
    def setUp(self):
        policy._GRANT = frozenset(['execute_code', 'read_file'])
        policy._REVIEW_UNCLASSIFIED = False
        self.executions = []
    def dispatch(self, tool):
        return policy.tool_execution(tool_name=tool, args={}, next_call=lambda args: self.executions.append(tool))
    def test_direct_and_child_denial(self):
        self.assertIn('tool_disabled', self.dispatch('terminal'))
        self.assertIn('tool_disabled', self.dispatch('browser_navigate'))
        self.assertEqual(self.executions, [])
    def test_nested_code_dispatch(self):
        result = policy.tool_execution(tool_name='execute_code', args={}, next_call=lambda args: self.dispatch('terminal'))
        self.assertIn('tool_disabled', result)
        self.assertEqual(self.executions, [])
    def test_allowed(self):
        self.dispatch('read_file')
        self.assertEqual(self.executions, ['read_file'])
    def test_schema_formats(self):
        request = {'tools': [{'function': {'name': 'read_file'}}, {'function': {'name': 'terminal'}}]}
        self.assertEqual(len(policy.filter_request(request)['tools']), 1)
        self.assertEqual(len(request['tools']), 2)
        self.assertEqual(policy.filter_request({'tools': [{'name': 'terminal'}, {'name': 'read_file'}]})['tools'], [{'name': 'read_file'}])
    def test_forced_disabled_choice_is_removed(self):
        request = {'tools': [{'name': 'read_file'}], 'tool_choice': {'type': 'tool', 'name': 'terminal'}}
        self.assertNotIn('tool_choice', policy.filter_request(request))
    def test_empty_never_defaults(self):
        policy._GRANT = frozenset()
        self.assertEqual(policy.filter_request({'tools': [{'name': 'terminal'}], 'tool_choice': 'required'}), {})
        self.assertIn('tool_disabled', self.dispatch('read_file'))
    def test_unreadable_policy_denies(self):
        policy._GRANT = None
        self.assertFalse(policy.permitted('terminal'))
    def test_idle_expired_and_malformed_leases_deny(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'lease.json'
            with patch.dict(os.environ, {'OPEN_HARNESS_RUN_LEASE': str(path)}):
                for value in ({'active': False}, {'active': True, 'runId': 'run'}, {'active': True, 'runId': 'run', 'expiresAt': time.time() * 1000 - 1}):
                    path.write_text(json.dumps(value))
                    self.assertFalse(policy.permitted('read_file'))
                path.write_text(json.dumps({'active': True, 'runId': 'run', 'expiresAt': time.time() * 1000 + 60000}))
                self.assertTrue(policy.permitted('read_file'))
    def test_unclassified_actions_require_a_bound_review_and_redact_private_values(self):
        policy._GRANT = frozenset(['terminal'])
        policy._REVIEW_UNCLASSIFIED = True
        calls = []
        def request(path, value):
            calls.append((path, value))
            return {'state': 'approved'}
        args = {'command': 'pytest -q', 'env': {'API_KEY': 'never-preview-this'}, 'text': 'never-preview-password'}
        with patch.object(policy, 'coordination', request):
            result = policy.tool_execution(tool_name='terminal', args=args, next_call=lambda value: 'checked')
        self.assertEqual(result, 'checked')
        self.assertNotIn('never-preview', calls[0][1]['summary'])
        self.assertIn('pytest -q', calls[0][1]['summary'])
        self.assertEqual(calls[0][1]['requestId'], calls[1][1]['requestId'])
        with patch.object(policy, 'coordination', side_effect=RuntimeError('unreachable')):
            self.assertIn('review_unavailable', policy.tool_execution(tool_name='terminal', args={}, next_call=lambda args: self.executions.append('terminal')))
        self.assertEqual(self.executions, [])

    def test_review_transport_uses_the_managed_grant_without_mcp_config(self):
        with tempfile.TemporaryDirectory() as directory:
            grant, lease = Path(directory) / 'policy.json', Path(directory) / 'lease.json'
            grant.write_text(json.dumps({'coordination': {'OPEN_HARNESS_AGENT_ID': 'atlas', 'OPEN_HARNESS_AGENT_TOKEN': 'scoped-token'}}))
            lease.write_text(json.dumps({'active': True, 'runId': 'run-review', 'expiresAt': time.time() * 1000 + 60000}))
            response = Mock(status=200)
            response.read.return_value = b'{"state":"pending"}'
            with patch.dict(os.environ, {'OPEN_HARNESS_POLICY_PATH': str(grant), 'OPEN_HARNESS_RUN_LEASE': str(lease)}), patch.object(policy.http.client.HTTPConnection, 'request') as request, patch.object(policy.http.client.HTTPConnection, 'getresponse', return_value=response):
                self.assertEqual(policy.coordination('/internal/review-tool', {'tool': 'terminal'}), {'state': 'pending'})
                headers = request.call_args.kwargs['headers']
                self.assertEqual(headers['Authorization'], 'Bearer scoped-token')
                self.assertEqual(headers['X-Open-Harness-Agent'], 'atlas')
                self.assertEqual(headers['X-Open-Harness-Run'], 'run-review')

    def test_only_exact_server_reviewed_coordination_tools_skip_middleware_review(self):
        policy._GRANT = frozenset(['mcp__open_harness__computer', 'mcp__open_harness__future_tool'])
        policy._REVIEW_UNCLASSIFIED = True
        with patch.object(policy, 'coordination', side_effect=RuntimeError('must use broker review')) as review:
            self.dispatch('mcp__open_harness__computer')
            review.assert_not_called()
            self.assertIn('review_unavailable', self.dispatch('mcp__open_harness__future_tool'))
        self.assertEqual(self.executions, ['mcp__open_harness__computer'])
        policy._GRANT = frozenset()
        self.assertIn('tool_disabled', self.dispatch('mcp__open_harness__computer'))

    def test_managed_capture_uses_native_multimodal_contract_only_with_grant_and_lease(self):
        policy._GRANT = frozenset(['mcp__open_harness__computer'])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path = root / 'img_0123456789ab.png'
            raw = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')
            path.write_bytes(raw)
            result = json.dumps({'result': json.dumps({'ok': True, 'width': 1, 'height': 1}) + '\nMEDIA:' + str(path)})
            with patch.object(policy, 'computer_image_cache_root', return_value=root):
                capture = lambda: policy.tool_execution(tool_name='mcp__open_harness__computer', args={'action': 'capture'}, next_call=lambda args: result)
                actual = capture()
                self.assertTrue(actual['_multimodal'])
                self.assertEqual(actual['content'][1]['image_url']['url'], 'data:image/png;base64,' + base64.b64encode(raw).decode())
                self.assertNotIn(str(path), json.dumps(actual))
                self.assertEqual(policy.tool_execution(tool_name='mcp__open_harness__computer', args={'action': 'input'}, next_call=lambda args: result), result)
                with patch.object(policy, 'active_lease', side_effect=[True, False]):
                    self.assertIn('capture_unavailable', capture())
                policy._GRANT = frozenset()
                with patch.object(policy, 'computer_capture_result') as adapter:
                    self.assertIn('tool_disabled', capture())
                    adapter.assert_not_called()

    def test_capture_rejects_other_paths_symlinks_hardlinks_size_and_png_headers(self):
        policy._GRANT = frozenset(['mcp__open_harness__computer'])
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve(); root = base / 'cache'; root.mkdir()
            path = root / 'img_0123456789ab.png'
            png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')
            outside = base / path.name; outside.write_bytes(png)
            def capture(selected, width=1):
                result = json.dumps({'result': json.dumps({'ok': True, 'width': width, 'height': 1}) + '\nMEDIA:' + str(selected)})
                return policy.tool_execution(tool_name='mcp__open_harness__computer', args={'action': 'capture'}, next_call=lambda args: result)
            with patch.object(policy, 'computer_image_cache_root', return_value=root):
                for selected in (outside, root / '..' / path.name, root / 'nested' / path.name):
                    self.assertIn('capture_unavailable', capture(selected))
                path.symlink_to(outside); self.assertIn('capture_unavailable', capture(path)); path.unlink()
                os.link(outside, path); self.assertIn('capture_unavailable', capture(path)); path.unlink()
                path.write_bytes(b'x' * 6000001)
                with patch.object(policy.os, 'read', side_effect=AssertionError('Oversized file must not be read')):
                    self.assertIn('capture_unavailable', capture(path))
                path.write_bytes(b'not a png' * 10); self.assertIn('capture_unavailable', capture(path))
                path.write_bytes(png); self.assertIn('capture_unavailable', capture(path, width=2))
                damaged = bytearray(png); damaged[32] ^= 1; path.write_bytes(damaged); self.assertIn('capture_unavailable', capture(path))
            linked_root = base / 'linked'; linked_root.symlink_to(root, target_is_directory=True)
            with patch.object(policy, 'computer_image_cache_root', return_value=linked_root):
                self.assertIn('capture_unavailable', capture(linked_root / path.name))

unittest.main()
