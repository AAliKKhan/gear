import { builtinPolicy } from '../adapters/python/builtin-policy.js'
import { digestJson } from './digest.js'
import { publicEndpointBinding } from './endpoint-binding.js'
import { parseModelEvaluationEvidence, requireContract } from './schema.js'
import type { ContentRef, ModelDecision, ModelEvaluationCondition, ModelEvaluationEvidence, ModelEvaluationRequest, ModelTrainingSpec, ModelVersion, PairedModelReport, ReadyEvaluationEndpointBinding } from './types.js'

export function modelEvaluationRequest(spec: ModelTrainingSpec, model: ModelVersion, modelRef: ContentRef, partition: 'dev' | 'held-out', binding: ReadyEvaluationEndpointBinding): ModelEvaluationRequest {
  const dataset = partition === 'dev' ? spec.datasets.dev : spec.datasets.heldOut
  const common = spec.evaluation.common
  const condition: ModelEvaluationCondition = {
    schemaVersion: 2, partition, datasetDigest: dataset.snapshotRef.digest,
    slots: dataset.tasks.flatMap(task => Array.from({ length: common.attempts }, (_, i) => ({ taskId: task.id, attempt: i + 1, environmentDigest: task.environmentRef.digest }))),
    verifierDigest: spec.verifier.digest, budgetsDigest: common.budgetsDigest, samplingDigest: common.samplingDigest,
    runtimeDigest: common.runtimeDigest, protocolDigest: common.protocolDigest, tokenizerDigest: model.tokenizerDigest,
    chatTemplateDigest: model.chatTemplateDigest, architecture: model.architecture, dtype: model.dtype,
    endpointApi: binding.api,
    ...(spec.schemaVersion === 2 ? { taskExecutionDigest: digestJson(spec.deployment.taskExecution) } : {}),
  }
  return { schemaVersion: 2, endpointBinding: structuredClone(binding), subject: { harnessRef: spec.fixedHarness.manifestRef, modelVersionRef: modelRef, weightsDigest: model.weightsDigest },
    model, condition, datasetRef: dataset.snapshotRef, harnessCommit: spec.fixedHarness.commit, harnessAdapter: spec.fixedHarness.adapter,
    datasetTasks: dataset.tasks, verifierRef: spec.verifier }
}
export const modelEvidenceKey = (request: Pick<ModelEvaluationRequest, 'subject' | 'condition'>): string => digestJson(request)
const slotKey = (slot: { taskId: string; attempt: number }): string => JSON.stringify([slot.taskId, slot.attempt])

export function validateModelEvidence(value: unknown, request?: ModelEvaluationRequest): ModelEvaluationEvidence {
  const e = parseModelEvaluationEvidence(value)
  requireContract(e.evidenceKey === modelEvidenceKey({ subject: e.subject, condition: e.condition }), 'invalid-evidence-key', 'evaluation evidence identity mismatch')
  if (request) {
    requireContract(e.evidenceKey === modelEvidenceKey({ subject: request.subject, condition: request.condition }), 'evaluation-drift', 'evaluation does not match the frozen subject and common conditions')
    requireContract(e.schemaVersion === 2 && digestJson(e.endpointBinding) === digestJson(publicEndpointBinding(request.endpointBinding)),
      'evaluation-binding-drift', 'evaluation did not use its frozen endpoint revision, deployment receipt and generation')
  }
  const slots = new Set(e.condition.slots.map(slotKey))
  requireContract(slots.size === e.condition.slots.length, 'duplicate-eval-slot', 'evaluation condition has duplicate slots')
  const seen = new Set<string>(); const runs = new Set<string>()
  for (const t of e.trials) {
    const key = slotKey(t)
    requireContract(slots.has(key) && !seen.has(key) && !runs.has(t.runId), 'invalid-eval-slot', 'evidence has a duplicate or unexpected slot / run')
    seen.add(key); runs.add(t.runId)
    requireContract(!t.valid || (t.reward !== undefined && !t.inferenceError), 'invalid-eval-reward', 'valid trial needs a finite verifier reward and no inference error')
  }
  requireContract(e.complete === (seen.size === slots.size && e.trials.every(t => t.valid)), 'invalid-completeness', 'evaluation completeness does not match its slots')
  return e
}

/** A weight-only comparison uses an explicit common-condition allowlist. */
export function pairModelEvidence(beforeInput: ModelEvaluationEvidence, afterInput: ModelEvaluationEvidence): PairedModelReport {
  const before = validateModelEvidence(beforeInput); const after = validateModelEvidence(afterInput)
  requireContract(before.complete && after.complete, 'incomplete-evaluation', 'promotion requires every fixed evaluation slot')
  requireContract(digestJson(before.condition) === digestJson(after.condition)
    && before.subject.harnessRef.digest === after.subject.harnessRef.digest, 'unpaired-model-evaluation', 'model comparisons may change weights only; harness and all common conditions must match')
  const originals = new Map(before.trials.map(t => [slotKey(t), t]))
  return builtinPolicy<PairedModelReport>('training_pair', {
    partition: after.condition.partition,
    pairs: after.trials.map(trial => ({ taskId: trial.taskId,
      baselineReward: originals.get(slotKey(trial))!.reward!, candidateReward: trial.reward! })),
    inference_errors: after.trials.filter(trial => trial.inferenceError).length,
    slot_count: after.condition.slots.length,
  })
}

export function devGate(spec: ModelTrainingSpec, dev: PairedModelReport): string[] {
  return builtinPolicy<string[]>('training_dev_gate', { policy: spec.evaluation.policy, dev })
}
export function decideModel(spec: ModelTrainingSpec, dev: PairedModelReport, heldOut: PairedModelReport): ModelDecision {
  return builtinPolicy<ModelDecision>('training_decide', { policy: spec.evaluation.policy, dev, heldOut })
}
