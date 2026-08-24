#!/usr/bin/env node
/**
 * Sync the vendored skills snapshot from the upstream superpowers repository.
 *
 *   node scripts/sync-upstream.mjs [options]
 *
 * Options:
 *   --repo <url>    upstream git URL or local path (default: UPSTREAM.json repo)
 *   --ref <branch>  branch/tag/sha to track            (default: UPSTREAM.json ref, else main)
 *   --from <path>   shorthand for a local upstream checkout (skips git entirely)
 *   --check         report drift only; exit 1 when behind
 *
 * Behavior:
 *   1. Clone/update a shallow cache under .upstream/superpowers (or read --from).
 *   2. Replace skills/ with the upstream skills/ tree (deletions honored).
 *   3. Refresh LICENSE-SUPERPOWERS when upstream ships one.
 *   4. Record { repo, ref, commit, syncedAt } into UPSTREAM.json.
 *
 * A running harness needs no restart: the plugin watches skills/ and
 * republishes the session catalog when files change.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upstreamManifestPath = join(packageRoot, 'UPSTREAM.json')
const skillsDest = join(packageRoot, 'skills')
const licenseDest = join(packageRoot, 'LICENSE-SUPERPOWERS')
const cacheDir = join(packageRoot, '.upstream', 'superpowers')

function fail(message) {
  console.error(`sync-upstream: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--repo' || token === '--ref' || token === '--from') {
      const value = argv[i + 1]
      if (value === undefined) fail(`${token} requires a value`)
      args[token.slice(2)] = value
      i += 1
    } else if (token === '--check') {
      args.check = true
    } else if (token === '--help' || token === '-h') {
      args.help = true
    } else {
      args._.push(token)
    }
  }
  return args
}

/** Direct child directory names of a skills root, sorted. */
function listSkillDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

function run(command, cmdArgs) {
  const result = spawnSync(command, cmdArgs, { encoding: 'utf8' })
  if (result.status !== 0 || result.error) {
    fail(`${command} ${cmdArgs.join(' ')} failed:\n${result.stderr || result.stdout || String(result.error ?? '(no output)')}`)
  }
  return result.stdout.trim()
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('Usage: node scripts/sync-upstream.mjs [--repo <url|path>] [--ref <branch>] [--from <checkout>] [--check]')
  process.exit(0)
}

let manifest = {}
try {
  manifest = JSON.parse(readFileSync(upstreamManifestPath, 'utf8'))
} catch (error) {
  fail(`cannot read UPSTREAM.json: ${error?.message ?? error}`)
}
const repo = args.repo ?? args.from ?? manifest.repo
const ref = args.ref ?? manifest.ref ?? 'main'
if (typeof repo !== 'string' || repo.length === 0) fail('no upstream repo configured; pass --repo <url>')

/** Resolve the upstream source to { source: dir, commit: sha | '' }. */
function prepareSource() {
  const looksLocal = /^[./~]/.test(repo) || (!repo.includes(':') && existsSync(repo))
  if (looksLocal) {
    const source = resolve(repo.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
    if (!existsSync(join(source, 'skills'))) fail(`local checkout "${source}" has no skills/ directory`)
    const probe = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    return { source, commit: probe.status === 0 ? probe.stdout.trim() : '' }
  }
  if (!existsSync(cacheDir)) {
    mkdirSync(dirname(cacheDir), { recursive: true })
    run('git', ['clone', '--depth', '1', '--branch', ref, repo, cacheDir])
  } else {
    run('git', ['-C', cacheDir, 'fetch', '--depth', '1', 'origin', ref])
    run('git', ['-C', cacheDir, 'reset', '--hard', 'FETCH_HEAD'])
  }
  return { source: cacheDir, commit: run('git', ['-C', cacheDir, 'rev-parse', 'HEAD']) }
}

const previousSkills = new Set(listSkillDirs(skillsDest))
const { source, commit } = prepareSource()

if (args.check) {
  // Drift detection without mutation (the .upstream git cache may refresh;
  // vendored skills/ is never touched).
  const diff = run('diff', ['-rq', join(source, 'skills'), skillsDest])
  if (diff.length === 0) {
    console.log(`sync-upstream: up to date with ${repo}@${commit}`)
    process.exit(0)
  }
  console.error(`sync-upstream: behind upstream ${repo}@${commit}:`)
  for (const line of diff.split('\n').slice(0, 20)) console.error(`  ${line}`)
  process.exit(1)
}

rmSync(skillsDest, { recursive: true, force: true })
cpSync(join(source, 'skills'), skillsDest, { recursive: true })
if (existsSync(join(source, 'LICENSE'))) {
  cpSync(join(source, 'LICENSE'), licenseDest)
}

/** Upstream package version, so plugin releases track superpowers releases. */
function readUpstreamVersion(dir) {
  try {
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : null
  } catch {
    return null
  }
}
const upstreamVersion = readUpstreamVersion(source)
if (upstreamVersion !== null && upstreamVersion !== manifest.upstreamVersion) {
  const pkgPath = join(packageRoot, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.version = upstreamVersion // the plugin ships exactly one snapshot per upstream release
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

const currentSkills = new Set(listSkillDirs(skillsDest))
const added = [...currentSkills].filter(name => !previousSkills.has(name))
const removed = [...previousSkills].filter(name => !currentSkills.has(name))

// Persist the manifest only when a tracking fact changed: refreshing syncedAt
// on every run would make CI commit "chore(sync)" for zero real drift.
const nextManifest = {
  repo,
  ref,
  commit,
  ...(upstreamVersion !== null ? { upstreamVersion } : {}),
  syncedAt: new Date().toISOString(),
}
const trackingFacts = ({ repo: r, ref: f, commit: c, upstreamVersion: v }) => JSON.stringify([r, f, c, v ?? null])
if (trackingFacts(nextManifest) !== trackingFacts(manifest)) {
  writeFileSync(upstreamManifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`)
} else {
  console.log('sync-upstream: UPSTREAM.json unchanged (tracking facts identical)')
}

console.log(`sync-upstream: skills/ updated to ${repo}${commit ? `@${commit.slice(0, 12)}` : ''} (ref ${ref})`)
if (upstreamVersion !== null) console.log(`sync-upstream: tracking upstream version ${upstreamVersion} (package.json updated when changed)`)
console.log(`sync-upstream: ${currentSkills.size} skills vendored`
  + (added.length > 0 ? `\n  added:   ${added.join(', ')}` : '')
  + (removed.length > 0 ? `\n  removed: ${removed.join(', ')}` : ''))
console.log('sync-upstream: a running harness picks this up automatically (catalog republishes on change).')
