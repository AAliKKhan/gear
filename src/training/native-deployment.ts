import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { digestJson } from './digest.js'
import { parseEndpointBinding } from './endpoint-binding.js'
import { parseNativeDeploymentProfile, type NativeDeploymentProfile } from './native-deployment-profile.js'
import { requireContract, TrainingContractError } from './schema.js'
import { atomicWrite, withTrainingFileLock, type TrainingContentStore } from './store.js'
import { ModelNodeTransport, snapshotFileEntries } from './transport.js'
import type * as T from './types.js'

interface NativeIntent {
  intentDigest: string; modelRef: T.ContentRef; snapshotRef: T.ContentRef; runId: string | null
  incarnation: string; wireModel: string; authKey: string; attempt: number
  createdAt: string; startupDeadlineAt: string; hardDeadlineAt: string
}
interface IntentRecord {
  intent: NativeIntent
  status: 'preparing' | 'ready' | 'draining' | 'released' | 'blocked'
  binding?: T.ReadyEvaluationEndpointBinding
  failure?: string
  consumers: Record<string, { consumer: T.EndpointConsumer; acquiredAt: string; releasedAt?: string }>
  deploymentObserved?: boolean
}
interface NativeState {
  schemaVersion: 1; profileDigest: string; owner: string
  control?: { sequence: number; action: 'start' | 'pause' }
  intents: Record<string, IntentRecord>
  ownershipReleased?: boolean
  history?: Record<string, IntentRecord>
}
interface Observation {
  status: string; verified?: boolean; released?: boolean; incarnation?: string; wireModel?: string
  intentDigest?: string; snapshotRef?: T.ContentRef; processState?: string; failure?: string | null
  deathProven?: boolean
}

export interface ManagedNativeEndpointOptions {
  transport: ModelNodeTransport
  /** The real Hitch verifier must exercise text, SSE and a complete tool return. */
  verifyEndpoint(binding: T.ReadyEvaluationEndpointBinding, timeoutMs: number): Promise<void>
  /** Actual frozen training placement, supplied by the controller for this node. */
  trainingGpuUuids?: string[]
  store?: TrainingContentStore
  sourceTransport?: ModelNodeTransport
}

