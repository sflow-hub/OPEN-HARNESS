"""Load the operator's SOUL.md exactly as the coordinator wrote it."""
import hashlib
import json
import os
from functools import wraps
from pathlib import Path


def trusted_soul(content):
    # Pinned Hermes scans SOUL.md like an untrusted project file and replaces all of it with a
    # "[BLOCKED ...]" notice on any match; ordinary instructions such as "pull new tasks from the
    # board" or "check in with the Assistant" match. The coordinator records the hash of the file
    # it wrote in the read-only policy, so only that exact text skips the scan. A SOUL.md the agent
    # rewrote in its writable home, and every AGENTS.md or CLAUDE.md, is still scanned.
    try:
        policy = json.loads(Path(os.environ.get('OPEN_HARNESS_POLICY_PATH', '/run/open-harness/policy.json')).read_text())
        expected = policy.get('soulSha256')
        disk = (Path(os.environ.get('HERMES_HOME', '/home/hermes/.hermes')) / 'SOUL.md').read_bytes()
    except Exception:
        return False
    if not isinstance(expected, str) or hashlib.sha256(disk).hexdigest() != expected:
        return False
    return content.lstrip('﻿').strip() == disk.decode('utf-8').lstrip('﻿').strip()


def install():
    import agent.prompt_builder as prompt_builder

    original = getattr(prompt_builder, '_scan_context_content', None)
    if original is None:
        raise SystemExit('The Hermes context scanner changed. Update runtime/hermes/soul_trust.py before using this Hermes version.')
    if getattr(original, '_open_harness_soul_trust', False):
        return

    @wraps(original)
    def scan_context_content(content, filename, *args, **kwargs):
        if filename == 'SOUL.md' and isinstance(content, str) and trusted_soul(content):
            return content.lstrip('﻿')
        return original(content, filename, *args, **kwargs)

    scan_context_content._open_harness_soul_trust = True
    prompt_builder._scan_context_content = scan_context_content
