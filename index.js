/**
 * dsh-restart — Restart entries for the DeepSeek Harness desktop shell.
 *
 * The Windows caption menu ("应用") and the system tray are built by the
 * Electron main process (`resources/app.asar` -> `/lib/main.js`). DSH plugins
 * run in the Host child process and Cordis exposes no Electron, menu, or tray
 * service, so the only way to extend those menus is to patch that shell file.
 *
 * At every Host start this plugin runs `lib/patcher.mjs` in an asar-free Node
 * child: already patched archives are a read-only no-op, a freshly updated
 * desktop app is patched again, and an unknown shell layout is left untouched.
 *
 * Menu labels come from the shell's own locale dictionaries
 * (`restartApplication` / `aboutProduct`), so they follow the application
 * language setting exactly like the built-in Open/Quit items.
 *
 * @module dsh-restart
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name. */
export const name = 'restart'

/** This package's root directory. */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/** The standalone patcher run in a child process. */
const PATCHER = join(PACKAGE_ROOT, 'lib', 'patcher.mjs')

/** Where the patcher keeps the original shell and its last result. */
const STATE_DIR = process.env.DSH_RESTART_HOME ?? join(homedir(), '.dsh', 'dsh-restart')

/** How long to wait after activation before touching the archive. */
const DEFAULT_DELAY_MS = 2000

/**
 * Log one line through the Host logger, falling back to the console.
 * @param ctx - this plugin's Cordis context.
 * @param level - `info` or `warn`.
 * @param message - text to record.
 */
function log(ctx, level, message) {
  const line = `dsh-restart: ${message}`
  try {
    if (typeof ctx?.logger?.[level] === 'function') {
      ctx.logger[level](line)
      return
    }
  } catch {
    /* fall through */
  }
  try {
    if (level === 'warn') console.warn(line)
    else console.info(line)
  } catch {
    /* logging is best effort */
  }
}

/**
 * Keep the last run on disk so it can be inspected without a log sink.
 * @param payload - status record.
 */
function writeStatus(payload) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(join(STATE_DIR, 'status.json'), `${JSON.stringify(payload, null, 2)}\n`)
  } catch {
    /* never break activation for reporting */
  }
  try {
    appendFileSync(join(STATE_DIR, 'dsh-restart.log'), `${new Date().toISOString()} ${JSON.stringify(payload)}\n`)
  } catch {
    /* never break activation for reporting */
  }
}

/**
 * Run the patcher as a separate plain-Node process.
 * @param command - `status`, `apply`, or `restore`.
 * @returns the parsed result; never rejects.
 */
function runPatcher(command) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, [PATCHER, command, '--json'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, status: 'spawn-failed', message: errorMessage(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, status: 'timeout', message: 'patcher timed out after 60s' })
    }, 60_000)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, status: 'spawn-failed', message: errorMessage(error) })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)
      if (line === undefined) {
        resolve({ ok: false, status: 'no-output', code, message: stderr.trim() || `patcher exited with ${String(code)}` })
        return
      }
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({ ok: false, status: 'bad-output', code, message: line })
      }
    })
  })
}

/** Stable message for an unknown thrown value. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Patch the desktop shell at activation and keep it patched across updates.
 * @param ctx - this plugin's Cordis context.
 */
export function apply(ctx) {
  if (process.platform !== 'win32') {
    log(ctx, 'info', 'skipped: the caption and tray menus are Windows-only')
    return
  }
  ctx.effect(() => {
    const configured = Number.parseInt(process.env.DSH_RESTART_DELAY_MS ?? '', 10)
    const delay = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_DELAY_MS
    let disposed = false
    const timer = setTimeout(() => {
      if (disposed) return
      runPatcher('apply').then((result) => {
        if (disposed) return
        const record = { at: new Date().toISOString(), ...result }
        writeStatus(record)
        if (result.ok === true) {
          const message =
            result.status === 'patched'
              ? `shell patched (${result.asar}); quit and reopen DeepSeek Harness to show the Restart entries`
              : `shell already patched (${result.asar ?? 'unknown archive'})`
          log(ctx, 'info', message)
        } else if (result.status === 'missing') {
          log(ctx, 'info', 'skipped: no packaged Windows desktop shell found')
        } else {
          log(ctx, 'warn', `shell patch ${String(result.status)}: ${result.message ?? 'unknown error'}`)
        }
      })
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, 'dsh-restart: keep the desktop Restart entries patched')
}