/** Coordinates finite native commands; Supervisor alone owns the service process. */
export class ManagedNativeEndpointPreparer implements T.ModelEndpointPreparer {
  readonly mode = 'managed-native' as const
  readonly profile: NativeDeploymentProfile
  readonly configurationDigest: string
  readonly trustedReceiptSources: string[]
  readonly maxRuntimeSeconds: number
  constructor(profile: NativeDeploymentProfile, readonly options: ManagedNativeEndpointOptions) {
    this.profile = parseNativeDeploymentProfile(profile)
    this.configurationDigest = digestJson(this.profile)
    this.trustedReceiptSources = [`gear-managed-native:${this.configurationDigest}`]
    this.maxRuntimeSeconds = this.profile.maxRuntimeSeconds
    requireContract(digestJson(options.transport.identity) === digestJson(this.profile.node), 'native-node-drift', 'native deployment transport must use the frozen evaluation node identity')
    requireContract(typeof options.verifyEndpoint === 'function', 'native-verifier-required', 'managed native readiness requires the real Hitch capability verifier')
    if (options.trainingGpuUuids) requireContract(digestJson([...options.trainingGpuUuids].sort()) === digestJson([...this.profile.trainingGpuUuids].sort())
      && this.profile.gpuUuids.every(gpu => !options.trainingGpuUuids!.includes(gpu)),
    'native-training-placement-drift', 'profile reserved training GPUs differ from the frozen training devices on this node')
    requireContract(this.profile.endpoint.localPort !== options.transport.connection.gateway.localPort
      && this.profile.endpoint.nodePort !== options.transport.connection.gateway.nodePort,
    'endpoint-route-conflict', 'ordinary evaluation uses a separate route from the training gateway')
    if (options.transport.connection.transport.type === 'local') requireContract(this.profile.endpoint.localPort === this.profile.endpoint.nodePort,
      'endpoint-route-drift', 'a local native endpoint uses the same local and node port')
  }
  private directory(context: T.EndpointPreparationContext): string {
    requireContract(!!context && typeof context.experimentId === 'string' && !!context.experimentId && isAbsolute(context.controllerDirectory)
      && Number.isSafeInteger(context.controlSequence) && context.controlSequence >= 0 && ['start', 'pause'].includes(context.action)
      && Number.isFinite(Date.parse(context.deadlineAt)), 'invalid-native-context', 'native deployment requires a persisted owner, ordered action and original absolute deadline')
    return join(context.controllerDirectory, 'native-deployments', this.configurationDigest.slice(7))
  }
  private async state<R>(context: T.EndpointPreparationContext, mutate: (state: NativeState) => R): Promise<R> {
    const path = join(this.directory(context), 'state.json')
    return withTrainingFileLock(path + '.lock', async () => {
      let state: NativeState
      try { state = JSON.parse(await readFile(path, 'utf8')) as NativeState }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        state = { schemaVersion: 1, profileDigest: this.configurationDigest, owner: context.experimentId, intents: {} }
      }
      requireContract(state.schemaVersion === 1 && state.profileDigest === this.configurationDigest && state.owner === context.experimentId,
        'native-state-drift', 'private native deployment records belong to another profile or experiment')
      const result = mutate(state)
      await atomicWrite(path, state)
      return structuredClone(result)
    })
  }
  private async order(context: T.EndpointPreparationContext, start: boolean): Promise<void> {
    await this.state(context, state => {
      requireContract(!state.control || context.controlSequence >= state.control.sequence, 'deployment-fenced', 'a newer native control intent is already persisted')
      requireContract(!state.control || state.control.sequence !== context.controlSequence || state.control.action === context.action,
        'deployment-control-conflict', 'native control sequence already has another action')
      requireContract(!start || !state.ownershipReleased && context.action === 'start' && Date.parse(context.deadlineAt) > Date.now(),
        'deployment-fenced', 'paused or expired native deployment cannot create work')
      state.control = { sequence: context.controlSequence, action: context.action }
    })
  }
  private payload(context: T.EndpointPreparationContext): Record<string, unknown> {
    return { profileRef: this.profile.name, profileDigest: this.configurationDigest, owner: context.experimentId,
      control: { sequence: context.controlSequence, action: context.action }, deadlineAt: context.deadlineAt }
  }
  private async call(context: T.EndpointPreparationContext, action: string, extra: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const createsWork = ['ensure', 'ready', 'acquireConsumer'].includes(action)
    return this.options.transport.call(`deployment.${action}`, { ...this.payload(context), ...extra }, undefined,
      Math.max(1, Math.min(timeoutMs ?? 60_000, createsWork ? Date.parse(context.deadlineAt) - Date.now() : Infinity)))
  }
  async fence(context: T.EndpointPreparationContext): Promise<void> {
    await this.order(context, false) // Save before any remote side effect.
    await this.call(context, 'fence', {})
  }
  private target(binding: T.ReadyEvaluationEndpointBinding): { intentDigest: string; incarnation: string } {
    requireContract(this.trustedReceiptSources.includes(binding.deployment_receipt.source), 'deployment-owner-conflict', 'native lifecycle cannot operate on an external endpoint')
    const match = /^native\/(sha256:[a-f0-9]{64})\/([a-f0-9]{32})$/.exec(binding.deployment_receipt.deployment_ref)
    requireContract(match, 'deployment-owner-conflict', 'native binding lacks its original deployment identity')
    return { intentDigest: match[1]!, incarnation: match[2]! }
  }
  private restoreAuth(record: IntentRecord): void { process.env[this.authName(record.intent)] = record.intent.authKey }
  private findRecord(state: NativeState, target: { intentDigest: string; incarnation: string }): IntentRecord | undefined {
    const current = state.intents[target.intentDigest]
    return current?.intent.incarnation === target.incarnation ? current : state.history?.[target.incarnation]
  }
  private authName(intent: NativeIntent): string { return `GEAR_NATIVE_${intent.incarnation.toUpperCase()}` }
  private async binding(intent: NativeIntent, context: T.EndpointPreparationContext): Promise<T.ReadyEvaluationEndpointBinding> {
    const e = this.profile.endpoint
    const base_url = (await this.options.transport.endpointRoute(context.controllerDirectory,
      { nodePort: e.nodePort, localPort: e.localPort, incarnation: intent.incarnation })) + '/v1'
    const auth = { kind: 'env' as const, name: this.authName(intent) }
    process.env[auth.name] = intent.authKey
    const endpoint_revision = digestJson({ schema_version: '1', base_url, wire_model: intent.wireModel, api: e.api, auth, capabilities: e.capabilities })
    return parseEndpointBinding({ schema_version: '1', kind: 'external-endpoint', endpoint_ref: `endpoint/native-${intent.incarnation}`,
      endpoint_revision, api: e.api, wire_model: intent.wireModel, capabilities: e.capabilities, generation: e.generation,
      deployment_receipt: { schema_version: '1', model_digest: intent.snapshotRef.digest, wire_model: intent.wireModel,
        deployment_ref: `native/${intent.intentDigest}/${intent.incarnation}`, source: this.trustedReceiptSources[0], service_config: e.serviceConfig },
      connection: { base_url, auth } }, true) as T.ReadyEvaluationEndpointBinding
  }
  private async observeRecord(record: IntentRecord, context: T.EndpointPreparationContext): Promise<Observation> {
    return this.call(context, 'observe', { intentDigest: record.intent.intentDigest, incarnation: record.intent.incarnation },
      60_000) as Promise<Observation>
  }
  private async ensureArtifacts(record: IntentRecord): Promise<void> {
    const store = this.options.store
    if (!store) return // Programmatic callers may pre-provision the pinned node CAS.
    const remaining = (): number => {
      const ms = Date.parse(record.intent.startupDeadlineAt) - Date.now()
      requireContract(ms > 0, 'deployment-startup-timeout', 'snapshot transfer exhausted its original startup deadline')
      return ms
    }
    const bounded = (transport: ModelNodeTransport): ModelNodeTransport => new ModelNodeTransport(transport.connection, transport.identity, remaining(), remaining())
    const target = this.options.transport, source = this.options.sourceTransport
    const present = await bounded(target).call('cas.stat', { digest: record.intent.snapshotRef.digest }) as { present: boolean }
    if (present.present && source && digestJson(source.identity) === digestJson(target.identity)) return
    try { await store.verifyFile(record.intent.snapshotRef) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !source) throw error
      await bounded(source).download(store, record.intent.snapshotRef)
    }
    const files = snapshotFileEntries(await store.readJson(record.intent.snapshotRef))
    requireContract(files, 'invalid-hf-snapshot', 'native deployment requires the existing immutable HF file manifest')
    // The existing transfer verifies exact size/hash and publishes only complete
    // objects. JSON model configs remain opaque, never extra traversal roots.
    for (const item of [{ contentRef: record.intent.snapshotRef, size: undefined }, ...files]) {
      const observed = await bounded(target).call('cas.stat', { digest: item.contentRef.digest }) as { present: boolean; size?: number }
      if (observed.present) {
        requireContract(item.size === undefined || observed.size === item.size, 'content-size-drift', 'evaluation node CAS file differs from its sealed manifest size')
        continue
      }
      try { await stat(store.path(item.contentRef.digest)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !source) throw error
        await bounded(source).download(store, item.contentRef)
      }
      await bounded(target).upload(store, item.contentRef, item.size)
    }
  }
  async prepare(model: T.ModelVersion, modelRef: T.ContentRef, context?: T.EndpointPreparationContext): Promise<T.ReadyEvaluationEndpointBinding | undefined> {
    requireContract(context, 'native-context-required', 'managed native preparation requires a persisted experiment context')
    await this.order(context, true)
    await this.fence(context)
    requireContract(this.profile.endpoint.serviceConfig.tokenizer_digest === model.tokenizerDigest
      && this.profile.endpoint.serviceConfig.chat_template_digest === model.chatTemplateDigest,
    'native-model-semantics-drift', 'native service tokenizer and chat template must match the immutable model')
    const identity = { owner: context.experimentId, modelRef, snapshotRef: model.hfSnapshotRef, profileDigest: this.configurationDigest, runId: context.runId ?? null }
    const intentDigest = digestJson(identity)
    let record = await this.state(context, state => {
      if (!state.intents[intentDigest]) {
        const now = Date.now(), hard = Math.min(Date.parse(context.deadlineAt), now + this.profile.maxRuntimeSeconds * 1000)
        const incarnation = randomUUID().replaceAll('-', '')
        state.intents[intentDigest] = { intent: { intentDigest, modelRef, snapshotRef: model.hfSnapshotRef, runId: context.runId ?? null,
          incarnation, wireModel: `gear-${incarnation}`, authKey: randomBytes(32).toString('hex'), attempt: 1,
          createdAt: new Date(now).toISOString(), startupDeadlineAt: new Date(Math.min(hard, now + this.profile.startupTimeoutSeconds * 1000)).toISOString(),
          hardDeadlineAt: new Date(hard).toISOString() }, status: 'preparing', consumers: {} }
      }
      return state.intents[intentDigest]!
    })
    // Serialize distinct models on one reserved group. Only experiment-owned,
    // positively tracked instances can be drained and retired here.
    const previous = await this.state(context, state => Object.values(state.intents).filter(r => r.intent.intentDigest !== intentDigest && r.status !== 'released'))
    for (const old of previous) {
      const retired = await this.retireRecord(old, context)
      if (retired.status !== 'released') return undefined
    }
    if (record.status === 'ready' && record.binding) return this.observe(record.binding, context)
    if (record.status === 'released') record = await this.retry(record, context)
    await this.ensureArtifacts(record)
    const deadline = Date.parse(record.intent.startupDeadlineAt)
    while (Date.now() < deadline) {
      await this.order(context, true)
      let observed: Observation
      try { observed = await this.observeRecord(record, context) }
      catch (error) {
        if (!(error instanceof TrainingContractError) || error.code !== 'deployment-process-unverified') throw error
        observed = { status: 'starting', verified: false }
      }
      if (observed.status === 'absent') {
        try {
          observed = await this.call(context, 'ensure', { intent: record.intent }, deadline - Date.now()) as Observation
          record.deploymentObserved = true
          await this.state(context, state => { state.intents[intentDigest]!.deploymentObserved = true })
        } catch (error) {
          // No acknowledgement means unknown remote state. Observe this exact
          // intent again; never turn a timeout into permission for another start.
          if (error instanceof TrainingContractError && ['deployment-start-uncertain', 'deployment-incarnation-lost'].includes(error.code)) {
            const retired = await this.retireRecord(record, context)
            if (retired.status !== 'released') throw new TrainingContractError('native-cleanup-blocked', 'original startup instance could not be safely released')
            record = await this.retry(record, context)
            continue
          }
          if (!(error instanceof TrainingContractError) || !['process-timeout', 'process-failed', 'deployment-process-unverified'].includes(error.code)) {
            await this.state(context, state => { state.intents[intentDigest]!.failure = error instanceof TrainingContractError ? error.code : 'native-preparation-failed' })
            throw error
          }
          await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
          continue
        }
      }
      if (observed.verified) {
        requireContract(observed.incarnation === record.intent.incarnation && observed.intentDigest === intentDigest
          && observed.snapshotRef?.digest === model.hfSnapshotRef.digest && observed.wireModel === record.intent.wireModel,
        'deployment-observation-drift', 'native observation differs from the persisted instance and snapshot')
        const binding = await this.binding(record.intent, context)
        try { await this.options.verifyEndpoint(binding, Math.max(1, Math.min(60_000, deadline - Date.now()))) }
        catch (error) {
          if (Date.now() >= deadline) throw new TrainingContractError('deployment-startup-timeout', 'native model capability verification exceeded its original deadline')
          await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())))
          continue
        }
        await this.order(context, true)
        await this.call(context, 'ready', this.target(binding), deadline - Date.now())
        await this.state(context, state => { const saved = state.intents[intentDigest]!; saved.binding = binding; saved.status = 'ready'; delete saved.failure })
        return binding
      }
      if (['EXITED', 'FATAL', 'STOPPED', 'ABSENT'].includes(observed.processState ?? '') && observed.status !== 'preparing') {
        const retired = await this.retireRecord(record, context)
        if (retired.status !== 'released') throw new TrainingContractError('native-cleanup-blocked', 'failed startup instance could not be safely released')
        record = await this.retry(record, context)
        continue
      }
      if (observed.failure) throw new TrainingContractError(observed.failure, 'native model preparation failed; inspect private deployment diagnostics')
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
      record = await this.state(context, state => state.intents[intentDigest]!)
    }
    await this.state(context, state => { state.intents[intentDigest]!.failure = 'deployment-startup-timeout' })
    throw new TrainingContractError('deployment-startup-timeout', 'native startup exhausted its original total deadline')
  }
  async observe(binding: T.ReadyEvaluationEndpointBinding, context: T.EndpointPreparationContext): Promise<T.ReadyEvaluationEndpointBinding | undefined> {
    const target = this.target(binding)
    const record = await this.state(context, state => this.findRecord(state, target))
    requireContract(record?.intent.incarnation === target.incarnation && record.binding && digestJson(record.binding) === digestJson(binding),
      'deployment-incarnation-lost', 'saved native binding no longer identifies its original private deployment record')
    this.restoreAuth(record)
    const observed = await this.observeRecord(record, context)
    if (!observed.verified && observed.deathProven) return undefined
    requireContract(observed.verified && observed.status === 'ready' && observed.incarnation === target.incarnation
      && observed.snapshotRef?.digest === binding.deployment_receipt.model_digest,
    'deployment-incarnation-lost', 'saved ready binding is a historical observation; the original instance is no longer ready')
    await this.binding(record.intent, context) // Reopen only this instance's independently owned SSH route.
    await this.options.verifyEndpoint(binding, Math.max(1, Math.min(60_000, Date.parse(context.deadlineAt) - Date.now())))
    return binding
  }
  async acquireConsumer(binding: T.ReadyEvaluationEndpointBinding, consumer: T.EndpointConsumer, context: T.EndpointPreparationContext): Promise<void> {
    await this.order(context, true)
    const target = this.target(binding)
    const saved = await this.state(context, state => {
      const record = this.findRecord(state, target)
      requireContract(record?.intent.incarnation === target.incarnation && record.status === 'ready', 'deployment-draining', 'native deployment is no longer admitting consumers')
      requireContract(consumer.experimentId === context.experimentId, 'deployment-owner-conflict', 'consumer belongs to another experiment')
      const old = record.consumers[consumer.id]
      requireContract(!old || digestJson(old.consumer) === digestJson(consumer) && !old.releasedAt, 'deployment-consumer-conflict', 'consumer identities cannot be changed or reopened')
      return record.consumers[consumer.id] ??= { consumer, acquiredAt: new Date().toISOString() }
    })
    await this.call(context, 'acquireConsumer', { ...target, consumer, acquiredAt: saved.acquiredAt })
  }
  async releaseConsumer(binding: T.ReadyEvaluationEndpointBinding, consumerId: string, context: T.EndpointPreparationContext): Promise<void> {
    const target = this.target(binding)
    const releasedAt = await this.state(context, state => {
      const record = this.findRecord(state, target)
      requireContract(record?.intent.incarnation === target.incarnation, 'deployment-incarnation-lost', 'consumer release requires its original deployment')
      const consumer = record.consumers[consumerId]
      if (!consumer) return new Date().toISOString()
      return consumer.releasedAt ??= new Date().toISOString()
    })
    await this.call(context, 'releaseConsumer', { ...target, consumer: { id: consumerId }, releasedAt })
  }
  private async retireRecord(record: IntentRecord, context: T.EndpointPreparationContext): Promise<{ status: 'draining' | 'released' | 'blocked'; reason?: string }> {
    if (record.status === 'released') return { status: 'released' }
    const target = { intentDigest: record.intent.intentDigest, incarnation: record.intent.incarnation }
    await this.state(context, state => { this.findRecord(state, target)!.status = 'draining' })
    try {
      // Remote retirement persists a negative intent even if an earlier SSH
      // command has not arrived. A mere "absent" read is not a release proof.
      const result = await this.call(context, 'retire', target, (this.profile.stopTimeoutSeconds + 5) * 1000) as { status: 'draining' | 'released' | 'blocked'; reason?: string }
      await this.state(context, state => { const saved = this.findRecord(state, target)!; saved.status = result.status; if (result.reason) saved.failure = result.reason })
      if (result.status === 'released') {
        await this.options.transport.closeEndpointRoute(context.controllerDirectory, { ...this.profile.endpoint, incarnation: target.incarnation })
        delete process.env[this.authName(record.intent)]
      }
      return result
    } catch (error) {
      await this.state(context, state => { const saved = this.findRecord(state, target)!; saved.status = 'blocked'; saved.failure = error instanceof TrainingContractError ? error.code : 'native-cleanup-uncertain' })
      return { status: 'blocked', reason: error instanceof TrainingContractError ? error.code : 'native-cleanup-uncertain' }
    }
  }
  async retire(binding: T.ReadyEvaluationEndpointBinding, context: T.EndpointPreparationContext): Promise<{ status: 'draining' | 'released' | 'blocked'; reason?: string }> {
    await this.order(context, false)
    const target = this.target(binding)
    const record = await this.state(context, state => this.findRecord(state, target))
    requireContract(record?.intent.incarnation === target.incarnation, 'deployment-incarnation-lost', 'native retirement requires the original deployment record')
    return this.retireRecord(record, context)
  }
  async retireOwned(context: T.EndpointPreparationContext): Promise<{ status: 'draining' | 'released' | 'blocked'; reason?: string }> {
    await this.order(context, false)
    const records = await this.state(context, state => Object.values(state.intents))
    for (const record of records) {
      const result = await this.retireRecord(record, context)
      if (result.status !== 'released') return result
    }
    return { status: 'released' }
  }
  async releaseOwnership(context: T.EndpointPreparationContext): Promise<{ released: boolean; reason?: string }> {
    await this.order(context, false)
    const result = await this.call(context, 'releaseOwnership', {}) as { released: boolean; reason?: string }
    if (result.released) await this.state(context, state => { state.ownershipReleased = true })
    return result
  }
  private async retry(record: IntentRecord, context: T.EndpointPreparationContext): Promise<IntentRecord> {
    return this.state(context, state => {
      const current = state.intents[record.intent.intentDigest]!
      requireContract(current.status === 'released' && Object.values(current.consumers).every(c => !!c.releasedAt),
        'native-cleanup-blocked', 'new incarnation requires proven release and all original consumers completed')
      requireContract(current.intent.attempt < this.profile.maxDeploymentAttempts, 'deployment-attempts-exhausted', 'native deployment exhausted its declared incarnation attempts')
      const original = current.intent
      // A failed cold start shares its original startup deadline. Recovery after
      // a previously ready instance has a fresh startup slice inside the same
      // immutable total residence/experiment deadline, never a new total budget.
      const startup = current.binding ? Math.min(Date.parse(original.hardDeadlineAt), Date.now() + this.profile.startupTimeoutSeconds * 1000)
        : Date.parse(original.startupDeadlineAt)
      requireContract(startup > Date.now() && Date.parse(original.hardDeadlineAt) - Date.now() > this.profile.stopTimeoutSeconds * 1000,
        'deployment-deadline-expired', 'new incarnation cannot extend the original deployment total deadline')
      const incarnation = randomUUID().replaceAll('-', '')
      ;(state.history ??= {})[original.incarnation] = structuredClone(current)
      const next: IntentRecord = { intent: { ...original, incarnation, wireModel: `gear-${incarnation}`, authKey: randomBytes(32).toString('hex'),
        attempt: original.attempt + 1, startupDeadlineAt: new Date(startup).toISOString() }, status: 'preparing', consumers: {} }
      state.intents[original.intentDigest] = next
      return next
    })
  }
}
