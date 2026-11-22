import importlib.util
import json
from pathlib import Path
import unittest


adapter = Path(__file__).resolve().parents[1] / "adapters" / "openhands.py"
spec = importlib.util.spec_from_file_location("openhands_bridge", adapter)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class EventFieldsTest(unittest.TestCase):
    def test_redacts_structured_and_serialized_tool_arguments(self):
        key = 'fixture-"quoted"' + chr(92) + "key"
        escaped = json.dumps(key, ensure_ascii=False)[1:-1]
        event = bridge.event_fields(
            {
                "preview": {
                    "arguments": [key, {"encoded": json.dumps({"value": key})}],
                    key: "nested field",
                },
                "result": "Result: " + escaped,
            },
            key,
        )
        preview = json.loads(event["preview"])
        self.assertEqual(preview["arguments"][0], "[redacted]")
        self.assertEqual(json.loads(preview["arguments"][1]["encoded"])["value"], "[redacted]")
        self.assertEqual(preview["[redacted]"], "nested field")
        self.assertNotIn(escaped, event["result"])
        self.assertEqual(event["result"], "Result: [redacted]")

    def test_preserves_keyless_events_and_clips_preview(self):
        fields = {"preview": {"command": "x" * 2000}, "error": False, "text": "hello"}
        event = bridge.event_fields(fields, "")
        self.assertFalse(event["error"])
        self.assertEqual(event["text"], "hello")
        self.assertEqual(len(event["preview"]), 1000)


if __name__ == "__main__":
    unittest.main()
