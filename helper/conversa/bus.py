from __future__ import annotations

import queue
import threading
from dataclasses import dataclass, field


@dataclass
class Approval:
    question: str
    done: threading.Event = field(default_factory=threading.Event)
    decision: str = "timeout"
    fails: int = 0


class Bus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: list[queue.Queue] = []
        self._approvals: dict[str, Approval] = {}

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def publish(self, message: dict) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(message)

    def open_approval(self, approval_id: str, question: str) -> Approval:
        approval = Approval(question)
        with self._lock:
            self._approvals[approval_id] = approval
        return approval

    def close_approval(self, approval_id: str) -> None:
        with self._lock:
            self._approvals.pop(approval_id, None)

    def approval(self, approval_id: str) -> Approval | None:
        with self._lock:
            return self._approvals.get(approval_id)

    def decide(self, approval_id: str, decision: str) -> bool:
        approval = self.approval(approval_id)
        if approval is None:
            return False
        approval.decision = decision
        approval.done.set()
        return True
