import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatPerf, measure, perfReport, timed } from '../core/perf.js'

const spin = (ms) => { const end = performance.now() + ms; while (performance.now() < end); }

describe('perf', () => {
  it('records calls, average and slowest call per name, busiest first', () => {
    perfReport()
    const quick = timed('quick', () => 1)
    const slow = timed('slow', () => spin(5))
    for (let i = 0; i < 3; i++) quick()
    slow()
    slow()
    const { rows } = perfReport()
    assert.deepEqual(rows.map((r) => r.name), ['slow', 'quick'])
    const [slowRow, quickRow] = rows
    assert.equal(slowRow.calls, 2)
    assert.ok(slowRow.avgMs >= 4.5 && slowRow.maxMs >= slowRow.avgMs)
    assert.equal(quickRow.calls, 3)
    assert.ok(slowRow.corePercent > quickRow.corePercent)
  })

  it('keeps the return value, this and arguments, and still records when the function throws', () => {
    perfReport()
    const obj = { n: 2, add: timed('add', function add(x) { return this.n + x }) }
    assert.equal(obj.add(3), 5)
    assert.throws(() => measure('boom', () => { throw new Error('x') }), /x/)
    const { rows } = perfReport()
    assert.deepEqual(rows.map((r) => [r.name, r.calls]).sort(), [['add', 1], ['boom', 1]])
  })

  it('starts a new window after each report', () => {
    perfReport()
    timed('once', () => {})()
    assert.equal(perfReport().rows.length, 1)
    assert.equal(perfReport().rows.length, 0)
  })

  it('formats one readable line', () => {
    perfReport()
    timed('combat.tick', () => spin(1))()
    const line = formatPerf(perfReport())
    assert.match(line, /^perf over \d+s: combat\.tick 1x avg [\d.]+ms max [\d.]+ms \([\d.]+% of a core\); event loop lag/)
    assert.match(formatPerf({ windowMs: 1000, rows: [], lag: { p50Ms: 0, p99Ms: 0, maxMs: 0 } }), /nothing timed/)
  })
})
