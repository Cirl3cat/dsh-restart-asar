#!/usr/bin/env node
/**
 * dsh-restart patcher — inspect or repair the DeepSeek Harness desktop shell.
 *
 * Commands:
 *   status    read-only report of the installed `resources/app.asar`
 *   apply     add the Restart entries when the shell is the known stock layout
 *   restore   write the saved pre-patch `lib/main.js` back
 *
 * Options: `--asar <path>`, `--json`, `--dry-run`.
 *
 * The rewrite is byte-length preserving (see `lib/patch.js`), so every other
 * entry offset in the archive stays valid. The pre-patch file is saved under
 * `~/.dsh/dsh-restart/` and a syntax check runs before anything is written.
 *
 * @module dsh-restart/lib/patcher
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readArchive, readMain, writeMain } from './asar.js'
import { buildPatch, status as textStatus, validatePatched } from './patch.js'

/** Environment variable that points the patcher at another archive. */
export const ASAR_ENV = 'DSH_DESKTOP_APP_ASAR'

/** State directory holding the original file and the last run. */
export function stateDirectory() {
  const fromEnv = process.env.DSH_RESTART_HOME
  return typeof fromEnv === 'string' && fromEnv !== ''
    ? fromEnv
    : join(homedir(), '.dsh', 'dsh-restart')
}

/** The desktop app's usual per-user installation directory. */
const DEFAULT_INSTALL_SEGMENTS = ['Programs', 'DeepSeek Harness', 'resources', 'app.asar']

/**
 * Locate the desktop `app.asar`.
 *
 * Order: explicit argument, `DSH_DESKTOP_APP_ASAR`, the executable that runs
 * this Host (`DSH_NODE_EXECUTABLE`, which is the Electron binary for a desktop
 * session), this process's own executable, then the standard install folders.
 * @param explicit - caller-supplied path.
 * @returns the first existing candidate, or undefined.
 */
export function resolveAsar(explicit) {
  if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) return explicit
  const fromEnv = process.env[ASAR_ENV]
  if (typeof fromEnv === 'string' && fromEnv !== '' && existsSync(fromEnv)) return fromEnv
  const executables = [process.env.DSH_NODE_EXECUTABLE, process.execPath]
  for (const executable of executables) {
    if (typeof executable !== 'string' || executable === '') continue
    const candidate = join(dirname(executable), 'resources', 'app.asar')
    if (existsSync(candidate)) return candidate
  }
  const local = process.env.LOCALAPPDATA
  if (typeof local === 'string' && local !== '') {
    const candidate = join(local, ...DEFAULT_INSTALL_SEGMENTS)
    if (existsSync(candidate)) return candidate
  }
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (typeof root !== 'string' || root === '') continue
    const candidate = join(root, 'DeepSeek Harness', 'resources', 'app.asar')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Persist the current stock `lib/main.js` before the first write. */
function saveOriginal(asarPath, bytes) {
  const directory = stateDirectory()
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'main.original.js')
  const metaPath = join(directory, 'main.original.json')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const meta = { size: bytes.length, sha256, asar: asarPath, savedAt: new Date().toISOString() }
  if (existsSync(path) && existsSync(metaPath)) {
    try {
      const previous = JSON.parse(readFileSync(metaPath, 'utf8'))
      if (previous.size === bytes.length && previous.sha256 === sha256 && existsSync(path)) {
        if (previous.asar !== asarPath) writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
        return meta
      }
    } catch {
      /* rewrite below */
    }
  }
  const temp = `${path}.tmp`
  writeFileSync(temp, bytes)
  renameSync(temp, path)
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
  return meta
}

/** Load the saved pre-patch file, validating size and digest. */
function loadOriginal() {
  const directory = stateDirectory()
  const path = join(directory, 'main.original.js')
  const metaPath = join(directory, 'main.original.json')
  if (!existsSync(path) || !existsSync(metaPath)) return undefined
  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch {
    return undefined
  }
  const bytes = readFileSync(path)
  if (bytes.length !== meta.size) return undefined
  if (createHash('sha256').update(bytes).digest('hex') !== meta.sha256) return undefined
  return { bytes, meta }
}

/**
 * Parse the patched file without executing it.
 * @param text - generated `lib/main.js`.
 */
function assertParses(text) {
  const file = join(tmpdir(), `dsh-restart-check-${String(process.pid)}-${String(Date.now())}.mjs`)
  writeFileSync(file, text)
  try {
    execFileSync(process.execPath, ['--check', file], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      windowsHide: true,
    })
  } finally {
    rmSync(file, { force: true })
  }
}

/**
 * Read-only report.
 * @param options - `{ asar }`.
 */
export function status(options = {}) {
  const asar = options.asar ?? resolveAsar()
  if (asar === undefined) {
    return { ok: false, status: 'missing', message: 'app.asar not found; is this the packaged Windows desktop app?' }
  }
  const { bytes, geometry } = readMain(asar)
  const text = bytes.toString('utf8')
  const state = textStatus(text)
  const saved = loadOriginal()
  const digest = createHash('sha256').update(bytes).digest('hex')
  return {
    ok: true,
    status: state,
    asar,
    mainBytes: geometry.size,
    headerBytes: geometry.jsonSize,
    backup: saved === undefined ? 'none' : 'saved',
    backupMatchesCurrent: saved !== undefined && saved.meta.sha256 === digest,
    stateDir: stateDirectory(),
  }
}

