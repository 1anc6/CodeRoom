import time
from collections import deque
from collections.abc import Callable

from fastapi import Request

# Sweep idle keys once the table grows past this, so one-off IPs don't accumulate forever.
_SWEEP_THRESHOLD = 10_000


class SlidingWindowLimiter:
    """Counts events per key over a sliding time window.

    State lives in process memory, which is fine for the single-instance MVP. Running
    several app instances would need a shared store (see the blueprint's scaling note).
    """

    def __init__(self, limit: int, window_seconds: float, clock: Callable[[], float] = time.monotonic):
        self.limit = limit
        self.window_seconds = window_seconds
        self._clock = clock
        self._events: dict[str, deque[float]] = {}

    def is_limited(self, key: str) -> bool:
        return len(self._prune(key)) >= self.limit

    def hit(self, key: str) -> None:
        if len(self._events) > _SWEEP_THRESHOLD:
            for stale_key in list(self._events):
                self._prune(stale_key)
        self._events.setdefault(key, deque()).append(self._clock())

    def _prune(self, key: str) -> deque[float]:
        events = self._events.get(key)
        if events is None:
            return deque()
        cutoff = self._clock() - self.window_seconds
        while events and events[0] <= cutoff:
            events.popleft()
        if not events:
            del self._events[key]
        return events


def client_ip(request: Request) -> str:
    # Behind a reverse proxy, run uvicorn with --proxy-headers and --forwarded-allow-ips
    # so this reflects the real client rather than the proxy.
    return request.client.host if request.client else "unknown"
