#!/bin/zsh
# Closed-loop batch used for RESULTS.md. Usage: run_all.sh <scratch-dir>
# The API key is read from the macOS Keychain straight into this process's env (never printed or stored).
set -u
S=$1
PY=$S/venv/bin/python
M=$S/models
O=$S/out
cd "$(dirname "$0")"
export PILOT_SPEND_FILE=$O/spend.txt
export ANTHROPIC_API_KEY="$(security find-generic-password -s coool-anthropic-api-key -a coool -w)"
$PY run.py $S/udid haiku 3 --tasks contact,maps_search --out $O/ep_haiku_fix.jsonl --run-offset 10
$PY run.py $S/udid mlxid:$M/Qwen3-1.7B-4bit 2 --out $O/ep_a_small.jsonl --run-offset 20
$PY run.py $S/udid mlxid:$M/Qwen3-4B-Instruct-2507-4bit 2 --out $O/ep_a_large.jsonl --run-offset 22
$PY run.py $S/udid hybrid:$M/Qwen3-4B-Instruct-2507-4bit:-1 2 --out $O/ep_hybrid.jsonl --run-offset 24
rm -f $O/memory.json
$PY run.py $S/udid "memory:haiku@$O/memory.json" 3 --out $O/ep_mem.jsonl --run-offset 30
echo ALLDONE
