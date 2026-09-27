"""Narrow protocol compatibility for the pinned Hermes/CUA combination."""
from functools import wraps


def install():
    from tools.computer_use.cua_backend_session import _CuaDriverSession

    original = _CuaDriverSession.supports_capability
    if getattr(original, '_open_harness_element_tokens', False):
        return

    @wraps(original)
    def supports_capability(self, capability, tool=None):
        # CUA 0.28.2 accepts snapshot-bound tokens in its schema but omits the
        # optional capability metadata. Let Hermes forward its captured token;
        # the driver still rejects stale tokens instead of resolving a bare index.
        return original(self, capability, tool) or (
            capability == 'accessibility.element_tokens'
            and tool is not None
            and self.supports_input_property(tool, 'element_token')
        )

    supports_capability._open_harness_element_tokens = True
    _CuaDriverSession.supports_capability = supports_capability
