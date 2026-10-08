import { setTimeout as delay } from 'node:timers/promises'
import { digestJson } from '../state/digest.js'
import { processTasks } from './contracts.js'
import { cellKey, plannedCells, profile, validOutcome } from './evidence.js'
import type { EvaluationRepairConfig, MissingEvaluationSlot, SearchProvider, SearchSettings, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from './types.js'

export const defaultEvaluationRepair: Required<EvaluationRepairConfig> = {
  maxAttempts: 3, backoffMs: [15000, 60000, 180000], jitterMs: 1000,
}
export function evaluationRepairPolicy(settings: SearchSettings): Required<EvaluationRepairConfig> {
  return { ...structuredClone(defaultEvaluationRepair), ...settings.search.evaluationStages.repair }
}
export function repairDelay(policy: Required<EvaluationRepairConfig>, originalRef: string, attempt: number): number {
  const base = policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)]!
  const jitter = parseInt(digestJson([originalRef, attempt]).slice(7, 15), 16) % (policy.jitterMs + 1)
  return base + jitter
}
/** Recheck the persisted due time in bounded slices, so restart never resets backoff. */
export async function waitForRepair(notBefore: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  while (Date.now() < notBefore) await delay(Math.min(30000, notBefore - Date.now()), undefined, { signal })
  signal.throwIfAborted()
}
export function evaluationProcessMode(plan: StageEvaluationPlan, settings: SearchSettings) {
  return plan.stage === 'baseline-probe' ? settings.search.process.mode : settings.promotion.process.mode
}
/** Validate full frozen coverage, never reinterpret missing cells as a smaller task scope. */
export function missingEvaluationSlots(universe: TaskUniverse, plan: StageEvaluationPlan, snapshot: Snapshot, result: StageResult,
  settings: SearchSettings, provider: SearchProvider): MissingEvaluationSlot[] {
  profile(universe, plan, snapshot, result, evaluationProcessMode(plan, settings))
  const promotionStage = ['bridge', 'global-seed', 'held-out'].includes(plan.stage)
  const guards = promotionStage ? settings.promotion.protectedTasks : settings.search.explorationGuards
  const processIds = new Set(universe.objective ? [] : processTasks(universe, evaluationProcessMode(plan, settings)))
  const requiredRaw = new Set([...universe.objective?.terms.filter(t => t.weight !== 0).map(t => t.metric) ?? [],
    ...universe.objective?.constraints.map(c => c.metric) ?? []])
  const missing: MissingEvaluationSlot[] = []
  for (const identity of plannedCells(universe, plan, snapshot)) {
    const cell = result.cells.find(c => cellKey(c.identity) === cellKey(identity))
    if (!cell || !validOutcome(cell)) {
      missing.push({ identity, channel: 'outcome', status: !cell || cell.status === 'missing' || cell.outcome.status === 'missing' ? 'missing' : 'invalid',
        repair: 'execution', reason: cell?.outcome && 'reason' in cell.outcome ? cell.outcome.reason : 'missing or uncertified execution slot' })
      continue
    }
    if (processIds.has(identity.taskId) && cell.process?.status !== 'available') missing.push({ identity, channel: 'process',
      status: cell.process?.status === 'invalid' ? 'invalid' : cell.process?.status === 'unsupported' || cell.process?.status === 'not-applicable' ? 'unsupported' : 'missing',
      repair: cell.process?.status !== 'unsupported' && cell.process?.status !== 'not-applicable' && (provider.completeEvidence || provider.completeProcess) ? 'projection' : 'unsupported',
      reason: cell.process && 'reason' in cell.process ? cell.process.reason : 'missing process projection' })
    const rawIds = new Set(requiredRaw)
    if (universe.objective) for (const guard of guards.filter(g => g.partition === universe.partition && g.taskId === identity.taskId)) rawIds.add(guard.rule === 'must-pass' ? 'pass_rate' : guard.metric!)
    for (const id of rawIds) {
      const metric = cell.rawMetrics?.metrics[id]
      if (metric?.status === 'available') continue
      const contract = universe.rawMetricContracts?.find(c => c.id === id)
      missing.push({ identity, channel: 'raw-metric', metric: id, status: metric?.status ?? 'missing',
        repair: provider.completeEvidence && contract?.granularity === 'trial' && metric?.status !== 'unsupported' ? 'projection' : 'unsupported',
        reason: metric?.reason ?? `missing raw metric ${id}` })
    }
    if (promotionStage) for (const guard of settings.promotion.protectedAssertions.filter(g => g.partition === universe.partition && g.taskId === identity.taskId)) {
      if (cell.assertions?.some(a => a.id === guard.assertionId)) continue
      missing.push({ identity, channel: 'assertion', assertionId: guard.assertionId, status: 'missing',
        repair: provider.completeEvidence ? 'projection' : 'unsupported', reason: `missing protected assertion ${guard.assertionId}` })
    }
  }
  return missing
}
