/**
 * dsh-superpowers-plugin — serve the obra/superpowers skill library as native DeepSeek Harness skills.
 *
 * This plugin is a DeepSeek Harness bundle (`dsh.bundle`). It contributes two things:
 *
 * 1. A skill provider registered on `ctx.skills` that discovers the vendored
 *    `skills/` directory (a tracked snapshot of https://github.com/obra/superpowers,
 *    refreshable via `scripts/sync-upstream.mjs` or any `skillsDir` override).
 *    Once registered, the harness consumer (`dsh-tool-skill`) automatically:
 *      - publishes the catalog as a durable `<available_skills>` session reminder,
 *      - exposes the model-facing `skill({ name })` loader tool,
 *      - handles user `/skill-name` gestures.
 *
 * 2. An optional one-shot session bootstrap (mirroring upstream SessionStart
 *    hooks): the `using-superpowers` orientation is injected once per live
 *    session before the catalog reminder, so the model checks and applies
 *    skills proactively instead of ignoring them.
 *
 * Zero runtime dependencies: configuration passes through verbatim when a
 * plugin exports no Config schema (cordis `resolveConfig`), and message
 * construction prefers the host's `createUserMessage` with a structural
 * fallback. Skills stay byte-identical to upstream so syncs never conflict.
 *
 * Row configuration (all optional):
 *   providerName   string   provider label on ctx.skills        (default "superpowers")
 *   skillsDir      string   absolute skills root override       (default packaged ./skills)
 *   rank           number   precedence within one scope layer   (default 600; project/user skills win)
 *   source         string   prompt-visible origin bucket        (default "bundled")
 *   disabledSkills string[] skill names to exclude              (default [])
 *   bootstrap      boolean  inject using-superpowers once       (default true)
 */

import { readdir, readFile } from 'node:fs/promises'
import { watch as fsWatch } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-superpowers-plugin'
export const inject = ['skills', 'agents']

/** Reserved provider name in the skill registry (owned by runtime registrations). */
const RESERVED_PROVIDER = 'runtime'
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DEFAULTS = Object.freeze({
  providerName: 'dsh-superpowers-plugin',
  rank: 600,
  source: 'bundled',
  disabledSkills: [],
  bootstrap: true,
})
const BOOTSTRAP_SOURCE_KIND = 'superpowers-bootstrap'
/** Test seam: the durable message source kind marking an injected bootstrap. */
export const BOOTSTRAP_SOURCE_KIND_FOR_TESTS = BOOTSTRAP_SOURCE_KIND
const WATCH_DEBOUNCE_MS = 150

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function resolveConfig(config = {}) {
  const merged = {
    ...DEFAULTS,
    disabledSkills: [...DEFAULTS.disabledSkills],
    ...config,
    ...(Array.isArray(config?.disabledSkills) ? { disabledSkills: [...config.disabledSkills] } : {}),
  }
  if (typeof merged.providerName !== 'string' || merged.providerName.length === 0) {
    throw new Error('dsh-superpowers-plugin: providerName must be a non-empty string')
  }
  if (merged.providerName === RESERVED_PROVIDER) {
    throw new Error(`dsh-superpowers-plugin: providerName "${RESERVED_PROVIDER}" is reserved`)
  }
  if (!Number.isFinite(merged.rank)) {
    throw new Error('dsh-superpowers-plugin: rank must be a finite number')
  }
  if (typeof merged.source !== 'string' || merged.source.length === 0) {
    throw new Error('dsh-superpowers-plugin: source must be a non-empty string')
  }
  if (!Array.isArray(merged.disabledSkills) || merged.disabledSkills.some(s => typeof s !== 'string')) {
    throw new Error('dsh-superpowers-plugin: disabledSkills must be an array of skill names')
  }
  if (typeof merged.bootstrap !== 'boolean') {
    throw new Error('dsh-superpowers-plugin: bootstrap must be a boolean')
  }
  merged.skillsDir = merged.skillsDir === undefined
    ? fileURLToPath(new URL('./skills/', import.meta.url))
    : resolve(merged.skillsDir)
  return merged
}

