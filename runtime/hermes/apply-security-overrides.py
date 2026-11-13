"""Apply the reviewed dependency-only override to the exact pinned manifest."""
import hashlib
from pathlib import Path
import sys

manifest = Path(sys.argv[1])
targets = (
    (manifest, "c71aa5bc9e437bac3b662fd04a4a7e121735ebc898373019a366d91e217e58a8", 3),
    (manifest.parent / "tools/lazy_deps.py", "26282e07bc8320f338375a21a5e1aa5fed42314f7c5f0fe2e945df09a7f82c78", 1),
)
old, new = b'"httpx2==2.7.0"', b'"httpx2==2.12.0"'
prepared = []
for path, expected, count in targets:
    original = path.read_bytes()
    if hashlib.sha256(original).hexdigest() != expected or original.count(old) != count:
        raise SystemExit(f"Hermes dependency metadata differs from the reviewed override: {path}; refusing to patch.")
    patched = original.replace(old, new)
    if patched.count(new) != count or old in patched:
        raise SystemExit(f"Hermes dependency override did not replace exactly {count} pins: {path}.")
    prepared.append((path, patched))
for path, patched in prepared:
    path.write_bytes(patched)
print("Applied three manifest pins and one lazy-dependency pin: httpx2 2.7.0 -> 2.12.0; Hermes control flow is unchanged.")
