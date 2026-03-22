#!/bin/bash
# Usage: ZBX_DB_DSN=postgresql://user:pass@host/dbname ./run.sh
set -e

cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi

export ZBX_DB_DSN="${ZBX_DB_DSN:-postgresql://zabbix:zabbix@localhost/zabbix}"

exec .venv/bin/uvicorn api.main:app --host 0.0.0.0 --port 8080 --reload
