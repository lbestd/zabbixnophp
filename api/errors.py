"""Zabbix JSON-RPC error codes and ApiError exception.
Separate module to avoid circular imports between jsonrpc.py and rbac.py.
"""

ERR_PARAMETERS  = 100
ERR_NO_ENTITY   = 101
ERR_PERMISSIONS = 120
ERR_INTERNAL    = 111
ERR_NO_AUTH     = 200
ERR_NO_METHOD   = 300


class ApiError(Exception):
    def __init__(self, code: int, message: str, data: str = ""):
        self.code = code
        self.message = message
        self.data = data
