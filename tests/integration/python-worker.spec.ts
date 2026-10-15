import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { PythonAlgorithmWorker } from '../../src/adapters/python/worker.js'
import { freezeAlgorithmSource } from '../../src/adapters/python/source.js'
import { canonicalDigest } from '../../src/domain/canonical.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('executes frozen Python decisions with OS filesystem, environment and network isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-python-sandbox-')); roots.push(root)
  const source = join(root, 'source'), scratch = join(root, 'scratch'), secret = join(root, 'held-out.json')
  await mkdir(scratch); await writeFile(secret, 'PRIVATE_HELD_OUT')
  const socketPath = join(root, 'control.sock'), server = createServer()
  server.listen(socketPath)
  await once(server, 'listening')
  const plugin = join(root, 'isolation.py')
  await writeFile(plugin, `from gear.algorithms import Decision, Operation
import os, socket
class Probe:
 def step(self, view, state):
  assert 'GEAR_PRIVATE_TEST' not in os.environ
  try:
   open(${JSON.stringify(secret)}).read()
   raise AssertionError('private file readable')
  except (PermissionError, FileNotFoundError): pass
  try:
   with socket.socket(socket.AF_UNIX) as control:
    control.connect(${JSON.stringify(socketPath)})
    raise AssertionError('host control socket accessible')
  except OSError: pass
  try:
   socket.create_connection(('1.1.1.1', 443), timeout=0.2)
   raise AssertionError('network accessible')
  except OSError: pass
  return Decision(state, (Operation('stop'),), 'sandbox verified')
`)
  const identity = await freezeAlgorithmSource(source, [{ path: 'isolation.py', source: plugin }])
  const worker = new PythonAlgorithmWorker({ python: process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3', sourceRoot: source, scratch, implementationIdentity: identity,
    ...(process.env.GEAR_TEST_LINUX_ISOLATION ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' } : {}) })
  process.env.GEAR_PRIVATE_TEST = 'not-for-worker'
  try {
    await worker.start(new AbortController().signal)
    const decision = await worker.step({ run_id: 'test', step_id: 0, seed: 'test', tasks: [{ id: 'seed', family: 'a', estimated_cost: 1 }],
      candidates: [{ id: 'anchor', digest: canonicalDigest('anchor'), parent_id: null }], evidence: [], completed: [],
      budget: { evaluations_remaining: 5, candidates_remaining: 1, rounds: 1, repetitions: 1 }, anchor_id: 'anchor' },
    { version: 1, data: {} }, { name: 'isolation:Probe', options: {} }, new AbortController().signal)
    expect(decision.reason).toBe('sandbox verified')
  } finally { delete process.env.GEAR_PRIVATE_TEST; await worker.dispose(); await new Promise<void>(resolve => server.close(() => resolve())) }
}, 30_000)
