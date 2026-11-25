/**
 * DeepSeek Harness desktop shell patch (pure text functions).
 *
 * The Windows caption menu ("应用") and the system tray are built in the
 * Electron main process (`resources/app.asar` -> `/lib/main.js`). DSH plugins
 * run in the Host child process and Cordis exposes no Electron/tray service, so
 * the only way to extend those menus is a small patch to the shell file.
 *
 * This module turns the stock `main.js` text into the patched text without
 * executing anything. The result is byte-length preserving: the caller pads
 * with spaces, so every other file offset inside the asar stays valid.
 *
 * @module dsh-restart/lib/patch
 */

/** Marker written into the patched file, used for idempotency and status. */
export const MARK =
  '// dsh-restart: shell patch (managed by the dsh-restart plugin)'

/** Tail of `applicationItems()`: the separator, the macOS-only hide rows, then Quit. */
const MENU_OLD = '\t\t...hideCommands,\n\t\t{\n\t\t\trole: "quit",'

/** The new Restart row sits after that separator and immediately above Quit. */
const MENU_NEW =
  '\t\t...hideCommands,\n' +
  '\t\t{\n' +
  '\t\t\tlabel: currentDesktopLocale().messages.restartApplication,\n' +
  '\t\t\tclick: () => {\n' +
  '\t\t\t\tvoid restartApplication();\n' +
  '\t\t\t}\n' +
  '\t\t},\n' +
  '\t\t{\n' +
  '\t\t\trole: "quit",'

/** `main()` builds `applicationItems` after `quitting` / `backend` are initialized. */
const ITEMS_ANCHOR = '\tconst applicationItems = () => ['

/** The tray is constructed right after its icon path is resolved. */
const TRAY_CTOR_OLD =
  '\ttray = new DesktopTray({\n\t\t\ticonPath: trayIconPath,'

const TRAY_CTOR_NEW =
  '\ttray = new DesktopTray({\n' +
  '\t\t\ticonPath: trayIconPath,\n' +
  '\t\t\trestart: () => {\n' +
  '\t\t\t\tvoid restartApplication();\n' +
  '\t\t\t},'

/** Matches the whole stock `tray.setContextMenu(Menu.buildFromTemplate([...]));`. */
const TRAY_MENU_RE =
  /tray\.setContextMenu\(Menu\.buildFromTemplate\(\[[\s\S]{0,1500}?\]\)\);/

/** Compact replacement: Open / separator / Restart / separator / Quit. */
const TRAY_MENU_NEW =
  'tray.setContextMenu(Menu.buildFromTemplate([\n' +
  '\t\t\t{ label: messages.openApplication, click: () => { this.options.open(); } },\n' +
  '\t\t\t{ type: "separator" },\n' +
  '\t\t\t{ label: messages.restartApplication + " " + messages.aboutProduct, click: () => { this.options.restart(); } },\n' +
  '\t\t\t{ type: "separator" },\n' +
  '\t\t\t{ label: messages.quitApplication, click: () => { this.options.quit(); } }\n' +
  '\t\t]));'

/**
 * The restart action, injected into `main()`.
 *
 * The inspection and confirmation mirror the official Quit flow
 * (`backend.host.inspectQuit()` + `resolveDesktopQuitPrompt()`), so "restart"
 * interrupts running work only after the same explicit approval; an idle app
 * restarts immediately. The relaunch itself is the Electron primitive DSH's own
 * restart paths use: `app.relaunch()` followed by `quitWithoutConfirmation()`,
 * which runs the complete Host shutdown and starts a cold process.
 */
const RESTART_BLOCK =
  '\t' +
  MARK +
  '\n' +
  '\tconst restartApplication = async () => {\n' +
  '\t\tif (quitting) return;\n' +
  '\t\tlet prompt;\n' +
  '\t\ttry {\n' +
  '\t\t\tconst inspection = backend.host === void 0 ? void 0 : backend.host.inspectQuit();\n' +
  '\t\t\tprompt = inspection === void 0 ? void 0 : resolveDesktopQuitPrompt(await inspection);\n' +
  '\t\t} catch {\n' +
  '\t\t\tprompt = "quitActiveTasks";\n' +
  '\t\t}\n' +
  '\t\tif (prompt !== void 0) {\n' +
  '\t\t\tconst { messages } = currentDesktopLocale();\n' +
  '\t\t\tconst result = await dialog.showMessageBox({\n' +
  '\t\t\t\ttype: "none",\n' +
  '\t\t\t\t...process.platform === "win32" ? { icon: nativeImage.createFromPath(applicationIconPath) } : {},\n' +
  '\t\t\t\ttitle: messages.aboutProduct,\n' +
  '\t\t\t\tmessage: messages.restartApplication + " " + messages.aboutProduct + (/[\\u4e00-\\u9fff]/u.test(messages.restartApplication) ? "？" : "?"),\n' +
  '\t\t\t\tdetail: messages[prompt],\n' +
  '\t\t\t\tbuttons: [messages.restartApplication, messages.cancel],\n' +
  '\t\t\t\tdefaultId: 0,\n' +
  '\t\t\t\tcancelId: 1,\n' +
  '\t\t\t\tnoLink: true\n' +
  '\t\t\t});\n' +
  '\t\t\tif (result.response !== 0) return;\n' +
  '\t\t}\n' +
  '\t\tapp.relaunch();\n' +
  '\t\tquitWithoutConfirmation();\n' +
  '\t};\n'

