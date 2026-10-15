import { GearError } from '../../domain/errors.js'
import { hitchPreparedArtifacts, type HitchArtifactPin } from './artifacts.js'
import { canonicalDigest } from '../../domain/canonical.js'

export interface HitchExecutionConditions {
  evalId: string
  taskIds: string[]
  controllerRuntimeId: string
  provider: string
  dataset: string
  harnessRef: string
  revisionIdentity: string
  model: string
  timeoutMs: number
  maxConcurrent: number
  agentArgs: string[]
  passEnv: string[]
  environmentBinding: string
  artifactPins: HitchArtifactPin[]
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function strings(value: unknown, expected: string[], unordered = false): boolean {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((item) => typeof item !== 'string')
  )
    return false
  const actual = unordered ? [...value].sort() : value
  const wanted = unordered ? [...expected].sort() : expected
  return actual.every((item, index) => item === wanted[index])
}

/** Verify executed request fields, not only the source revision named by a result.
 * Artifact pins are cross-checked separately; the resident environment binding must match. */
export function assertHitchExecutionConditions(
  inspection: Record<string, unknown>,
  expected: HitchExecutionConditions,
) {
  const plan = object(inspection.plan)
  const controller = object(plan?.controller_runtime)
  const execution = object(inspection.execution_plan)
  const request = object(inspection.request)
  const result = object(inspection.result)
  const candidate = object(result?.candidate)
  const resolution = object(inspection.resolution)
  if (
    !/^hmac-sha256:[a-f0-9]{64}$/u.test(expected.environmentBinding) ||
    controller?.runtime_id !== expected.controllerRuntimeId ||
    execution?.provider !== expected.provider ||
    inspection.schema_version !== '1' ||
    inspection.eval_id !== expected.evalId ||
    request?.schema_version !== '1' ||
    request.backend !== 'harbor' ||
    request.dataset !== expected.dataset ||
    request.harness_ref !== expected.harnessRef ||
    request.model !== expected.model ||
    request.environment_binding !== expected.environmentBinding ||
    !Array.isArray(request.artifact_pins) ||
    !expected.artifactPins.length ||
    canonicalDigest(request.artifact_pins) !== canonicalDigest(expected.artifactPins) ||
    request.attempts !== 1 ||
    request.max_concurrent !== expected.maxConcurrent ||
    request.infrastructure_retries !== 0 ||
    request.timeout_ms !== expected.timeoutMs ||
    !strings(request.agent_args, expected.agentArgs) ||
    !strings(request.pass_env, expected.passEnv, true) ||
    'local_inference' in request ||
    'training_binding' in request ||
    resolution?.identity !== expected.revisionIdentity ||
    result?.eval_id !== expected.evalId ||
    result.dataset !== expected.dataset ||
    candidate?.revision_identity !== expected.revisionIdentity ||
    candidate.model !== expected.model ||
    candidate.harness_id !== expected.harnessRef.split('@')[0] ||
    candidate.harness_ref !== expected.harnessRef ||
    candidate.requested_harness_ref !== expected.harnessRef ||
    'inference_id' in candidate ||
    'model_node' in candidate ||
    'training_binding' in candidate
  )
    throw new GearError(
      'hitch-result-identity',
      'Hitch execution conditions do not match the frozen model, runtime, dataset or request',
    )
  return hitchPreparedArtifacts(inspection, expected)
}
