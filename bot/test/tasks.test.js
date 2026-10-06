import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { cancelTask, currentTask, queued, soundsLikeFailure, startTask } from '../core/tasks.js'

const log = () => {}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('tasks', () => {
  afterEach(() => cancelTask())

  it('reports the current job and its progress, then clears it', async () => {
    let finish
    const ended = []
    startTask('getting 3 logs', (task) => new Promise((r) => { task.progress = '1/3'; finish = r }), { log, onEnd: (t) => ended.push(t.description) })
    await tick()
    assert.deepEqual(currentTask(), { description: 'getting 3 logs', progress: '1/3', queued: 0 })
    finish()
    await tick()
    assert.equal(currentTask(), null)
    assert.deepEqual(ended, ['getting 3 logs'])
  })

  it('a new job cancels the old one, which must not run onEnd', async () => {
    const ended = []
    const cancelled = []
    const forever = () => new Promise(() => {})
    startTask('first', forever, { log, onCancel: () => cancelled.push('first'), onEnd: () => ended.push('first') })
    startTask('second', forever, { log, onEnd: () => ended.push('second') })
    await tick()
    assert.deepEqual(cancelled, ['first'])
    assert.equal(currentTask().description, 'second')
    assert.deepEqual(ended, [])
  })

  it('cancelTask stops the job and marks it cancelled', async () => {
    let seen
    startTask('job', (task) => { seen = task; return new Promise(() => {}) }, { log })
    await tick()
    cancelTask()
    assert.ok(seen.cancelled)
    assert.equal(currentTask(), null)
  })

  it('a job that throws still clears and runs onEnd', async () => {
    const ended = []
    startTask('broken', () => { throw new Error('boom') }, { log, onEnd: () => ended.push('broken') })
    await tick()
    await tick()
    assert.equal(currentTask(), null)
    assert.deepEqual(ended, ['broken'])
  })
})

describe('queued tasks', () => {
  afterEach(() => cancelTask())

  it('runs queued jobs one after another, then calls onEnd once', async () => {
    const order = []
    const ended = []
    const finish = {}
    const job = (name) => (task) => new Promise((r) => { order.push(name); finish[name] = r })
    startTask('first', job('first'), { log, onEnd: () => ended.push('first') })
    queued(() => startTask('second', job('second'), { log, onEnd: () => ended.push('second') }))
    await tick()
    assert.deepEqual(currentTask(), { description: 'first', progress: null, queued: 1 })
    finish.first()
    await tick(); await tick()
    assert.deepEqual(order, ['first', 'second'])
    assert.equal(currentTask().description, 'second')
    finish.second()
    await tick(); await tick()
    assert.deepEqual(ended, ['second'], 'only the last job hands back')
    assert.equal(currentTask(), null)
  })

  it('a new command drops the queue', async () => {
    const order = []
    startTask('first', () => new Promise(() => order.push('first')), { log })
    queued(() => startTask('second', () => order.push('second'), { log }))
    cancelTask()
    await tick(); await tick()
    assert.deepEqual(order, ['first'])
    assert.equal(currentTask(), null)
  })

  it('queueing with nothing running just starts the job', async () => {
    queued(() => startTask('only', () => new Promise(() => {}), { log }))
    await tick()
    assert.equal(currentTask().description, 'only')
  })
})

describe('job results', () => {
  it('tells a failure from a success', () => {
    for (const bad of ["I couldn't get any iron: there's no more iron within 48 blocks.", 'I only got 3 logs: ...', "My inventory is full, so I can't pick anything up."]) {
      assert.equal(soundsLikeFailure(bad), true, bad)
    }
    for (const good of ['Got 20 cobblestone.', 'Made 4 sticks.', 'Built the shelter with a door.']) assert.equal(soundsLikeFailure(good), false, good)
  })
})
