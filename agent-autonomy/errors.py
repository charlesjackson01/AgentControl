"""Exceptions shared by the controller and its adapters."""


class Stopped(Exception):
    pass


class Attention(Exception):
    pass


class ReviewConflict(ValueError):
    """The displayed request is stale, belongs elsewhere, or was already answered."""


class OpenCodeHTTPError(RuntimeError):
    def __init__(self, method, path, status, detail):
        super().__init__(f'OpenCode {method} {path}: HTTP {status} {detail}')
        self.status = status
