/**
 * Smoke tests for dsh-superpowers. Zero dependencies: `node --test test/`.
 * Exercises the real vendored skills snapshot under skills/.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, parseFrontmatter, renderBootstrap, BOOTSTRAP_SOURCE_KIND_FOR_TESTS } from '../index.js'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Minimal cordis-like context capturing registrations instead of mounting them. */
function makeMockCtx(t) {
  const listeners = new Map()
  const state = { provider: undefined, invalidated: 0 }
  const controller = new AbortController()
  const ctx = {
    logger: {
      infos: [],
      warns: [],
      info(text) { this.infos.push(text) },
      warn(text) { this.warns.push(text) },
    },
    skills: {
      registerProvider(create) {
        state.provider = create({
          signal: controller.signal,
          invalidate: () => { state.invalidated += 1 },
        })
        return () => {}
      },
    },
    on(event, callback) {
      const bucket = listeners.get(event) ?? []
      bucket.push(callback)
      listeners.set(event, bucket)
      return () => {}
    },
  }
  // Closing the skills watcher keeps `node --test` from hanging.
  if (t !== undefined) t.after(() => { controller.abort() })
  return { ctx, listeners, state, controller }
}

test('parseFrontmatter handles quoted descriptions containing colons', async (t) => {
  const raw = await readFile(join(packageRoot, 'skills/brainstorming/SKILL.md'), 'utf8')
  const parsed = parseFrontmatter(raw)
  assert.ok(parsed, 'brainstorming SKILL.md should parse')
  assert.equal(parsed.data.name, 'brainstorming')
  assert.match(parsed.data.description, /^You MUST use this before any creative work/)
  assert.ok(parsed.data.description.includes('creative work'), 'quoted value parsed verbatim')
  assert.match(parsed.body, /^# Brainstorming/)
})

test('parseFrontmatter rejects missing or unterminated fences', (t) => {
  assert.equal(parseFrontmatter('# Just markdown\n'), null)
  assert.equal(parseFrontmatter('---\nname: x\nno closing fence\n'), null)
})

test('parseFrontmatter supports plain values and indented continuation', (t) => {
  const parsed = parseFrontmatter('---\nname: my-skill\ndescription:\n  wrapped first line\n  second line\n---\nBody here\n')
  assert.deepEqual(parsed.data, { name: 'my-skill', description: 'wrapped first line second line' })
  assert.equal(parsed.body, 'Body here\n')
})

test('provider discovers all vendored upstream skills', async (t) => {
  const { ctx, state } = makeMockCtx(t)
  apply(ctx)
  const candidates = await state.provider.list()
  const names = candidates.map(candidate => candidate.name)
  assert.ok(names.length >= 14, `expected >=14 skills, got ${names.length}`)
  for (const expected of ['brainstorming', 'systematic-debugging', 'test-driven-development', 'using-superpowers', 'writing-plans']) {
    assert.ok(names.includes(expected), `missing skill ${expected}`)
  }
  for (const candidate of candidates) {
    assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.ok(candidate.description.length > 0)
    assert.equal(candidate.provider, 'dsh-superpowers-plugin')
    assert.equal(candidate.source, 'bundled')
    assert.equal(candidate.rank, 600)
    assert.equal(candidate.invocation.modelInvocable, true)
    assert.equal(candidate.invocation.userInvocable, true)
  }
})

test('provider loads full definition with directory resource base', async (t) => {
  const { ctx, state } = makeMockCtx(t)
  apply(ctx)
  const candidates = await state.provider.list()
  const candidate = candidates.find(entry => entry.name === 'test-driven-development')
  assert.ok(candidate, 'TDD skill should exist')
  const definition = await state.provider.get(candidate)
  assert.equal(definition.name, 'test-driven-development')
  assert.equal(definition.resourceBase.kind, 'directory')
  assert.match(definition.resourceBase.path, /skills[/\\]test-driven-development$/)
  assert.match(definition.content, /Test-Driven Development|red/i)
  assert.equal(definition.path, candidate.path)
})

test('provider honors disabledSkills configuration', async (t) => {
  const { ctx, state } = makeMockCtx(t)
  apply(ctx, { disabledSkills: ['brainstorming'] })
  const names = (await state.provider.list()).map(candidate => candidate.name)
  assert.ok(!names.includes('brainstorming'))
  assert.ok(names.includes('writing-plans'))
})

test('invalid configuration fails fast with actionable errors', (t) => {
  const { ctx } = makeMockCtx(t)
  assert.throws(() => apply(ctx, { providerName: '' }), /providerName/)
  assert.throws(() => apply(ctx, { providerName: 'runtime' }), /reserved/)
  assert.throws(() => apply(ctx, { rank: 'high' }), /rank/)
  assert.throws(() => apply(ctx, { bootstrap: 'yes' }), /bootstrap/)
})

test('renderBootstrap frames orientation and DSH tool mapping', (t) => {
  const text = renderBootstrap('# Using Superpowers\nCheck skills first.')
  assert.match(text, /^<EXTREMELY_IMPORTANT>/)
  assert.match(text, /You have superpowers\./)
  assert.match(text, /Do NOT use the skill tool to load "using-superpowers" again/)
  assert.match(text, /# Using Superpowers/)
  assert.match(text, /Tool Mapping for DeepSeek Harness:/)
  assert.match(text, /`todo_write`/)
  assert.match(text, /<\/EXTREMELY_IMPORTANT>$/)
})

function makeAgent({ history = [], visible = [] } = {}) {
  return {
    session: {
      events: history,
      surface: { nodes: new Set(visible) },
    },
  }
}

test('bootstrap injects exactly once per session and survives compaction rules', async (t) => {
  const { ctx, listeners, state } = makeMockCtx(t)
  apply(ctx)
  const preStep = listeners.get('agent/pre-step')[0]
  assert.ok(preStep, 'pre-step listener registered')

  // Step 1: appends the bootstrap after existing messages.
  const baseMessages = [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [] }]
  let decision = await preStep({ agent: makeAgent(), signal: undefined }, async () => ({
    kind: 'enter',
    messages: baseMessages,
  }))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, baseMessages.length + 1)
  const injected = decision.messages.at(-1)
  assert.equal(injected.source.kind, BOOTSTRAP_SOURCE_KIND_FOR_TESTS)
  assert.match(injected.content[0].text, /EXTREMELY_IMPORTANT/)

  // Step 2: same batch replayed (durable injection stays present) → untouched.
  const second = await preStep({ agent: makeAgent(), signal: undefined }, async () => decision)
  assert.equal(second, decision)

  // Step 3: compaction hid the historical bootstrap → re-injected.
  const compacted = await preStep(
    { agent: makeAgent({ history: [{ type: 'user/message', seq: 7, data: { source: { kind: BOOTSTRAP_SOURCE_KIND_FOR_TESTS } } }], visible: [1, 2] }), signal: undefined },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(compacted.messages.length, 1)
  assert.equal(compacted.messages[0].source.kind, BOOTSTRAP_SOURCE_KIND_FOR_TESTS)

  // Step 4: rejection decisions pass through untouched.
  const rejected = await preStep({ agent: makeAgent(), signal: undefined }, async () => ({ kind: 'reject' }))
  assert.equal(rejected.kind, 'reject')
})

test('bootstrap is disabled by configuration', async (t) => {
  const { ctx, listeners } = makeMockCtx(t)
  apply(ctx, { bootstrap: false })
  assert.equal(listeners.get('agent/pre-step'), undefined)
})

test('skills/change resets the bootstrap cache so late syncs still orient', async (t) => {
  // Uses a missing skillsDir via config override to force the null-body path.
  const { ctx, listeners } = makeMockCtx(t)
  apply(ctx, { skillsDir: join(packageRoot, '.upstream', 'missing') })
  const changeHooks = listeners.get('skills/change') ?? []
  assert.equal(changeHooks.length, 1, 'skills/change hook registered when bootstrap enabled')
})
