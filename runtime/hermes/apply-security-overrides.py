"""Apply dependency-only overrides after authenticating every pinned upstream file."""
import hashlib
from pathlib import Path
import sys


def patch_targets(targets):
    prepared = []
    for path, expected, replacements in targets:
        original = path.read_bytes()
        if hashlib.sha256(original).hexdigest() != expected:
            raise SystemExit(f"Hermes dependency metadata differs from the reviewed override: {path}; refusing to patch.")
        patched = original
        for old, new, count in replacements:
            if original.count(old) != count:
                raise SystemExit(f"Hermes dependency pin count differs from the reviewed override: {path}.")
            patched = patched.replace(old, new)
            if patched.count(new) != count or old in patched:
                raise SystemExit(f"Hermes dependency override did not replace exactly {count} pins: {path}.")
        prepared.append((path, patched))
    # Authenticate all files before writing any, so an upstream mismatch cannot leave half an override.
    for path, patched in prepared:
        path.write_bytes(patched)


if __name__ == '__main__':
    manifest = Path(sys.argv[1])
    httpx = (b'"httpx2==2.7.0"', b'"httpx2==2.12.0"')
    patch_targets([
        (manifest, "c71aa5bc9e437bac3b662fd04a4a7e121735ebc898373019a366d91e217e58a8", [
            (*httpx, 3), (b'"PyJWT[crypto]==2.13.0"', b'"PyJWT[crypto]==2.15.1"', 1)]),
        (manifest.parent / "tools/lazy_deps.py", "26282e07bc8320f338375a21a5e1aa5fed42314f7c5f0fe2e945df09a7f82c78", [(*httpx, 1)]),
    ])
    print("Applied dependency pins: httpx2 2.12.0 (manifest and lazy deps), PyJWT 2.15.1; Hermes control flow is unchanged.")