/* ------------------------------------------------------------------ */
/* Frontmatter parsing (minimal YAML subset, sufficient for SKILL.md)  */
/* ------------------------------------------------------------------ */

/**
 * Parse `---` fenced frontmatter and strip it from the body.
 * Supports plain scalars and single/double-quoted values (colons allowed
 * inside quotes), plus indented continuation lines for bare keys.
 * @param raw - full file text.
 * @returns `{ data, body }`, or `null` when no well-formed frontmatter exists.
 */
export function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return null
  const newline = raw.indexOf('\n')
  if (newline === -1 || raw.slice(0, newline).trim() !== '---') return null
  const rest = raw.slice(newline + 1)
  // Find the first line that is exactly "---".
  const lines = rest.split('\n')
  let end = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trimEnd() === '---') { end = i; break }
  }
  if (end === -1) return null
  const data = {}
  let pendingKey = null
  for (let i = 0; i < end; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indented = /^\s/.test(line)
    if (indented && pendingKey !== null) {
      data[pendingKey] = `${data[pendingKey]} ${line.trim()}`.trim()
      continue
    }
    pendingKey = null
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (value === '') { pendingKey = key; data[key] = ''; continue }
    data[key] = unquote(value)
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '')
  return { data, body }
}

function unquote(value) {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

/** Project a parsed frontmatter record into registry-facing skill fields. */
function toSkillFields(data, fallbackName) {
  const name = typeof data.name === 'string' && SKILL_NAME.test(data.name) ? data.name : fallbackName
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  const whenToUse = typeof data.when_to_use === 'string' && data.when_to_use.trim() !== ''
    ? data.when_to_use.trim()
    : undefined
  // Same normalized policy keys the built-in filesystem provider reads.
  const modelInvocable = data['disable-model-invocation'] !== true && data['disable-model-invocation'] !== 'true'
  const userInvocable = data['user-invocable'] !== false && data['user-invocable'] !== 'false'
  const metadataKeys = Object.keys(data).filter(key =>
    !['name', 'description', 'when_to_use', 'disable-model-invocation', 'user-invocable'].includes(key))
  const metadata = metadataKeys.length === 0 ? undefined : Object.fromEntries(metadataKeys.map(key => [key, data[key]]))
  return { name, description, whenToUse, invocation: { modelInvocable, userInvocable }, metadata }
}

/* ------------------------------------------------------------------ */
/* Skill discovery                                                     */
/* ------------------------------------------------------------------ */

/**
 * Scan one skills root for directory-bundle skills (`<name>/SKILL.md`).
 * Malformed entries are skipped with a warning instead of failing discovery.
 */
async function discoverSkills(skillsDir, providerName, config, logger) {
  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch (error) {
    logger.warn?.(`dsh-superpowers-plugin: cannot read skills dir "${skillsDir}": ${error?.message ?? error}`)
    return []
  }
  const disabled = new Set(config.disabledSkills)
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(skillsDir, entry.name)
    const file = join(dir, 'SKILL.md')
    let parsed
    try {
      parsed = parseFrontmatter(await readFile(file, 'utf8'))
    } catch {
      continue // no SKILL.md (or unreadable): not a skill bundle
    }
    if (parsed === null) {
      logger.warn?.(`dsh-superpowers-plugin: skipping "${entry.name}" — SKILL.md has no frontmatter`)
      continue
    }
    const fields = toSkillFields(parsed.data, entry.name)
    if (!SKILL_NAME.test(fields.name)) {
      logger.warn?.(`dsh-superpowers-plugin: skipping "${entry.name}" — invalid skill name "${fields.name}"`)
      continue
    }
    if (fields.description === '') {
      logger.warn?.(`dsh-superpowers-plugin: skipping "${entry.name}" — empty description`)
      continue
    }
    if (disabled.has(fields.name)) continue
    found.push({
      name: fields.name,
      description: fields.description,
      ...(fields.whenToUse !== undefined ? { whenToUse: fields.whenToUse } : {}),
      invocation: fields.invocation,
      source: config.source,
      provider: providerName,
      rank: config.rank,
      locator: { dir, path: file },
      path: file,
      ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}),
      content: parsed.body,
    })
  }
  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return found
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