/** Count non-overlapping occurrences. */
function count(haystack, needle) {
  if (needle === '') return 0
  let total = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    total += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return total
}

/**
 * Inspect a shell `main.js` text.
 * @param source - file contents.
 * @returns `'patched'`, `'clean'`, or `'unsupported'`.
 */
export function status(source) {
  if (typeof source !== 'string' || source === '') return 'unsupported'
  if (source.includes(MARK)) {
    return count(source, RESTART_BLOCK) === 1 &&
      count(source, MENU_NEW) === 1 &&
      count(source, TRAY_CTOR_NEW) === 1
      ? 'patched'
      : 'unsupported'
  }
  const tray = source.match(TRAY_MENU_RE)
  const clean =
    count(source, MENU_OLD) === 1 &&
    count(source, ITEMS_ANCHOR) === 1 &&
    count(source, TRAY_CTOR_OLD) === 1 &&
    tray !== null &&
    count(tray[0], 'label:') === 2 &&
    tray[0].includes('messages.openApplication') &&
    tray[0].includes('messages.quitApplication')
  return clean ? 'clean' : 'unsupported'
}

/** Documentation comments `//#region` / `//#endregion`; removing both is behaviour-free. */
const REGION_LINE_RE = /^\s*\/\/#(region|endregion)\b/

/**
 * Drop `//#region` + `//#endregion` marker pairs until `need` bytes are freed.
 * Markers are line comments between statements, so this changes no code.
 * @param text - patched text, still longer than the original.
 * @param need - bytes that must be freed.
 * @returns shortened text and the number of bytes freed.
 */
export function trimRegionMarkers(text, need) {
  if (need <= 0) return { text, freed: 0 }
  const lines = text.split('\n')
  const markers = []
  for (let i = 0; i < lines.length; i += 1) {
    if (REGION_LINE_RE.test(lines[i])) markers.push(i)
  }
  const drop = new Set()
  let freed = 0
  for (let i = 0; i + 1 < markers.length && freed < need; i += 2) {
    const start = markers[i]
    const end = markers[i + 1]
    if (!/^\s*\/\/#region\b/.test(lines[start])) continue
    if (!/^\s*\/\/#endregion\b/.test(lines[end])) continue
    drop.add(start)
    drop.add(end)
    freed += Buffer.byteLength(lines[start], 'utf8') + 1
    freed += Buffer.byteLength(lines[end], 'utf8') + 1
  }
  const kept = lines.filter((_, index) => !drop.has(index))
  return { text: kept.join('\n'), freed }
}

/**
 * Build the patched shell text.
 *
 * The returned text is never longer than `source`: anything extra is removed
 * from `//#region` markers (or reported as an error), and the caller pads the
 * remainder with spaces. That keeps the asar entry size and every other offset
 * untouched.
 *
 * @param source - stock or already patched `main.js` text.
 * @returns `{ changed, text, note }`.
 * @throws when the file is not the known stock layout or cannot fit.
 */
export function buildPatch(source) {
  if (typeof source !== 'string' || source === '') {
    throw new Error('main.js is empty or not text')
  }
  const state = status(source)
  if (state === 'patched') return { changed: false, text: source, note: 'already patched' }
  if (state !== 'clean') {
    throw new Error(
      'main.js layout is not the expected desktop shell (another DSH version or another shell patch); nothing written',
    )
  }

  let next = source
  next = next.replace(MENU_OLD, MENU_NEW)
  next = next.replace(ITEMS_ANCHOR, RESTART_BLOCK + ITEMS_ANCHOR)
  next = next.replace(TRAY_CTOR_OLD, TRAY_CTOR_NEW)

  const tray = next.match(TRAY_MENU_RE)
  if (tray === null) throw new Error('tray menu template disappeared during patching')
  next = next.replace(TRAY_MENU_RE, TRAY_MENU_NEW)

  const originalBytes = Buffer.byteLength(source, 'utf8')
  let over = Buffer.byteLength(next, 'utf8') - originalBytes
  if (over > 0) {
    const trimmed = trimRegionMarkers(next, over)
    next = trimmed.text
    over -= trimmed.freed
  }
  if (over > 0) throw new Error(`patch needs ${String(over)} more bytes than the shell file allows`)
  if (over < 0) next += ' '.repeat(-over)

  if (Buffer.byteLength(next, 'utf8') !== originalBytes) {
    throw new Error('length check failed after padding')
  }
  if (status(next) !== 'patched') throw new Error('patched text did not validate')
  return { changed: true, text: next, note: 'patch ready' }
}

/**
 * Whether the patched text still contains every anchor the restart action uses.
 * Used by the CLI after building, so a wrong insertion fails before writing.
 * @param text - patched text.
 */
export function validatePatched(text) {
  return (
    status(text) === 'patched' &&
    text.includes('app.relaunch();') &&
    text.includes('quitWithoutConfirmation();') &&
    text.includes('backend.host.inspectQuit()') &&
    text.includes('tray.setContextMenu(Menu.buildFromTemplate([') &&
    text.includes('messages.restartApplication + " " + messages.aboutProduct') &&
    text.includes('label: currentDesktopLocale().messages.restartApplication')
  )
}

export const anchors = { MENU_OLD, MENU_NEW, ITEMS_ANCHOR, TRAY_CTOR_OLD, TRAY_CTOR_NEW, TRAY_MENU_RE, TRAY_MENU_NEW }
