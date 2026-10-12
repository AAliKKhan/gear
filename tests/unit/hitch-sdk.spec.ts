import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, afterEach, vi } from 'vitest'
import { openHitchSdk, type HitchEnvironment } from '../../src/adapters/hitch/sdk.js'
import { digestJson } from '../../src/adapters/hitch/json.js'
import type { HitchProfile } from '../../src/adapters/hitch/provider.js'
const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-public-sdk-')); roots.push(root)
  await mkdir(join(root, 'bin'))
  const profile: HitchProfile = { kind: 'hitch', root, executable: join(root, 'bin/hitch.mjs'), harnessRef: 'pi@version:1.0.0', model: 'unused', passEnv: [], timeoutMs: 1000, baseImage: 'image@'+digestJson('image') }
  const expected: HitchEnvironment = { provider: 'local-docker', workerId: 'local', collisionDomainId: 'engine', environment: { schema_version: '2', docker: { engine_id: 'engine' } },
    controller: { schema_version: '2', package_version: '0.2.16', node_version: 'v22.23.0', runtime_id: digestJson('controller'), source: { kind: 'unavailable', commit: null, dirty: null } } }
  const exports = Object.fromEntries(['controller-runtime', 'backends', 'evals', 'revisions'].map(name => ['./'+name, './sdk.mjs']))
  await writeFile(profile.executable, '', { mode: 0o700 })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'agent-hitch', type: 'module', exports }))
  const update = async (value: HitchEnvironment) => writeFile(join(root, 'observed.json'), JSON.stringify(value))
  await update(expected)
  await writeFile(join(root, 'sdk.mjs'), `import {readFile} from 'node:fs/promises';const read=async()=>JSON.parse(await readFile(new URL('./observed.json',import.meta.url),'utf8'));export const observeControllerRuntime=async()=> (await read()).controller;export const observeHarborEnvironment=async()=> (await read()).environment;`)
  return { profile, expected, update }
}
it('loads public APIs from an installed source-less package and checks the executing environment', async () => {
  const f = await fixture(), sdk = await openHitchSdk(f.profile, f.expected), signal = new AbortController().signal
  await expect(sdk.check(signal)).resolves.toBeUndefined()
  const observed = structuredClone(f.expected); observed.controller.node_version = 'v26.7.0'
  await f.update(observed)
  await expect(sdk.check(signal)).resolves.toBeUndefined()
  observed.environment = { ...observed.environment, changed: true }; await f.update(observed)
  await expect(sdk.check(signal)).rejects.toMatchObject({ code: 'hitch-sdk-environment-mismatch' })
})
it('rejects mismatched payloads and refuses to reuse cached modules after an upgrade', async () => {
  const f = await fixture(), sdk = await openHitchSdk(f.profile, f.expected)
  const changed = structuredClone(f.expected); changed.controller.runtime_id = digestJson('upgrade'); await f.update(changed)
  await expect(sdk.check(new AbortController().signal)).rejects.toMatchObject({ code: 'hitch-sdk-runtime-mismatch' })
  await expect(openHitchSdk(f.profile, changed)).rejects.toMatchObject({ code: 'hitch-sdk-runtime-changed' })
})
it('fails closed when a public preparation API is missing', async () => {
  const f = await fixture()
  await writeFile(join(f.profile.root, 'package.json'), JSON.stringify({ name: 'agent-hitch', exports: {} }))
  await expect(openHitchSdk(f.profile, f.expected)).rejects.toMatchObject({ code: 'hitch-sdk-unavailable' })
})
it('resolves a PATH-selected CLI to the same public SDK package as execution', async () => {
  const f = await fixture()
  vi.stubEnv('PATH', join(f.profile.root, 'bin'))
  const sdk = await openHitchSdk({ ...f.profile, executable: 'hitch.mjs' }, f.expected)
  await expect(sdk.check(new AbortController().signal)).resolves.toBeUndefined()
})
