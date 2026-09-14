import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('policy', Path(__file__).parents[1] / 'runtime/hermes/extension/open_harness_policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

class PolicyTests(unittest.TestCase):
    def setUp(self):
        policy._GRANT = frozenset(['execute_code', 'read_file'])
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

unittest.main()