/**
 * Add the Restart entries when they are missing.
 * @param options - `{ asar, dryRun }`.
 */
export function apply(options = {}) {
  const asar = options.asar ?? resolveAsar()
  if (asar === undefined) {
    return { ok: false, status: 'missing', message: 'app.asar not found; is this the packaged Windows desktop app?' }
  }

  let current
  let geometry
  try {
    ;({ bytes: current, geometry } = readMain(asar))
  } catch (error) {
    return { ok: false, status: 'unsupported', asar, message: messageOf(error) }
  }

  const source = current.toString('utf8')
  let built
  try {
    built = buildPatch(source)
  } catch (error) {
    return { ok: false, status: 'unsupported', asar, message: messageOf(error) }
  }
  if (built.changed === false) {
    return { ok: true, status: 'already', asar, mainBytes: geometry.size }
  }
  if (validatePatched(built.text) !== true) {
    return { ok: false, status: 'unsupported', asar, message: 'generated patch failed its own validation' }
  }
  const bytes = Buffer.from(built.text, 'utf8')
  if (bytes.length !== geometry.size) {
    return { ok: false, status: 'unsupported', asar, message: 'generated patch is not length preserving' }
  }
  if (options.dryRun === true) {
    return { ok: true, status: 'dry-run', asar, mainBytes: geometry.size, note: 'patch would apply' }
  }

  try {
    assertParses(built.text)
  } catch (error) {
    return { ok: false, status: 'unsupported', asar, message: `generated shell failed the syntax check: ${messageOf(error)}` }
  }

  const backup = saveOriginal(asar, current)
  try {
    writeMain(asar, bytes)
  } catch (error) {
    try {
      writeMain(asar, current)
    } catch {
      /* the original bytes are on disk for a manual restore */
    }
    return { ok: false, status: 'write-failed', asar, message: messageOf(error) }
  }

  const after = status({ asar })
  if (after.status !== 'patched') {
    try {
      writeMain(asar, current)
    } catch {
      /* leave the backup for a manual restore */
    }
    return { ok: false, status: 'verify-failed', asar, message: 'archive does not read back as patched; original restored' }
  }

  return {
    ok: true,
    status: 'patched',
    asar,
    mainBytes: geometry.size,
    digest: createHash('sha256').update(bytes).digest('hex'),
    backup: join(stateDirectory(), 'main.original.js'),
    note: 'quit and reopen DeepSeek Harness to see the new Restart entries',
    saved: backup,
  }
}

/**
 * Write the saved pre-patch shell back.
 * @param options - `{ asar }`.
 */
export function restore(options = {}) {
  const asar = options.asar ?? resolveAsar()
  if (asar === undefined) {
    return { ok: false, status: 'missing', message: 'app.asar not found' }
  }
  const saved = loadOriginal()
  if (saved === undefined) {
    return { ok: false, status: 'no-backup', asar, message: 'no valid saved original; reinstall the desktop app' }
  }
  let geometry
  try {
    geometry = readArchive(asar)
  } catch (error) {
    return { ok: false, status: 'unsupported', asar, message: messageOf(error) }
  }
  if (geometry.size !== saved.bytes.length) {
    return {
      ok: false,
      status: 'size-mismatch',
      asar,
      message: `saved original is ${String(saved.bytes.length)} bytes but the installed shell is ${String(geometry.size)} bytes (the app was updated); use "apply" instead`,
    }
  }
  const { bytes } = readMain(asar)
  const current = textStatus(bytes.toString('utf8'))
  if (current === 'clean') {
    return { ok: true, status: 'clean', asar, note: 'shell already matches the stock layout; nothing to restore' }
  }
  if (current !== 'patched') {
    return {
      ok: false,
      status: 'unsupported',
      asar,
      message: 'the installed shell is neither the stock layout nor this plugin\'s patch; refusing to overwrite it',
    }
  }
  try {
    writeMain(asar, saved.bytes)
  } catch (error) {
    return { ok: false, status: 'write-failed', asar, message: messageOf(error) }
  }
  const after = status({ asar })
  if (after.status !== 'clean') {
    try {
      writeMain(asar, bytes)
    } catch {
      /* best effort */
    }
    return { ok: false, status: 'verify-failed', asar, message: 'archive does not read back as stock; previous bytes restored' }
  }
  return { ok: true, status: 'restored', asar, note: 'quit and reopen DeepSeek Harness to drop the Restart entries' }
}

/** Stable message for an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  // Electron's Node mode patches `node:fs` so `app.asar` looks like a
  // directory. This process only needs raw bytes, so opt out completely.
  try {
    process.noAsar = true
  } catch {
    /* not Electron */
  }

  const [command = 'status', ...rest] = process.argv.slice(2)
  const asarIndex = rest.indexOf('--asar')
  const asar = asarIndex >= 0 ? rest[asarIndex + 1] : undefined
  const json = rest.includes('--json')
  let result
  try {
    if (command === 'apply') result = apply({ asar, dryRun: rest.includes('--dry-run') })
    else if (command === 'restore') result = restore({ asar })
    else if (command === 'status') result = status({ asar })
    else throw new Error(`unknown command: ${command}`)
  } catch (error) {
    result = { ok: false, status: 'error', message: messageOf(error) }
  }
  writeFileSync(join(tmpdir(), 'dsh-restart-last-run.json'), `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.ok === true ? 0 : 1
}