class SuperpowersSkillProvider {
  #config
  #ctx
  #watcher
  #debounceTimer
  #control

  constructor(ctx, control, config) {
    this.#ctx = ctx
    this.#config = config
    this.#control = control
    control.signal.addEventListener('abort', () => { void this.dispose() }, { once: true })
    this.#startWatch()
  }

  get name() { return this.#config.providerName }

  async list() {
    return discoverSkills(this.#config.skillsDir, this.#config.providerName, this.#config, this.#ctx.logger)
  }

  /** Re-read the winning candidate so edits between discovery and load are honored. */
  async get(candidate) {
    const locator = candidate?.locator
    if (locator === undefined) return undefined
    let parsed
    try {
      parsed = parseFrontmatter(await readFile(locator.path, 'utf8'))
    } catch {
      return undefined
    }
    if (parsed === null) return undefined
    const fields = toSkillFields(parsed.data, candidate.name)
    if (fields.name !== candidate.name) return undefined
    return {
      name: fields.name,
      description: fields.description,
      ...(fields.whenToUse !== undefined ? { whenToUse: fields.whenToUse } : {}),
      invocation: fields.invocation,
      source: candidate.source,
      provider: this.#config.providerName,
      resourceBase: { kind: 'directory', path: locator.dir },
      path: locator.path,
      ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}),
      content: parsed.body,
    }
  }

  /**
   * Watch the skills root so an upstream sync is picked up live: invalidation
   * republishes the session catalog without a restart. Best-effort — a missing
   * or unwatchable root only costs "restart to see updates".
   */
  #startWatch() {
    let watcher
    try {
      watcher = fsWatch(this.#config.skillsDir, { recursive: true }, () => this.#invalidateDebounced())
    } catch {
      try {
        watcher = fsWatch(this.#config.skillsDir, () => this.#invalidateDebounced())
      } catch (error) {
        this.#ctx.logger.warn?.(`dsh-superpowers-plugin: skills watcher unavailable (${error?.message ?? error}); synced skills appear after restart`)
        return
      }
    }
    if (this.#control.signal.aborted) {
      watcher.close()
      return
    }
    this.#watcher = watcher
    // The skills root must never pin the process alive on its own: servers
    // hold their own refs, and one-shot runs can still exit promptly.
    watcher.unref?.()
    watcher.on('error', () => {
      try { watcher.close() } catch { /* already closed */ }
      if (this.#watcher === watcher) this.#watcher = undefined
    })
  }

  #invalidateDebounced() {
    clearTimeout(this.#debounceTimer)
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = undefined
      try {
        this.#control.invalidate()
      } catch { /* registration already disposed */ }
    }, WATCH_DEBOUNCE_MS)
  }

