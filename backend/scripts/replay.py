#!/usr/bin/env python3
"""Replay a fixed set of chat messages against the real agent with a stub bot state, to get comparable
numbers before and after each optimization phase. Calls the real model, so it costs a few cents.

    uv run python backend/scripts/replay.py [--effort low] [--label baseline]

Messages come from backend/scripts/replay-messages.json ("optional": true means answering with no tool
is also fine). Each is a fresh conversation unless it sets "fresh": false (a follow-up to the message
before it). Writes the run lines to
backend/logs/replay-<label>-<time>.log (not agent.log, so it stays out of the real numbers), prints
the tools called against the ones expected, then feed the file to backend/scripts/token-report.py.
Uses a temporary data dir, so it never touches saved places, notes or chests.
"""
import argparse
import asyncio
import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
os.environ['DATA_DIR'] = tempfile.mkdtemp(prefix='minecraft-agent-replay-')
sys.path[:0] = [str(BACKEND), str(BACKEND / 'tests')]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--effort', help='low, medium, high, xhigh or max (default: the model default)')
    parser.add_argument('--label', default='run')
    args = parser.parse_args()
    if args.effort:
        os.environ['EFFORT'] = args.effort

    from app.routes import chat as chat_route  # imported after the env is set
    from app.services.budget import Budget
    from app.services.memory import memory
    from test_world import make_state

    settings = chat_route.settings
    chat_route.budget = Budget(0, settings.model_name)  # no limit for the replay
    log_file = BACKEND / 'logs' / f'replay-{args.label}-{time.strftime("%Y%m%dT%H%M%S")}.log'
    log_file.parent.mkdir(exist_ok=True)
    handler = logging.FileHandler(log_file, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(name)s: %(message)s'))
    run_logger = logging.getLogger('app.run')
    run_logger.addHandler(handler)
    run_logger.setLevel(logging.INFO)

    messages = json.loads((BACKEND / 'scripts' / 'replay-messages.json').read_text())
    state = make_state()
    misses = 0

    async def run_all() -> None:
        nonlocal misses
        for item in messages:
            if item.get('fresh', True):
                memory._conversations.clear()
            response = await chat_route.run_agent('Replay', f'Replay: {item["say"]}', state)
            called = [a.type for a in response.actions]
            records = [json.loads(line.split('run ', 1)[1]) for line in log_file.read_text().splitlines()[-1:]]
            tools = records[0]['tools'] if records else []
            expect = item['expect']
            ok = (not tools) if not expect else any(t in tools for t in expect) or (item.get('optional') and not tools)
            misses += not ok
            print(f'{"ok  " if ok else "MISS"} [{item["kind"]}] {item["say"]!r} -> tools {tools or "-"} actions {called or "-"}'
                  f'{"" if ok else f"  (expected one of {expect or "no tools"})"}\n       reply: {response.reply!r}')

    asyncio.run(run_all())
    print(f'\n{len(messages) - misses}/{len(messages)} as expected. Run lines: {log_file}')
    print(f'Report: python3 backend/scripts/token-report.py {log_file}')


if __name__ == '__main__':
    main()
