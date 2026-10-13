import { pythonObjective } from '../../src/adapters/python/objective.js'
import { resolveProjectObjective } from '../../src/application/objective.js'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { DurableRunner } from '../../src/runtime/runner.js'
import type { AlgorithmDriver, RunSpec } from '../../src/domain/run.js'
import type { OperationProvider, OperationReceipt, OperationRequest, OperationInspection } from '../../src/ports/operations.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const python = process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'
const driver: AlgorithmDriver = { async step(view, state, algorithm) {
  // Pure offline conformance adapter. Production only uses the sandbox worker.
  return JSON.parse(execFileSync(python, ['-c', 'import sys,json;from dataclasses import asdict;from gear.refine.worker import decode_view,make_algorithm;from gear.algorithms import AlgorithmState;v=json.load(sys.stdin);print(json.dumps(asdict(make_algorithm(v["algorithm"]).step(decode_view(v["view"]),AlgorithmState(**v["state"])))))'],
    { input: JSON.stringify({ view, state, algorithm }), env: { ...process.env, PYTHONPATH: resolve('python') }, encoding: 'utf8' }))
} }
class FakeProvider implements OperationProvider {
  identity = canonicalDigest('fake-v1')
  capabilities = { seeds: true, temperature: true, subsets: true, idempotentSubmission: true,
    inspect: true, cancel: true, physicalAttemptAccounting: true, evidenceProjection: false, generationBudget: false, hardDollarBudget: false }
  receipts = new Map<string, OperationReceipt>()
  calls: OperationRequest[] = []
  loseReply = false
  uncertain = false
  baselineScore = 0
  async submit(request: OperationRequest, _signal: AbortSignal): Promise<OperationReceipt> {
    this.calls.push(structuredClone(request))
    const operation = request.operation
    const receipt: OperationReceipt = {
      result: { operation_id: request.operationId, kind: operation.kind, status: 'complete', candidate_id: operation.candidate_id,
        data: operation.kind === 'diagnose_seed' ? { hypotheses: ['Repair seed behavior'] } : null },
      candidate: operation.kind === 'generate_candidate' ? { id: operation.candidate_id!, digest: canonicalDigest(operation), parent_id: operation.parent_id } : null,
      evidence: request.slots.map(slot => ({ candidate_id: operation.candidate_id!, task_id: slot.taskId, repetition: slot.repetition,
        score: operation.candidate_id === 'anchor' ? this.baselineScore : 1, status: 'valid', scope: operation.scope, feedback: '' })),
      physicalAttempts: request.slots.length, usage: { model_requests: 0 }, provenance: { provider: this.identity },
    }
    this.receipts.set(request.operationId, receipt)
    if (this.loseReply) { this.loseReply = false; throw new Error('reply lost after submission') }
    return receipt
  }
  async inspect(request: OperationRequest): Promise<OperationInspection> {
    if (this.uncertain) return { state: 'unknown' as const }
    const receipt = this.receipts.get(request.operationId)
    return receipt ? { state: 'complete' as const, receipt } : { state: 'not_submitted' as const }
  }
  async cancel() {}
}
async function fixture(budget = 30, overrides: Partial<RunSpec> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gear-runtime-')); roots.push(root)
  const store = new RunStore(root), provider = new FakeProvider()
  const spec: RunSpec = { version: 1, kind: 'refine', benchmarkDigest: canonicalDigest('tasks'), configDigest: canonicalDigest('config'), implementationIdentity: canonicalDigest('algorithm'),
    providerIdentity: provider.identity, championRevision: null, targetSourceDigest: canonicalDigest('target'), lineage: null, algorithm: { name: 'gepa', options: {} }, validationMode: 'holdout', seed: 'fixed',
    seedTasks: [{ id: 'seed1', family: 'seed', estimated_cost: 1 }, { id: 'seed2', family: 'seed', estimated_cost: 1 }], heldOutTaskIds: ['secret-held-out'],
    anchor: { id: 'anchor', digest: canonicalDigest('anchor'), parent_id: null }, budget: { rounds: 1, maxEvaluations: budget, maxCandidates: 1, repetitions: 1 },
    acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
      generationBudget: { version: 1, total: {}, perOperation: {} }, evaluationRepair: { maxRetries: 2, maxProjections: 2, backoffMs: [0] }, ...overrides }
  await store.create('run', spec)
  return { store, provider, runner: new DurableRunner(store, driver, provider, pythonObjective) }
}