  /** Close the watcher and cancel any pending invalidation. Idempotent. */
  async dispose() {
    clearTimeout(this.#debounceTimer)
    const watcher = this.#watcher
    this.#watcher = undefined
    if (watcher !== undefined) {
      try {
        await watcher.close()
      } catch { /* already closed */ }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Session bootstrap (using-superpowers orientation, once per session) */
/* ------------------------------------------------------------------ */

let hostCreateUserMessage
try {
  ({ createUserMessage: hostCreateUserMessage } = await import('@deepseek-ai/dsh-llm'))
} catch {
  hostCreateUserMessage = undefined
}

function makeUserMessage(text) {
  const input = {
    content: [{ type: 'text', text }],
    source: { kind: BOOTSTRAP_SOURCE_KIND },
  }
  if (hostCreateUserMessage !== undefined) return hostCreateUserMessage(input)
  return { id: randomUUID(), role: 'user', ...input } // structural fallback
}

/** DSH equivalents for actions the upstream skills phrase against other harnesses. */
const TOOL_MAPPING = [
  '**Tool Mapping for DeepSeek Harness:**',
  'When skills request actions, substitute DeepSeek Harness equivalents:',
  '- Create or update todos → `todo_write`',
  '- `Subagent (general-purpose):` → dispatch through your subagent/workflow tools',
  '- Invoke a skill → the native `skill` tool',
  '- Read files → `read`; find files by pattern → `glob`',
  '- Create, edit, or delete files → `write` / `edit`',
  '- Run shell commands → `bash`',
  '- Search file contents → `grep`',
  '- Search the web → `web_search`',
  '',
  "Load any other skill with the native `skill` tool using its exact name from <available_skills>.",
].join('\n')

export function renderBootstrap(skillBody) {
  return [
    '<EXTREMELY_IMPORTANT>',
    'You have superpowers.',
    '',
    "**IMPORTANT: The using-superpowers skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the skill tool to load \"using-superpowers\" again - that would be redundant.**",
    '',
    skillBody.trim(),
    '',
    TOOL_MAPPING,
    '</EXTREMELY_IMPORTANT>',
  ].join('\n')
}

async function loadBootstrapBody(config) {
  try {
    const parsed = parseFrontmatter(await readFile(join(config.skillsDir, 'using-superpowers', 'SKILL.md'), 'utf8'))
    return parsed === null ? null : parsed.body
  } catch {
    return null
  }
}

/**
 * Whether this session already carries a visible bootstrap message.
 *
 * Mirrors the built-in catalog consumer's posture: the newest bootstrap event
 * decides, and it counts only while still on the visible session surface
 * (`session.surface.nodes`), so compaction that hides the orientation lets the
 * next step re-establish it instead of silently staying gone.
 */
function findExistingBootstrap(decisionMessages, agent) {
  const inBatch = Array.isArray(decisionMessages) && decisionMessages.some(message =>
    message?.source?.kind === BOOTSTRAP_SOURCE_KIND)
  if (inBatch) return true
  const events = agent?.session?.events
  if (events === undefined || events === null || typeof events.length !== 'number') return false
  let visibleSet
  try {
    visibleSet = new Set(agent.session.surface?.nodes ?? [])
  } catch {
    return true // unreadable surface: assume present rather than double-inject
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'user/message' || event?.data?.source?.kind !== BOOTSTRAP_SOURCE_KIND) continue
    return visibleSet.has(event.seq)
  }
  return false
}

function registerBootstrap(ctx, config) {
  let bodyPromise
  const getBody = () => {
    bodyPromise ??= loadBootstrapBody(config).then((body) => {
      // A sync can add using-superpowers later; retry after any catalog change.
      if (body === null) ctx.logger.warn?.('dsh-superpowers-plugin: bootstrap skipped — skills/using-superpowers/SKILL.md not found')
      return body
    })
    return bodyPromise
  }
  ctx.on('skills/change', () => { bodyPromise = undefined })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal?.throwIfAborted()
    if (findExistingBootstrap(decision.messages, agent)) return decision
    const body = await getBody()
    if (body === null) return decision
    return {
      kind: 'enter',
      messages: [...decision.messages, makeUserMessage(renderBootstrap(body))],
    }
  })
}

/* ------------------------------------------------------------------ */
/* Plugin entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * Register the superpowers skill provider and (optionally) the session bootstrap.
 * @param ctx - cordis context with the injected `skills`/`agents` services.
 * @param config - optional row configuration; see the module docblock.
 */
export function apply(ctx, config = {}) {
  if (typeof ctx?.skills?.registerProvider !== 'function') {
    throw new Error('dsh-superpowers-plugin requires the `skills` service (dsh-skill); add @deepseek-ai/dsh-base or equivalent to the profile')
  }
  const resolved = resolveConfig(config)
  ctx.skills.registerProvider(control => new SuperpowersSkillProvider(ctx, control, resolved))
  if (resolved.bootstrap) registerBootstrap(ctx, resolved)
  ctx.logger.info?.(`dsh-superpowers-plugin: serving skills from ${resolved.skillsDir}`)
}
