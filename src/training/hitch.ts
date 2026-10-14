import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { digestJson } from './digest.js'
import { matchesHarnessRef } from './harness.js'
import { publicEndpointBinding, validateReadyEndpointBinding } from './endpoint-binding.js'
import { datasetDestination } from './snapshots.js'
import { modelEvidenceKey, validateModelEvidence } from './evaluation.js'
import { jsonProcess } from './process.js'
import { TrainingContractError, requireContract } from './schema.js'
import { atomicWrite, TrainingContentStore, withTrainingFileLock } from './store.js'
import { controlEvaluation, type OrderedEvaluationControl } from './hitch-control.js'
import type { ContentRef, EndpointModelEvaluationEvidence, EvaluationUsage, ModelEvaluationEvidence, ModelEvaluationRequest, ModelEvaluator, TrainingControlIntent } from './types.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => { requireContract(!!value && typeof value === 'object' && !Array.isArray(value), 'invalid-hitch-evidence', 'expected structured Hitch evidence'); return value as Json }
const array = (value: unknown): unknown[] => { requireContract(Array.isArray(value), 'invalid-hitch-evidence', 'expected an evidence array'); return value }
const string = (value: unknown): string => { requireContract(typeof value === 'string' && value.length > 0, 'invalid-hitch-evidence', 'expected an evidence identity'); return value }
const unknownGpuUsage = (): EvaluationUsage => ({ gpuSeconds: null, gpuSecondsSource: null })

export interface HitchModelEvaluatorOptions {
  command: string[]
  root: string
  workspace: string
  harnessSourceDirectory: string
  /** Dataset materialization only; no model runtime is loaded by evaluation. */
  python: string[]
  executionProvider?: string
  budgets: { timeoutSeconds: number; setupTimeoutSeconds: number; maxConcurrent: number; maxEpisodeSteps: 16; infrastructureRetries: 0; maxRepairRounds: number }
}
interface EvalJournal {
  key: string; requestDigest: string; startedAt: number; evalId?: string; submitted?: boolean; evidence?: EndpointModelEvaluationEvidence
  repairRounds?: number; repair?: { id: string; pending: boolean }; retainedTrials?: ModelEvaluationEvidence['trials']
}

