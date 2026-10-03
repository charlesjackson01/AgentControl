"""In-process event bus for live dashboard updates.

Events are small change notices ("run X changed"), not state. The dashboard reacts by
re-reading /api/state, so a dropped notice costs nothing but a moment of staleness, and the
journal stays the single source of truth. Standard library only.
"""
import queue
import threading
import time


class EventBus:
    def __init__(self, queue_size=100):
        self.lock = threading.Lock()
        self.seq = 0
        self.queue_size = queue_size
        self.subscribers = set()

    def publish(self, kind, run=None):
        with self.lock:
            self.seq += 1
            event = {'seq': self.seq, 'kind': kind, 'run': run, 'time': round(time.time(), 3)}
            subscribers = list(self.subscribers)
        for q in subscribers:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass  # a slow client already has notices waiting; it will re-read the full state anyway
        return event

    def subscribe(self, limit=None):
        """Return a new subscriber queue, or None when `limit` subscribers are already connected."""
        with self.lock:
            if limit is not None and len(self.subscribers) >= limit:
                return None
            q = queue.Queue(self.queue_size)
            self.subscribers.add(q)
            return q

    def unsubscribe(self, q):
        with self.lock:
            self.subscribers.discard(q)

    def count(self):
        with self.lock:
            return len(self.subscribers)
