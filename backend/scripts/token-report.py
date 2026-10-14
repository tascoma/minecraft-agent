#!/usr/bin/env python3
"""Sum up the agent's `run {json}` log lines (backend/logs/agent.log*) by kind of run.

    python3 backend/scripts/token-report.py [--since 2026-10-13T18:40] [--model claude-haiku-5-5] [--effort low] [LOGFILE ...]

Prints, per kind: runs, average and p90 of input / cached / cache-write / output tokens, requests,
cost and latency, plus the cache hit rate (cached share of input tokens) and the share of runs
that used thinking. Runs from before the structured line existed are ignored.
"""
import argparse
import json
import math
import re
import statistics
from collections import defaultdict
from pathlib import Path

LOG_DIR = Path(__file__).resolve().parents[1] / 'logs'
LINE = re.compile(r'^(?P<at>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+ \w+ app\.run: run (?P<json>\{.*\})$')
FIELDS = ('input', 'cached', 'cache_writes', 'output', 'requests', 'cost', 'seconds')


def read_runs(files: list[Path]) -> list[dict]:
    runs = []
    for file in files:
        for line in file.read_text(encoding='utf-8', errors='replace').splitlines():
            match = LINE.match(line)
            if match:
                runs.append({'at': match['at'].replace(' ', 'T'), **json.loads(match['json'])})
    return runs


def p90(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(0.9 * len(ordered)) - 1)]


def report(runs: list[dict]) -> str:
    by_kind: dict[str, list[dict]] = defaultdict(list)
    for run in runs:
        by_kind[run['kind']].append(run)
    out = [f'{"kind":<12}{"runs":>5}  ' + '  '.join(f'{f:>14}' for f in FIELDS) + f'  {"hit rate":>8}  {"thinking":>8}']
    out.append(' ' * 19 + '  '.join(f'{"avg / p90":>14}' for _ in FIELDS))
    for kind, group in sorted(by_kind.items()):
        cells = []
        for f in FIELDS:
            values = [r[f] for r in group]
            fmt = '{:.4f}' if f == 'cost' else '{:.1f}' if f == 'seconds' else '{:.0f}'
            cells.append(f'{fmt.format(statistics.mean(values))} / {fmt.format(p90(values))}'.rjust(14))
        total_input = sum(r['input'] for r in group)
        hit = sum(r['cached'] for r in group) / total_input if total_input else 0
        thinking = sum(1 for r in group if r['thinking_parts']) / len(group)
        out.append(f'{kind:<12}{len(group):>5}  ' + '  '.join(cells) + f'  {hit:>8.0%}  {thinking:>8.0%}')
    out.append(f'\ntotal: {len(runs)} runs, ${sum(r["cost"] for r in runs):.4f}')
    tools: dict[str, int] = defaultdict(int)
    for run in runs:
        for tool in run['tools']:
            tools[tool] += 1
    if tools:
        out.append('tools: ' + ', '.join(f'{t} {n}' for t, n in sorted(tools.items(), key=lambda kv: -kv[1])))
    return '\n'.join(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('files', nargs='*', type=Path, help='log files (default: every backend/logs/agent.log*)')
    parser.add_argument('--since', help='only runs at or after this time, e.g. 2026-10-13T18:40')
    parser.add_argument('--model')
    parser.add_argument('--effort', help='"none" for runs with no effort set')
    args = parser.parse_args()
    files = args.files or sorted(LOG_DIR.glob('agent.log*'))
    runs = read_runs(files)
    if args.since:
        runs = [r for r in runs if r['at'] >= args.since]
    if args.model:
        runs = [r for r in runs if r['model'] == args.model]
    if args.effort:
        runs = [r for r in runs if (r['effort'] or 'none') == args.effort]
    print(report(runs) if runs else 'No run lines found. Runs are logged as "run {json}" once the backend has handled a chat.')


if __name__ == '__main__':
    main()