/** An evaluator owns task requests, never the endpoint or its physical resources. */
export class HitchModelEvaluator implements ModelEvaluator {
  constructor(readonly store: TrainingContentStore, readonly options: HitchModelEvaluatorOptions) {
    const b = options.budgets
    requireContract(Number.isSafeInteger(b.maxConcurrent) && b.maxConcurrent >= 1 && b.maxConcurrent <= 1024 && b.maxEpisodeSteps === 16 && b.infrastructureRetries === 0
      && Number.isSafeInteger(b.timeoutSeconds) && b.timeoutSeconds > 0 && Number.isSafeInteger(b.setupTimeoutSeconds) && b.setupTimeoutSeconds > 0
      && Number.isSafeInteger(b.maxRepairRounds) && b.maxRepairRounds >= 0 && b.maxRepairRounds <= 32,
    'invalid-evaluation-budgets', 'evaluation requires fixed positive timeouts, bounded trial concurrency, 16 steps and no hidden retries')
  }
  private call(args: string[], timeout = 60_000): Promise<unknown> { return jsonProcess(this.options.command, ['--root', this.options.root, ...args], undefined, timeout) }
  private directory(key: string): string { return join(this.options.workspace, 'evaluations', digestJson(key).slice(7)) }
  private async materialize(ref: ContentRef): Promise<string> {
    const destination = join(this.options.workspace, 'datasets', ref.digest.slice(7))
    await jsonProcess(this.options.python, ['-m', 'gear.training.cli.artifacts', 'materialize', '--store-root', this.store.root], { ref, destination }, 3_600_000)
    return datasetDestination(await this.store.readJson(ref), destination)
  }
  private assertJournal(journal: EvalJournal, request: ModelEvaluationRequest): void {
    requireContract(journal.requestDigest === digestJson(request) && journal.key === modelEvidenceKey({ subject: request.subject, condition: request.condition }),
      'evaluation-idempotency-conflict', 'evaluation request differs from the frozen binding, subject or conditions')
  }
  private usage(result?: Json, startedAt?: number): EvaluationUsage {
    const usage: EvaluationUsage = unknownGpuUsage()
    if (startedAt !== undefined) usage.elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000)
    if (!result?.usage) return usage
    const upstream = object(result.usage)
    requireContract(typeof upstream.source === 'string' && upstream.source.length > 0, 'invalid-evaluation-usage', 'token and request usage needs its collection source')
    usage.usageSource = upstream.source
    for (const [wire, key] of [['requests', 'requests'], ['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens']] as const) {
      if (upstream[wire] === undefined) continue
      requireContract(Number.isSafeInteger(upstream[wire]) && Number(upstream[wire]) >= 0, 'invalid-evaluation-usage', 'Hitch returned invalid request or token usage')
      usage[key] = Number(upstream[wire])
    }
    return usage
  }
  async observeUsage(request: ModelEvaluationRequest, key: string): Promise<EvaluationUsage> {
    return withTrainingFileLock(join(this.directory(key), 'operation.lock'), async () => {
      let journal: EvalJournal
      try { journal = JSON.parse(await readFile(join(this.directory(key), 'state.json'), 'utf8')) as EvalJournal }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unknownGpuUsage(); throw error }
      this.assertJournal(journal, request)
      if (journal.evidence) {
        const { gpuSeconds, gpuSecondsSource, usageSource, inputTokens, outputTokens, requests, elapsedSeconds } = journal.evidence
        return { gpuSeconds, gpuSecondsSource, ...(usageSource !== undefined ? { usageSource } : {}), ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}), ...(requests !== undefined ? { requests } : {}), ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}) }
      }
      if (!journal.submitted || !journal.evalId) return unknownGpuUsage()
      const inspection = object(await this.call(['eval', 'inspect', journal.evalId, '--json']))
      return this.usage(inspection.result ? object(inspection.result) : undefined, journal.startedAt)
    })
  }
  async cancel(request: ModelEvaluationRequest, key: string, intent: TrainingControlIntent = { schemaVersion: 2, sequence: 1, action: 'pause' }): Promise<EvaluationUsage & { tasksCompleted: boolean }> {
    requireContract(intent.action === 'pause', 'invalid-evaluation-control', 'cancel requires a pause intent')
    // Fence daemon admission before waiting for a concurrent materializer's lock.
    await controlEvaluation(this.options.workspace, request, key, intent, args => this.call(args))
    return withTrainingFileLock(join(this.directory(key), 'operation.lock'), async () => {
      const control = await controlEvaluation(this.options.workspace, request, key, intent, args => this.call(args))
      const path = join(this.directory(key), 'state.json')
      let journal: EvalJournal
      try { journal = JSON.parse(await readFile(path, 'utf8')) as EvalJournal }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        requireContract(!control.state.submitted, 'evaluation-journal-missing', 'an admitted evaluation needs its original task journal')
        return { ...unknownGpuUsage(), tasksCompleted: !control.state.pending_reruns }
      }
      this.assertJournal(journal, request)
      requireContract(!journal.evalId || journal.evalId === control.state.eval_id, 'evaluation-control-drift', 'cancellation returned another eval identity')
      requireContract(control.state.submitted || !journal.submitted, 'evaluation-control-drift', 'an admitted evaluation disappeared from the daemon index')
      journal.evalId = control.state.eval_id; journal.submitted = control.state.submitted
      if (journal.repair?.pending && !control.state.pending_reruns) { journal.repair.pending = false; delete journal.evidence }
      await atomicWrite(path, journal)
      if (!journal.submitted) return { ...unknownGpuUsage(), tasksCompleted: !control.state.pending_reruns }
      const inspection = object(await this.call(['eval', 'inspect', journal.evalId, '--json']))
      const result = inspection.result ? object(inspection.result) : undefined
      return { ...this.usage(result, journal.startedAt), tasksCompleted: !control.state.pending_reruns && result?.task_completed === true
        && !['running', 'cancelling'].includes(String(object(inspection.control).state)) }
    })
  }
  async evaluate(request: ModelEvaluationRequest, key: string, intent: TrainingControlIntent = { schemaVersion: 2, sequence: 0, action: 'start' }): Promise<ModelEvaluationEvidence> {
    requireContract(request.schemaVersion === 2 && request.harnessAdapter === 'training-tool', 'unsupported-evaluation-harness', 'endpoint candidate evaluation currently requires training-tool')
    validateReadyEndpointBinding(request.endpointBinding, request.model, { ...request.condition, attempts: Math.max(...request.condition.slots.map(slot => slot.attempt)) }, [request.endpointBinding.deployment_receipt.source])
    requireContract(request.subject.weightsDigest === request.model.weightsDigest, 'evaluation-subject-drift', 'evaluation subject differs from its immutable model')
    requireContract(intent.action === 'start', 'invalid-evaluation-control', 'evaluate requires a start intent')
    requireContract(digestJson(this.options.budgets) === request.condition.budgetsDigest, 'evaluation-budget-drift', 'evaluation budgets differ from frozen conditions')
    return withTrainingFileLock(join(this.directory(key), 'operation.lock'), async () => {
      const control = await controlEvaluation(this.options.workspace, request, key, intent, args => this.call(args))
      return this.evaluatePass(request, key, control)
    })
  }
  private async evaluatePass(request: ModelEvaluationRequest, idempotencyKey: string, control: OrderedEvaluationControl): Promise<EndpointModelEvaluationEvidence> {
    const key = modelEvidenceKey({ subject: request.subject, condition: request.condition })
    const path = join(this.directory(idempotencyKey), 'state.json')
    let journal: EvalJournal
    try { journal = JSON.parse(await readFile(path, 'utf8')) as EvalJournal }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      journal = { key, requestDigest: digestJson(request), startedAt: Date.now() }
    }
    this.assertJournal(journal, request)
    requireContract(!journal.evalId || journal.evalId === control.state.eval_id, 'evaluation-control-drift', 'ordered start returned another eval identity')
    requireContract(control.state.submitted || !journal.submitted, 'evaluation-control-drift', 'an admitted evaluation disappeared from the daemon index')
    journal.evalId = control.state.eval_id; journal.submitted = control.state.submitted
    await atomicWrite(path, journal)
    if (journal.evidence) {
      if (journal.evidence.complete || ((journal.repairRounds ?? 0) >= this.options.budgets.maxRepairRounds && !journal.repair?.pending)) return validateModelEvidence(journal.evidence, request) as EndpointModelEvaluationEvidence
      if (!journal.repair?.pending) {
        journal.repairRounds = (journal.repairRounds ?? 0) + 1
        journal.repair = { id: `rerun_${digestJson([key, journal.repairRounds]).slice(7, 39)}`, pending: true }
        journal.retainedTrials = journal.evidence.trials.filter(trial => trial.valid)
        await atomicWrite(path, journal)
      }
      try { await this.call(['eval', 'rerun', journal.evalId, '--invalid', '--daemon', '--rerun-id', journal.repair.id, '--control-file', control.file], 5_000) }
      catch (error) {
        if (error instanceof TrainingContractError && error.code === 'process-timeout') throw new TrainingContractError('evaluation-pending', 'Hitch repair is still running')
        throw error
      }
      journal.repair.pending = false; delete journal.evidence
      await atomicWrite(path, journal)
    }
    const harnessRef = `${request.harnessAdapter}@git+${pathToFileURL(this.options.harnessSourceDirectory).href}#${request.harnessCommit}`
    const dataset = await this.materialize(request.datasetRef)
    const binding = publicEndpointBinding(request.endpointBinding)
    const bindingFile = join(this.directory(idempotencyKey), 'endpoint-binding.json')
    await atomicWrite(bindingFile, request.endpointBinding)
    if (!journal.submitted) {
      const accepted = object(await this.call(['eval', 'submit', '--dataset', dataset, '--harness', harnessRef,
        '--model', binding.endpoint_ref, '--model-binding-file', bindingFile,
        '--attempts', String(Math.max(...request.condition.slots.map(slot => slot.attempt))), '--max-concurrent', String(this.options.budgets.maxConcurrent), '--infrastructure-retries', '0',
        '--provider', this.options.executionProvider ?? 'local-docker', '--model-capture', 'proxy', '--require-model-capture',
        '--timeout', `${this.options.budgets.timeoutSeconds}s`, '--setup-timeout', `${this.options.budgets.setupTimeoutSeconds}s`, '--control-file', control.file]))
      requireContract(accepted.eval_id === control.state.eval_id, 'evaluation-control-drift', 'submission changed the reserved eval identity')
      journal.submitted = true
      await atomicWrite(path, journal)
    }
    const inspection = object(await this.call(['eval', 'inspect', journal.evalId, '--json']))
    if (!inspection.result) throw new TrainingContractError('evaluation-pending', `Hitch evaluation ${journal.evalId} is still running`)
    const actualRequest = object(inspection.request), result = object(inspection.result)
    requireContract(actualRequest.model === binding.endpoint_ref && actualRequest.harness_ref === harnessRef && actualRequest.dataset === dataset
      && actualRequest.timeout_ms === this.options.budgets.timeoutSeconds * 1000 && actualRequest.max_concurrent === this.options.budgets.maxConcurrent
      && actualRequest.infrastructure_retries === 0 && digestJson(actualRequest.endpoint_binding) === digestJson(binding),
    'hitch-evaluation-request-drift', 'Hitch changed the frozen evaluation request or binding')
    if (inspection.plan == null && result.status === 'failed' && result.failure_stage === 'preparing') {
      const error = object(result.error)
      requireContract(typeof error.code === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(error.code), 'invalid-hitch-evidence', 'Hitch preparation failure needs a bounded code')
      throw new TrainingContractError('hitch-evaluation-preparation-failed', `Hitch evaluation ${journal.evalId} preparation failed (${error.code}); inspect retained diagnostics`)
    }
    requireContract(result.task_completed === true, 'evaluation-pending', 'waiting for Hitch task requests to terminate')
    requireContract(digestJson(object(object(inspection.plan).candidate).endpoint_binding) === digestJson(binding)
      && digestJson(result.endpoint_binding) === digestJson(binding), 'hitch-endpoint-drift', 'canonical evaluation changed its frozen endpoint')
    const frozenHarness = object(object(await this.store.readJson(request.subject.harnessRef)).hitch)
    await this.store.readBytes(request.verifierRef)
    const trials: EndpointModelEvaluationEvidence['trials'] = []
    for (const item of array(result.trials)) {
      const trial = object(item)
      if (typeof trial.run_id !== 'string') continue
      const runId = string(trial.run_id), taskId = string(trial.task_id), attempt = Number(trial.attempt)
      const slot = request.condition.slots.find(value => value.taskId === taskId && value.attempt === attempt)
      requireContract(slot, 'unexpected-evaluation-slot', 'Hitch returned an unselected task or attempt')
      const loaded = object(await this.call(['runs', 'inspect', runId, '--json']))
      requireContract(loaded.record_status === 'valid' && loaded.trajectory_status !== 'corrupt', 'corrupt-evaluation-run', 'canonical run integrity failed')
      const record = object(loaded.record), context = object(record.context), parent = object(record.parent), model = object(record.model)
      const harness = object(record.harness), protocol = object(record.protocol)
      const task = request.datasetTasks.find(value => value.id === taskId)
      requireContract(task && task.environmentRef.digest === slot.environmentDigest, 'environment-descriptor-drift', 'slot environment identity differs')
      const environment = object(await this.store.readJson(task.environmentRef))
      requireContract(record.run_id === runId && parent.eval_id === journal.evalId && parent.attempt === attempt
        && context.kind === 'benchmark_task' && context.task_id === taskId && context.task_digest === environment.taskDigest
        && context.verifier_identity === environment.verifierIdentity && protocol.environment_identity === environment.hitchEnvironmentIdentity
        && model.provider === 'external-endpoint' && model.effective_id === binding.wire_model && model.requested_id === binding.endpoint_ref
        && digestJson(model.endpoint_binding) === digestJson(binding)
        && harness.harness_id === frozenHarness.harnessId && harness.revision_identity === frozenHarness.revisionIdentity
        && harness.artifact_id === frozenHarness.artifactId && matchesHarnessRef(harness.requested_ref, harnessRef, request.harnessAdapter, request.harnessCommit),
      'canonical-evaluation-identity-drift', 'canonical run differs from the sealed task, verifier, environment, harness or endpoint')
      const evidence = object(await this.call(['verifier', 'inspect', runId, '--json'])), observation = object(record.observation ?? {})
      const valid = trial.observation_status === 'valid' && observation.status === 'valid'
        && object(evidence.verifier).status === 'complete' && observation.reward === trial.reward
      trials.push({ taskId, attempt, runId, valid, ...(valid ? { reward: Number(trial.reward) } : {}), inferenceError: !valid })
    }
    const evidence: EndpointModelEvaluationEvidence = { schemaVersion: 2, evalId: journal.evalId, subject: request.subject, condition: request.condition,
      evidenceKey: key, endpointBinding: binding, trials, complete: trials.length === request.condition.slots.length && trials.every(trial => trial.valid),
      ...this.usage(result, journal.startedAt) }
    for (const retained of journal.retainedTrials ?? []) requireContract(trials.some(trial => digestJson(trial) === digestJson(retained)), 'valid-slot-rerun', 'repair changed a valid observation')
    journal.evidence = validateModelEvidence(evidence, request) as EndpointModelEvaluationEvidence
    await atomicWrite(path, journal)
    return journal.evidence
  }
}
