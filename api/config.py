import os

DB_DSN = os.getenv("ZBX_DB_DSN", "postgresql://zabbix:zabbix@localhost/zabbix")
SESSION_TTL = int(os.getenv("ZBX_SESSION_TTL", 86400))  # 24h
API_VERSION = "7.0.14"
