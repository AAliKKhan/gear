import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HitchArtifactReader } from '../../src/adapters/hitch/trajectory.js'
import { TrajectoryStore } from '../../src/adapters/storage/trajectory.js'
import { ExperienceStore } from '../../src/adapters/storage/experience.js'
import { readSeedTrajectory } from '../../src/adapters/artifacts/access.js'
import { builtinPolicy, builtinPolicyImplementationDigest } from '../../src/adapters/python/builtin-policy.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { ExperienceRecord } from '../../src/domain/experience.js'
import { trajectoryGateway } from '../../src/adapters/codex/trajectory-gateway.js'
import { requestRefineSkill } from '../../src/adapters/skill/client.js'
import { resolvePythonExecutable } from '../../src/adapters/python/interpreter.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const signal = () => new AbortController().signal
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-trajectory-')); roots.push(root)
  const executable = join(root, 'hitch.mjs'), run = 'run_' + 'a'.repeat(32)
  await writeFile(executable, `#!${process.execPath}\nimport {trajectoryFixture} from ${JSON.stringify(new URL('../fixtures/trajectory-hitch.mjs', import.meta.url).href)};await trajectoryFixture();`, { mode: 0o700 })
  await writeFile(join(root, run + '.json'), JSON.stringify([{ seq: 0, type: 'assistant/message', data: '你好，世界' }, { seq: 1, type: 'tool/result', data: { content: 'read exact output' } }]))
  const reader = new HitchArtifactReader(executable, root), artifact = await reader.capture(run, 'seed', 0, signal())
  expect(artifact.status).toBe('available')
  const source = await new TrajectoryStore(join(root, 'trajectory-sources')).save({ version: 1, run_id: 'project-run',
    candidate_id: 'candidate', operation_id: canonicalDigest('operation'), origin_run_id: 'project-run', origin_candidate_id: 'candidate',
    receipt_digest: canonicalDigest('receipt'), reader_identity: canonicalDigest(reader.descriptor), partition: 'seed', artifact })
  const reference = { ref: 'trajectory:' + source.digest.slice(7), candidate_id: 'candidate', task_id: 'seed', repetition: 0,
    status: artifact.status, content_digest: artifact.content_digest, reason: null }
  const record = builtinPolicy<ExperienceRecord>('experience_record', { source: {}, candidate: { id: 'candidate', parent_id: 'parent', digest: canonicalDigest('candidate') },
    parent: { id: 'parent', parent_id: null, digest: canonicalDigest('parent') }, task_ids: ['seed'], repetitions: 1, objective: null,
    evidence: [], proposal: {}, change: { files: [] }, trajectory_refs: [reference] })
  const body = { version: 2 as const, run_id: 'project-run', source_archive_digest: canonicalDigest('archive'), implementation_identity: builtinPolicyImplementationDigest, records: [record] }
  const snapshot = { ...body, digest: canonicalDigest(body) }
  await new ExperienceStore(join(root, 'experience')).save(snapshot)
  const params = { ref: 'experience:' + record.digest.slice(7), source_ref: reference.ref }
  return { root, run, reader, artifact, snapshot, params }
}

it('reads only a source referenced by the frozen record and binds all pages to its canonical digest', async () => {
  const { root, run, reader, snapshot, params } = await fixture()
  const page = await readSeedTrajectory(root, snapshot, reader.descriptor, { ...params, query: { limit: 1 } }, signal()) as { items: unknown[]; next_cursor: string }
  expect(page).toMatchObject({ items: [{ data: '你好，世界' }], total: 2, child_sessions: 'not-included' })
  expect(JSON.stringify(page)).not.toContain('PRIVATE_CANARY')
  const next = await readSeedTrajectory(root, snapshot, reader.descriptor, { ...params, query: { limit: 1, cursor: page.next_cursor } }, signal())
  expect(next).toMatchObject({ items: [{ seq: 1 }], eof: true })
  const calls = await readFile(join(root, 'calls.jsonl'), 'utf8')
  await expect(readSeedTrajectory(root, snapshot, reader.descriptor, { ...params, source_ref: 'trajectory:' + 'f'.repeat(64) }, signal())).rejects.toMatchObject({ code: 'trajectory-outside-snapshot' })
  expect(await readFile(join(root, 'calls.jsonl'), 'utf8')).toBe(calls)
  await writeFile(join(root, run + '.json'), '[]')
  await expect(readSeedTrajectory(root, snapshot, reader.descriptor, params, signal())).rejects.toMatchObject({ code: 'hitch-call-failed' })
})

it('rejects provider source/filter substitution and bounded output overflow, preserving split UTF-8', async () => {
  const { root, reader, artifact } = await fixture()
  for (const mode of ['wrong-run', 'wrong-filter', 'oversized']) {
    await writeFile(join(root, 'mode'), mode)
    await expect(reader.read(artifact, { limit: 1 }, signal())).rejects.toThrow()
  }
  await writeFile(join(root, 'mode'), 'split-utf8')
  expect(await reader.read(artifact, { limit: 1 }, signal())).toMatchObject({ events: [{ data: '你好，世界' }] })
})

it('cancels a pending read without waiting for the provider to finish naturally', async () => {
  const { root, reader, artifact } = await fixture()
  await writeFile(join(root, 'mode'), 'hang')
  const abort = new AbortController(), pending = reader.read(artifact, {}, abort.signal)
  const timer = setTimeout(() => abort.abort(), 75)
  try { await expect(pending).rejects.toThrow() } finally { clearTimeout(timer) }
})

it('offers only the authorized read capability through a per-operation gateway and closes it', async () => {
  const { root, reader, snapshot, params } = await fixture()
  const gatewayRoot = await mkdtemp(join(tmpdir(), 'g-tr-')); roots.push(gatewayRoot)
  await mkdir(join(gatewayRoot, 'experience'))
  const gateway = await trajectoryGateway(gatewayRoot, root, snapshot, reader.descriptor, resolvePythonExecutable())
  try {
    const { token } = JSON.parse(await readFile(gateway.path, 'utf8')) as { token: string }
    await expect(requestRefineSkill(gateway.socket, { method: 'run.report', params: { token } })).rejects.toThrow()
    await expect(requestRefineSkill(gateway.socket, { method: 'trajectory.read', params: { ...params, token: 'wrong' } })).rejects.toThrow()
    expect(await requestRefineSkill(gateway.socket, { method: 'trajectory.read', params: { ...params, token } })).toMatchObject({ total: 2 })
  } finally { await gateway.dispose() }
  await expect(readFile(gateway.socket)).rejects.toThrow()
})

it('aborts in-flight provider reads when its Meta gateway is disposed', async () => {
  const { root, reader, snapshot, params } = await fixture()
  const gatewayRoot = await mkdtemp(join(tmpdir(), 'g-tr-stop-')); roots.push(gatewayRoot)
  await mkdir(join(gatewayRoot, 'experience')); await writeFile(join(root, 'mode'), 'hang')
  const gateway = await trajectoryGateway(gatewayRoot, root, snapshot, reader.descriptor, resolvePythonExecutable())
  const { token } = JSON.parse(await readFile(gateway.path, 'utf8')) as { token: string }
  const pending = requestRefineSkill(gateway.socket, { method: 'trajectory.read', params: { ...params, token } })
  const rejected = expect(pending).rejects.toThrow()
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').length === 2) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect((await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
  } finally { await gateway.dispose() }
  await rejected
})