describe('Python decisions through the durable runtime', () => {
  it.each(['gepa', 'random-search'])('persists shared research traces from %s without final-gate evidence', async (name) => {
    const { store, runner } = await fixture(30, { algorithm: { name, options: {} } })
    const result = await runner.run('run', new AbortController().signal)
    const bundle = await store.researchStore('run').load(result)
    const traces = result.decisions.flatMap(entry => entry.decision.research ?? [])
    expect(new Set(traces.map(record => record.kind))).toEqual(new Set(['scope', 'ranking', 'parents']))
    expect(JSON.stringify(bundle)).not.toContain('secret-held-out')
    expect(bundle.objects.filter(item => item.kind === 'candidate')).toHaveLength(2)
    const before = bundle.archive.digest
    result.heldOutEvidence = []; result.gate = { status: 'not_run', reason: 'no gate' }; result.championId = 'anchor'
    await store.write(result)
    expect((await store.researchStore('run').load(result)).archive.digest).toBe(before)
  })

  it.each(['task', 'candidate'])('rejects out-of-view research %s references before saving decisions or submitting work', async (outside) => {
    const { store, provider } = await fixture()
    const invalid: AlgorithmDriver = { async step(view, state) {
      return { state, reason: 'invalid annotation', operations: [{ kind: 'stop', candidate_id: null,
        parent_id: null, task_ids: [], scope: 'global', rationale: 'stop', payload: null }], research: [{
        kind: 'scope', scope: 'scope', task_ids: [outside === 'task' ? 'secret-held-out' : 'seed1'],
        candidate_ids: [outside === 'candidate' ? 'nonexistent' : 'anchor'], data: null,
      }] }
    } }
    await expect(new DurableRunner(store, invalid, provider, pythonObjective).run('run', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-algorithm-decision' })
    expect((await store.read('run')).decisions).toEqual([])
    expect(provider.calls).toHaveLength(0)
  })
  it('records zero new usage when the requested evaluation already has complete slots', async () => {
    const { store, provider } = await fixture()
    const repeated: AlgorithmDriver = { async step(view, state) {
      return { state, reason: 'repeat then stop', operations: [{
        kind: view.step_id < 2 ? 'evaluate_seed' : 'stop', candidate_id: 'anchor', parent_id: null,
        task_ids: ['seed1', 'seed2'], scope: 'global', rationale: 'same slots', payload: null,
      }] }
    } }
    const result = await new DurableRunner(store, repeated, provider, pythonObjective).run('run', new AbortController().signal)
    expect(provider.calls).toHaveLength(1)
    expect(result.physicalAttempts).toBe(2)
    expect(result.operations[1]?.receipt).toMatchObject({ physicalAttempts: 0, usage: {
      model_requests: 0, tokens: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, dollars: 0,
    } })
  })

  it.each([false, true])('does not reset the persisted decision limit on resume (terminal=%s)', async (terminal) => {
    const { store, provider } = await fixture()
    const journal = await store.read('run')
    // Materialize the prior decision history without issuing ten thousand fake calls.
    journal.decisions = Array.from({ length: 10_000 }, (_, stepId) => ({
      stepId, inputDigest: canonicalDigest(['prior', stepId]), operationIds: [],
      decision: { state: journal.state, reason: 'prior decision', operations: [{
        kind: terminal && stepId === 9_999 ? 'stop' as const : 'evaluate_seed' as const,
        candidate_id: 'anchor', parent_id: null, task_ids: ['seed1'], scope: 'global',
        rationale: 'prior decision', payload: null,
      }] },
    }))
    await store.write(journal)
    const checked: AlgorithmDriver = { async step() { throw new Error('A new decision must not run') } }
    const runner = new DurableRunner(store, checked, provider, pythonObjective)
    for (let attempt = 0; attempt < 2; attempt++) {
      const work = runner.run('run', new AbortController().signal)
      if (terminal) expect((await work).status).toBe('completed')
      else await expect(work).rejects.toMatchObject({ code: 'algorithm-step-limit' })
    }
    expect((await store.read('run')).decisions).toHaveLength(10_000)
    expect(provider.calls).toHaveLength(0)
  })

  it('stops a fully passing default objective before requesting model work', async () => {
    const { runner, provider } = await fixture(30, {
      objective: resolveProjectObjective({ objective: { metric: 'pass_rate' } }),
      objectiveIdentity: pythonObjective.identity,
    })
    provider.baselineScore = 1
    const result = await runner.run('run', new AbortController().signal)
    expect(result.status).toBe('completed')
    expect(result.championId).toBe('anchor')
    expect(provider.calls.map(call => call.operation.kind)).toEqual(['evaluate_seed'])
  })
  it('runs GEPA, isolates the final gate and commits champion exactly once', async () => {
    const { store, provider, runner } = await fixture(30, {
      objectiveIdentity: pythonObjective.identity,
      objective: resolveProjectObjective({ objective: { metric: 'pass_rate' }, protection: [
        { task_id: 'secret-held-out', partition: 'held_out', metric: 'pass_rate', rule: 'minimum', value: 1 },
      ] }),
    })
    const checked: AlgorithmDriver = { step(view, ...args) {
      expect(JSON.stringify(view)).not.toContain('secret-held-out')
      return driver.step(view, ...args)
    } }
    const result = await new DurableRunner(store, checked, provider, pythonObjective).run('run', new AbortController().signal)
    expect(result.gate.status).toBe('accepted')
    expect(result.physicalAttempts).toBe(6)
    expect(result.championId).toBe('r0-b0-candidate-0')
    const calls = provider.calls.length
    expect((await runner.run('run', new AbortController().signal)).digest).toBe(result.digest)
    expect(provider.calls).toHaveLength(calls)
  })
  it('reconciles lost replies without resetting the ledger or resubmitting', async () => {
    const { store, provider, runner } = await fixture()
    provider.loseReply = true
    await expect(runner.run('run', new AbortController().signal)).rejects.toThrow('reply lost')
    const saved = await store.read('run')
    expect(saved.operations[0]?.status).toBe('submitted')
    expect(saved.decisions).toHaveLength(1)
    const result = await runner.run('run', new AbortController().signal)
    expect(provider.calls.filter(call => call.operationId === saved.operations[0]!.request.operationId)).toHaveLength(1)
    expect(result.physicalAttempts).toBe(6)
  })
  it('retains unknown reservations and refuses an unaffordable final gate', async () => {
    const { store, provider, runner } = await fixture(4)
    provider.loseReply = true; provider.uncertain = true
    await expect(runner.run('run', new AbortController().signal)).rejects.toThrow('reply lost')
    await expect(runner.run('run', new AbortController().signal)).rejects.toThrow('Submission outcome remains unknown')
    expect(provider.calls).toHaveLength(1)
    provider.uncertain = false
    await expect(runner.run('run', new AbortController().signal)).rejects.toThrow('Insufficient physical trial budget')
    const saved = await store.read('run')
    expect(saved.operations.every(operation => operation.request.partition === 'seed')).toBe(true)
    expect(saved.physicalAttempts).toBe(4)
    expect(saved.championId).toBe('anchor')
  })
  it('cancels without issuing new side effects', async () => {
    const { store, provider, runner } = await fixture()
    await store.cancel('run')
    await expect(runner.run('run', new AbortController().signal)).rejects.toThrow('Cancellation requested')
    expect((await store.read('run')).status).toBe('cancelled')
    expect(provider.calls).toHaveLength(0)
  })
  it('interrupts a running provider and persists cancellation even when it has no reply', async () => {
    const { store, provider, runner } = await fixture()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    provider.submit = async (_request, signal) => {
      started()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    let cancelled = 0
    provider.cancel = async () => { cancelled++ }
    const work = runner.run('run', new AbortController().signal)
    const rejection = expect(work).rejects.toThrow('Cancellation requested')
    await ready; await store.cancel('run'); await rejection
    expect((await store.read('run')).status).toBe('cancelled')
    expect(cancelled).toBe(1)
  })
})

it('repairs seed and held-out failures within the same ledger before ranking and the final gate', async () => {
  const { store, provider } = await fixture()
  const submit = provider.submit.bind(provider)
  provider.submit = async (request, signal) => {
    const receipt = await submit(request, signal)
    if (!request.repair && request.operation.kind === 'evaluate_seed' &&
      (request.partition === 'seed' && request.operation.candidate_id === 'anchor' ||
       request.partition === 'held_out' && request.operation.candidate_id !== 'anchor')) {
      receipt.evidence[0]!.score = null
      receipt.evidence[0]!.status = 'environment_failed'
    }
    return receipt
  }
  const checked: AlgorithmDriver = { step(view, ...args) {
    expect(JSON.stringify(view)).not.toContain('secret-held-out')
    expect(view.evidence.every(cell => cell.score !== null)).toBe(true)
    return driver.step(view, ...args)
  } }
  const result = await new DurableRunner(store, checked, provider, pythonObjective).run('run', new AbortController().signal)
  expect(result.gate.status).toBe('accepted')
  expect(result.physicalAttempts).toBe(8)
  expect(provider.calls.filter(call => call.repair).map(call => call.partition)).toEqual(['seed', 'held_out'])
  expect(result.seedEvidence).toHaveLength(4)
  expect(result.heldOutEvidence).toHaveLength(2)
})

it('retains cancellation as recovery work until the provider confirms stopped execution', async () => {
  const { store, provider, runner } = await fixture()
  const ready = Promise.withResolvers<void>()
  provider.submit = async (request, signal) => {
    provider.calls.push(structuredClone(request)); ready.resolve()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  let cancellations = 0
  provider.cancel = async () => { if (++cancellations === 1) throw new Error('still stopping') }
  const first = expect(runner.run('run', new AbortController().signal)).rejects.toThrow('Cancellation requested')
  await ready.promise; await store.cancel('run'); await first
  const pending = await store.read('run')
  expect(pending.status).toBe('needs_recovery')
  expect(pending.failure).toMatchObject({ code: 'cancellation-unconfirmed', retryable: true })
  expect(pending.operations[0]!.status).toBe('submitted')
  await expect(runner.run('run', new AbortController().signal)).rejects.toThrow('Cancellation requested')
  const stopped = await store.read('run')
  expect(stopped.status).toBe('cancelled')
  expect(stopped.operations).toEqual(pending.operations)
  expect(stopped.physicalAttempts).toBe(pending.physicalAttempts)
  expect(provider.calls).toHaveLength(1)
  expect(cancellations).toBe(2)
})

it('does not replay a partially resumable provider that lacks idempotent submission', async () => {
  const { store, provider, runner } = await fixture()
  provider.capabilities.idempotentSubmission = false
  provider.loseReply = true
  await expect(runner.run('run', new AbortController().signal)).rejects.toThrow()
  const saved = await store.read('run')
  provider.inspect = async () => ({ state: 'resumable' })
  await expect(runner.run('run', new AbortController().signal)).rejects.toMatchObject({ code: 'operation-needs-recovery' })
  expect(provider.calls).toHaveLength(1)
  expect((await store.read('run')).operations).toEqual(saved.operations)
})
