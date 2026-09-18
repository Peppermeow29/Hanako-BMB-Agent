"""Hanako's bounded MLX-LM server entrypoint.

mlx_lm 0.31 creates ``LRUPromptCache(prompt_cache_size)`` in its sequential
HTTP path and therefore ignores the CLI's ``--prompt-cache-bytes`` argument.
The local MiniCPM server is normally sequential by design, so bind that byte
cap here without editing the installed package. The standard entrypoint and
wire protocol remain unchanged.
"""

import os

from mlx_lm import server


def _default_repetition_penalty():
    raw = os.environ.get("MINICPM5_DEFAULT_REPETITION_PENALTY", "0.0")
    try:
        value = float(raw)
    except ValueError as exc:
        raise SystemExit("MINICPM5_DEFAULT_REPETITION_PENALTY must be a number") from exc
    if value < 0:
        raise SystemExit("MINICPM5_DEFAULT_REPETITION_PENALTY must be non-negative")
    return value


def _cache_cap():
    raw = os.environ.get("MINICPM5_ENFORCED_PROMPT_CACHE_BYTES")
    if raw is None:
        return None
    try:
        cap = int(raw)
    except ValueError as exc:
        raise SystemExit("MINICPM5_ENFORCED_PROMPT_CACHE_BYTES must be an integer") from exc
    if cap < 0:
        raise SystemExit("MINICPM5_ENFORCED_PROMPT_CACHE_BYTES must be non-negative")
    return cap


cache_cap = _cache_cap()
default_repetition_penalty = _default_repetition_penalty()
if cache_cap is not None:
    original_cache = server.LRUPromptCache

    class BoundedPromptCache(original_cache):
        def __init__(self, max_size=10, max_bytes=1 << 63):
            super().__init__(max_size=max_size, max_bytes=cache_cap)

    server.LRUPromptCache = BoundedPromptCache

# mlx-lm's HTTP handler defaults repetition_penalty to 0.0 even when the
# launcher has a local policy. Patch the final generation hook only; an
# explicit request field from Hanako still wins.
original_handle_completion = server.APIHandler.handle_completion


def handle_completion_with_default(self, request, stop_words):
    if "repetition_penalty" not in self.body:
        self.repetition_penalty = default_repetition_penalty
    return original_handle_completion(self, request, stop_words)


server.APIHandler.handle_completion = handle_completion_with_default

server.main()
