from app.rate_limit import SlidingWindowLimiter


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_limits_after_reaching_the_limit_within_the_window():
    clock = FakeClock()
    limiter = SlidingWindowLimiter(limit=3, window_seconds=60, clock=clock)

    for _ in range(3):
        assert not limiter.is_limited("ip")
        limiter.hit("ip")

    assert limiter.is_limited("ip")
    assert not limiter.is_limited("other-ip")


def test_events_age_out_of_the_window():
    clock = FakeClock()
    limiter = SlidingWindowLimiter(limit=2, window_seconds=60, clock=clock)
    limiter.hit("ip")
    clock.now += 30
    limiter.hit("ip")
    assert limiter.is_limited("ip")

    clock.now += 31  # first hit is now older than the window
    assert not limiter.is_limited("ip")

    clock.now += 30  # both hits have aged out
    assert not limiter.is_limited("ip")
    assert "ip" not in limiter._events
