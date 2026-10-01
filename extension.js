const vscode = require('vscode')
const fs = require('fs')
const path = require('path')

const store = require('./lib/store')
const claude = require('./lib/claude')
const envBridge = require('./lib/env')
const usageLib = require('./lib/usage')
const profilesLib = require('./lib/profiles')
const liveLib = require('./lib/live')
const remoteLib = require('./lib/remote')
const artifactsLib = require('./lib/artifacts')
const secretsLib = require('./lib/secrets')
const shell = require('./lib/shell')
const credstore = require('./lib/credstore')
const trackerLib = require('./lib/tracker')
const locksLib = require('./lib/locks')
const windowsLib = require('./lib/windows')
const editionLib = require('./lib/edition')
const pageLib = require('./ui/page')

const DEFAULT_NAME = store.DEFAULT_NAME
const VIEW_ID = 'claudeswitcher.accountsView'
const CONTAINER_ID = 'claudeAccounts'

let edition = editionLib.EXPERIMENTAL
let version = null

let statusBar
let usageBar
let usageTimer
let output

function log(msg) {
  if (output) output.appendLine('[' + new Date().toISOString() + '] ' + msg)
}

function root() { return store.getRoot(vscode) }

function labelOf(name) { return (name && store.displayOf(root(), name).label) || name }

function windowPinnedDir() {
  const v = process.env.CLAUDE_CONFIG_DIR
  return v && v.trim() ? v.trim() : null
}

function firstFolder() {
  const f = vscode.workspace.workspaceFolders
  return f && f.length ? f[0].uri.fsPath : null
}

let pinState = null

function pinnedHere() {
  return !!(pinState && pinState.ready && (pinState.source === 'pin' || pinState.source === 'launch'))
}

function applyPin() {
  const claudeExt = vscode.extensions && vscode.extensions.getExtension('anthropic.claude-code')
  const claudeWasActive = !!(claudeExt && claudeExt.isActive)
  let d
  try {
    d = windowsLib.decide(root(), firstFolder(), process.env)
  } catch (e) {
    pinState = { error: e && e.message }
    return
  }
  if (!d || !d.source) return
  if (d.ready && d.name && windowsLib.isWindowDir(root(), d.dir)) {
    try { windowsLib.syncSettings(root(), d.name) } catch (e) { d.settingsError = e && e.message }
  }
  if (d.source === 'pin' && d.ready) process.env.CLAUDE_CONFIG_DIR = d.dir
  pinState = { ...d, folder: firstFolder(), claudeWasActive }
}

function currentAccount() {
  if (pinnedHere()) return { dir: pinState.dir, name: pinState.name, pinned: true }
  const launched = windowPinnedDir()
  if (launched) return { dir: launched, name: windowsLib.nameForDir(root(), launched), pinned: true }
  return { dir: null, name: profilesLib.activeProfile(root()), pinned: false }
}

function trustedTip(lines, commands) {
  const md = new vscode.MarkdownString(lines.filter((x) => x !== null && x !== undefined).join('\n\n'))
  md.supportThemeIcons = true
  md.isTrusted = { enabledCommands: commands }
  return md
}

function updateStatusBar() {
  if (!statusBar) return

  if (pinnedHere()) {
    const name = pinState.name
    const disp = name ? store.displayOf(root(), name) : { label: 'pinned', icon: 'account' }
    const id = name ? windowsLib.identity(root(), name) : null
    statusBar.command = 'claudeswitcher.pinFolder'
    statusBar.text = '$(pin) ' + disp.label
    statusBar.backgroundColor = undefined
    statusBar.tooltip = trustedTip([
      '**This window is pinned to ' + disp.label + '**',
      id && id.email ? 'Email: ' + id.email : null,
      id && id.org ? 'Org: ' + id.org : null,
      pinState.folder ? 'Folder: ' + pinState.folder : null,
      'Chats in this window run as ' + disp.label + '. The global switcher does not change ' +
        'this window, and the chat list is the same one every window shows.',
      pinState.claudeWasActive
        ? '_Claude Code started a moment before the pin was applied. Chats still run as ' + disp.label + '._'
        : null,
      name && store.getRemote(root(), name) === 'off' ? 'Remote Control: **off** for this account.' : null,
      name && store.getArtifacts(root(), name) === 'off' ? 'Artifacts: **off** for this account.' : null,
      '', 'Click to change or remove this folder\'s pin.',
    ], [])
    statusBar.show()
    return
  }

  const active = profilesLib.activeProfile(root())
  const id = profilesLib.currentIdentity()
  const disp = active ? store.displayOf(root(), active) : null
  const label = (disp && disp.label) || active || (id && id.email) || 'not saved'
  const launched = windowPinnedDir()
  statusBar.command = 'claudeswitcher.globalSwitch'
  statusBar.text = store.iconText((disp && disp.icon) || 'account') + ' ' + label
  statusBar.backgroundColor = active ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground')
  statusBar.tooltip = trustedTip([
    '**Claude account: ' + label + '**',
    id && id.email ? 'Email: ' + id.email : null,
    id && id.org ? 'Org: ' + id.org : null,
    'Every window that isn\'t pinned uses this account. Your chats stay right where they are when you switch.',
    active ? null : '⚠ This login isn\'t saved yet. Open the Claude Accounts page and choose "Save it" so you can come back to it later.',
    active && store.getRemote(root(), active) === 'off' ? 'Remote Control: **off** for this account.' : null,
    active && store.getArtifacts(root(), active) === 'off' ? 'Artifacts: **off** for this account.' : null,
    launched ? '⚠ This window was launched with CLAUDE_CONFIG_DIR=' + launched + ', so it does not follow the switcher.' : null,
    '', 'Click to switch accounts for every window that isn\'t pinned.',
  ], [])
  statusBar.show()
}

function usageIcon() {
  const v = vscode.workspace.getConfiguration('claudeswitcher').get('usageIcon')
  return v && store.validIcon(v) ? v : 'pulse'
}

function updateUsageBar() {
  if (!usageBar) return
  const cur = currentAccount()
  const usage = usageLib.readBest(root(), cur.dir)
  const text = usageLib.compactText(usage)
  const top = text ? usageLib.peak(usage) : 0
  usageBar.text = updatingAll ? '$(sync~spin) Updating…' : store.iconText(usageIcon()) + ' ' + (text || '--')
  usageBar.backgroundColor = top >= 95
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : top >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
  usageBar.tooltip = usageTooltip(cur, usage)
  usageBar.show()
}

function refreshAll() {
  updateStatusBar()
  updateUsageBar()
  postState()
}

function trackingEnabled() {
  return vscode.workspace.getConfiguration('claudeswitcher').get('trackAllAccounts') !== false
}

function mdEscape(t) { return String(t).replace(/[|\\[\]*_`<>]/g, (c) => '\\' + c) }

function useCell(l, withTime) {
  if (!l) return 'n/a'
  if (l.resetSince) return '0% (reset)'
  const left = withTime ? usageLib.untilTime(l.resetsAt) : null
  return l.percent + '%' + (left ? ' (' + left + ')' : '')
}

function snapshotRows() {
  try { return trackingEnabled() ? trackerLib.snapshot(root()) : [] } catch (e) {
    log('tracker snapshot: ' + e.message)
    return []
  }
}

function usageTooltip(cur, usage) {
  let rows = snapshotRows()
  if (!rows.length) {
    const now = Date.now()
    const top = usage && usage.scoped && usage.scoped[0]
    const scoped = top ? usageLib.effective(top, now) : null
    rows = [{ name: cur.name, active: true, needsLogin: false,
      session: usage ? usageLib.effective(usage.session, now) : null,
      weekly: usage ? usageLib.effective(usage.weekly, now) : null,
      scoped: scoped ? { ...scoped, model: usageLib.modelName(top) } : null }]
  }
  const named = rows.find((r) => r.scoped && r.scoped.model && r.scoped.model !== 'scoped')
  const model = named ? named.scoped.model : 'Fable'

  const GAP = '  ​'
  const table = [
    '| | Account | 5-hour' + GAP + ' | Weekly' + GAP + ' | ' + mdEscape(model) + ' |',
    '|---|---|--:|--:|--:|',
  ]
  for (const r of rows) {
    const label = mdEscape(labelOf(r.name) || r.name || 'This login')
    let name
    if (r.needsLogin) name = label + ' · login expired'
    else if (r.active || !r.name) name = '**' + label + '**'
    else {
      name = '[' + label + '](command:claudeswitcher.switchTo?' + encodeURIComponent(JSON.stringify([r.name])) +
        ' "Switch every window that isn\'t pinned to ' + label + '")'
    }
    const cells = r.needsLogin ? ['n/a' + GAP, 'n/a' + GAP, 'n/a']
      : [useCell(r.session, true) + GAP, useCell(r.weekly, true) + GAP, useCell(r.scoped, false)]
    table.push('| ' + (r.name && r.name === cur.name ? '$(check)' : '') + ' | ' + name + ' | ' + cells.join(' | ') + ' |')
  }

  const extra = usageLib.extraText(usage)
  return trustedTip([
    table.join('\n'),
    extra ? 'Extra usage for ' + mdEscape(labelOf(cur.name) || 'this account') + ': ' + extra + ' this month.' : null,
    'Click to update every account.  \nClick a name to switch to that account globally.  \n_(pinned folders are unaffected)_',
  ], ['claudeswitcher.switchTo'])
}

let trackerRunning = false
let trackerManual = false

let updatingAll = false
async function refreshAllAccounts() {
  if (trackerRunning || updatingAll) return
  updatingAll = true
  updateUsageBar()
  postState()
  try {
    await refreshLiveQuietly()
    if (trackingEnabled()) await trackerTick({ forcePoll: true, manual: true })
  } finally {
    updatingAll = false
    refreshAll()
  }
}

async function refreshLiveQuietly() {
  const dirs = [null]
  const cur = currentAccount()
  if (cur.dir) dirs.push(cur.dir)
  for (const dir of dirs) {
    const pauseKey = dir || DEFAULT_NAME
    if ((usagePausedUntil.get(pauseKey) || 0) > Date.now()) continue
    try {
      const res = await liveLib.fetchUsage(dir)
      if (res.ok) usageLib.writeLiveCache(root(), dir, res.utilization)
      else if (res.rateLimited) usagePausedUntil.set(pauseKey, Date.now() + (res.retryAfterMs || DEFAULT_USAGE_PAUSE_MS))
      else log('live usage (update): ' + res.reason)
    } catch (e) { log('live usage (update) failed: ' + (e && e.message)) }
  }
  updateUsageBar()
}

async function trackerTick(opts) {
  if (trackerRunning || !trackingEnabled()) return
  trackerRunning = true
  trackerManual = !!(opts && opts.manual)
  if (trackerManual) { updateUsageBar(); postState() }
  try {
    const results = await trackerLib.tick(root(), { forcePoll: !!(opts && opts.forcePoll) })
    if (trackerManual) {
      const limited = results.filter((r) => r.skipped === 'paused' || r.failed === 'rate-limited').map((r) => r.name)
      if (limited.length) {
        vscode.window.showInformationMessage('Updated. Anthropic is rate-limiting usage checks for ' +
          limited.join(', ') + ', so ' +
          (limited.length === 1 ? 'that account shows its' : 'those show their') + ' last figures for now.')
      }
    }
    for (const r of results) {
      if (r.renewed) log('renewed saved login for "' + r.name + '"')
      else if (r.failed === 'rejected') {
        log('saved login for "' + r.name + '" was rejected; marked sign-in-again')
        vscode.window.showWarningMessage('The saved login for "' + r.name + '" has expired.',
          'Sign In Again').then((c) => { if (c) relogin(r.name) }, () => {})
      } else if (r.failed) log('tracker: ' + r.name + ' ' + r.failed + (r.reason ? ': ' + r.reason : ''))
    }
  } catch (e) {
    log('tracker tick failed: ' + (e && e.message))
  } finally {
    trackerRunning = false
    trackerManual = false
    refreshAll()
  }
}

async function switchTo(name) {
  if (typeof name !== 'string' || !profilesLib.exists(root(), name)) return
  await ensureGlobalMode()
  await switchToProfile(name)
}

function launchTerminal(title, dir, args) {
  const bin = claude.resolveBin()
  if (!bin) {
    vscode.window.showErrorMessage("Couldn't find Claude Code's command-line tool (claude). Install Claude Code, or add it to your PATH, and try again.")
    return null
  }
  const env = { CLAUDE_CONFIG_DIR: dir || '' }
  const term = vscode.window.createTerminal({
    name: title, env, iconPath: new vscode.ThemeIcon('account'),
  })
  term.show()
  term.sendText(shell.invoke(bin, args))
  return term
}

let loginPollMs = 1500
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const IDENTITY_GRACE_MS = 10000
const loginWatchers = new Set()
const pendingLogins = new Set()

function watchLogin(dir, startedAt, cancelToken) {
  return new Promise((resolve) => {
    let lastCheckedMtime = 0
    let confirmed = null
    let confirmedAt = 0

    const finish = (result) => {
      clearInterval(timer)
      loginWatchers.delete(stop)
      resolve(result)
    }
    const stop = () => finish({ ok: false, reason: 'stopped' })

    const timer = setInterval(() => {
      if (cancelToken && cancelToken.isCancellationRequested) return finish({ ok: false, reason: 'cancelled' })
      if (Date.now() - startedAt > LOGIN_TIMEOUT_MS) return finish({ ok: false, reason: 'timed out' })

      if (confirmed) {
        const id = store.identityFromFile(path.join(dir, '.claude.json'))
        if ((id && id.email) || Date.now() - confirmedAt > IDENTITY_GRACE_MS) {
          finish({ ok: true, status: confirmed })
        }
        return
      }

      let mtime = 0
      try {
        const st = credstore.stat(dir)
        if (!st.exists) return
        mtime = st.modifiedMs
      } catch (e) { log('login watch: ' + (e && e.message)); return }
      if (mtime < startedAt - 2000 || mtime === lastCheckedMtime) return
      lastCheckedMtime = mtime

      const st = claude.authStatus(dir)
      if (st.ok && st.loggedIn) {
        confirmed = st
        confirmedAt = Date.now()
      }
    }, loginPollMs)
    loginWatchers.add(stop)
  })
}

function trackLogin(name, dir, startedAt, isNew) {
  const run = Promise.resolve(vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Waiting for "' + name + '" to finish signing in. Complete the login in the browser or terminal; this closes on its own.',
    cancellable: true,
  }, (_progress, token) => watchLogin(dir, startedAt, token)))
    .then((res) => {
      if (res.ok) return finalizeLogin(name, dir, res.status, isNew)
      if (res.reason === 'timed out') {
        vscode.window.showWarningMessage(
          'Stopped waiting for "' + name + '" after 15 minutes. If you did finish, reload the ' +
          'window and it will be picked up automatically.')
      }
      return null
    })
    .catch((e) => {
      log('login tracking for ' + name + ' failed: ' + (e && e.stack))
      vscode.window.showErrorMessage('Claude Accounts: ' + (e && e.message))
    })
  pendingLogins.add(run)
  run.then(() => pendingLogins.delete(run), () => pendingLogins.delete(run))
  return run
}

async function finalizeLogin(name, dir, st, isNew) {
  store.lockdown(dir)
  const fallback = { email: st.email, org: st.orgName }

  const dup = profilesLib.findByEmail(root(), st.email, name)
  if (dup) {
    const update = 'Update "' + dup + '"'
    const choice = await vscode.window.showWarningMessage(
      'You signed in as ' + st.email + ', which is already saved as "' + dup + '". ' +
      'Your browser probably reused an account it was already signed in to. ' +
      'Try a private window to sign in to a different one.',
      { modal: true }, update, 'Discard This Login')
    if (choice === update) {
      profilesLib.importFromDir(root(), dup, dir, { move: true, fallback })
      vscode.window.showInformationMessage('Refreshed the saved login for "' + dup + '".')
    } else {
      try { credstore.remove(dir) } catch (e) { log('discard failed: ' + (e && e.message)) }
    }
    if (isNew) store.removeAccount(root(), name)
    refreshAll()
    return
  }

  profilesLib.importFromDir(root(), name, dir, { move: true, fallback })

  if (profilesLib.activeProfile(root()) === name) {
    profilesLib.apply(root(), name)
    refreshAll()
    vscode.window.showInformationMessage('Signed "' + name + '" in again. Its fresh login is active now.')
    return
  }

  refreshAll()
  const go = await vscode.window.showInformationMessage(
    'Added "' + name + '"' + (st.email ? ' (' + st.email + ')' : '') + '. It is in the account switcher now.',
    'Switch to It Now')
  if (go === 'Switch to It Now') await switchToProfile(name)
}

function syncStagedLogins() {
  const imported = []
  for (const a of store.readRegistry(root()).accounts) {
    const dir = store.configDir(root(), a.name)
    let mtime
    try {
      const st = credstore.stat(dir)
      if (!st.exists) continue
      mtime = st.modifiedMs
    } catch (e) { log('staged login check for "' + a.name + '": ' + (e && e.message)); continue }
    if (profilesLib.exists(root(), a.name) && mtime <= profilesLib.capturedAt(root(), a.name)) continue

    const id = store.identity(root(), a.name)
    if (!id || !id.email) continue
    const dup = profilesLib.findByEmail(root(), id.email, a.name)
    if (dup) {
      log('not importing "' + a.name + '": it is the same account as "' + dup + '"')
      vscode.window.showWarningMessage('"' + a.name + '" is signed in as ' + id.email +
        ', which is already saved as "' + dup + '", so it was not added twice.')
      continue
    }
    try {
      profilesLib.importFromDir(root(), a.name, dir, { move: true })
      imported.push(a.name)
      log('imported staged login "' + a.name + '" (' + id.email + ')')
    } catch (e) {
      log('import of "' + a.name + '" failed: ' + (e && e.message))
    }
  }
  if (imported.length) refreshAll()
  return imported
}

function liveLoginUnsaved() {
  try { return profilesLib.hasCurrentLogin() && !profilesLib.activeProfile(root()) } catch { return false }
}

async function addAccount() {
  await ensureGlobalMode()
  if (liveLoginUnsaved()) {
    const id = profilesLib.currentIdentity()
    const pick = await vscode.window.showQuickPick([
      { label: '$(save) Save the account you are signed in to now', description: (id && id.email) || '', value: 'save' },
      { label: '$(sign-in) Sign in to another account', description: 'opens the Claude login in your browser', value: 'new' },
    ], { placeHolder: 'Add a Claude account' })
    if (!pick) return
    if (pick.value === 'save') return saveCurrentLogin()
  }
  return signInNewAccount()
}

async function signInNewAccount() {
  const name = await vscode.window.showInputBox({
    title: 'Add Claude Account',
    prompt: 'Short name for this account (letters, digits, . _ -)',
    placeHolder: 'work',
    validateInput: (v) => {
      if (!v) return 'Name is required'
      if (!store.validName(v)) return 'Use 1-32 chars: letters, digits, dot, underscore, hyphen'
      if (store.readRegistry(root()).accounts.some((a) => a.name === v)) return 'That name already exists'
      if (profilesLib.exists(root(), v)) return 'That name already exists'
      return null
    },
  })
  if (!name) return

  const email = await vscode.window.showInputBox({
    title: 'Add "' + name + '"',
    prompt: 'Email to pre-fill on the login page (optional)',
    placeHolder: 'you@example.com',
  })
  if (email === undefined) return

  const dir = store.addAccount(root(), name)
  refreshAll()

  const args = ['auth', 'login'].concat(email ? ['--email', email] : [])
  const startedAt = Date.now()
  if (!launchTerminal('Claude login: ' + name, dir, args)) return
  trackLogin(name, dir, startedAt, true)
}

async function saveCurrentLogin(suggested) {
  if (!profilesLib.hasCurrentLogin()) {
    vscode.window.showWarningMessage("You're not signed in to Claude Code yet, so there's nothing to save. Sign in first, then try again.")
    return null
  }
  const id = profilesLib.currentIdentity()
  const name = await vscode.window.showInputBox({
    title: 'Save Current Login',
    prompt: 'Name for the account currently signed in' + (id && id.email ? ' (' + id.email + ')' : ''),
    value: suggested || '',
    placeHolder: 'work-team',
    validateInput: (v) => {
      if (!v) return 'Name is required'
      if (!store.validName(v)) return 'Use 1-32 chars: letters, digits, dot, underscore, hyphen'
      return null
    },
  })
  if (!name) return null
  const saved = profilesLib.capture(root(), name)
  refreshAll()
  vscode.window.showInformationMessage('Saved "' + name + '"' + (saved.email ? ' (' + saved.email + ')' : '') + '.')
  return name
}

function globalItems() {
  const active = profilesLib.activeProfile(root())
  const rows = snapshotRows()
  const figures = (name) => {
    const r = rows.find((x) => x.name === name)
    if (!r) return null
    if (r.needsLogin) return 'sign in again'
    if (!r.session && !r.weekly) return null
    return '5h ' + useCell(r.session, false) + ' · weekly ' + useCell(r.weekly, false)
  }
  return profilesLib.list(root()).map((p) => ({
    label: (p.name === active ? '$(check) ' : '$(blank) ') + labelOf(p.name),
    description: [figures(p.name), p.email, p.org].filter(Boolean).join('  ·  '),
    name: p.name,
  }))
}

async function pickSaved(placeHolder) {
  const items = globalItems()
  if (!items.length) {
    vscode.window.showInformationMessage('No saved accounts yet.')
    return null
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true })
  return pick ? pick.name : null
}

async function relogin(nameArg) {
  const name = typeof nameArg === 'string' && profilesLib.exists(root(), nameArg)
    ? nameArg : await pickSaved('Sign in again to which account?')
  if (!name) return
  if (!store.readRegistry(root()).accounts.some((a) => a.name === name)) store.addAccount(root(), name)
  const dir = store.configDir(root(), name)
  const expected = (profilesLib.readMeta(root(), name) || {}).email
  const startedAt = Date.now()
  if (!launchTerminal('Claude login: ' + name, dir, ['auth', 'login'].concat(expected ? ['--email', expected] : []))) return
  trackLogin(name, dir, startedAt, false)
}

async function forgetAccount(nameArg) {
  const name = typeof nameArg === 'string' && profilesLib.exists(root(), nameArg)
    ? nameArg : await pickSaved('Forget which saved account?')
  if (!name) return
  const confirm = await vscode.window.showWarningMessage(
    'Forget "' + labelOf(name) + '"? This deletes the saved login only. ' +
    'Your chats, and the Claude account itself, are untouched.',
    { modal: true }, 'Forget')
  if (confirm !== 'Forget') return
  profilesLib.remove(root(), name)
  try { store.setArtifacts(root(), name, 'on') } catch (e) { log('artifacts pref: ' + e.message) }
  refreshAll()
  vscode.window.showInformationMessage('Forgot "' + labelOf(name) + '".')
}

function editAccount(name, label, icon, color) {
  if (!profilesLib.exists(root(), name)) return false
  const patch = {}
  if (typeof label === 'string' && store.validLabel(label.trim())) patch.label = label.trim()
  if (typeof icon === 'string' && store.validIcon(icon)) patch.icon = icon
  if (color === 'auto') patch.color = null
  else if (store.validColor(color)) patch.color = color
  if (!Object.keys(patch).length) return false
  store.setDisplay(root(), name, patch)
  refreshAll()
  return true
}

function applyRemotePreference(name) {
  if (!name) return null
  const off = store.getRemote(root(), name) === 'off'
  let res
  try { res = remoteLib.setDisabled(off) } catch (e) { log('remote control: ' + (e && e.message)); return null }
  if (res.changed) log('remote control ' + (off ? 'disabled' : 'enabled') + ' for "' + name + '"')
  return res
}

function applyArtifactPreference(name) {
  if (!name || !store.artifactsManaged(root())) return null
  const off = store.getArtifacts(root(), name) === 'off'
  let res
  try { res = artifactsLib.setOff(off) } catch (e) { log('artifacts: ' + (e && e.message)); return null }
  if (res.changed) log('artifacts ' + (off ? 'turned off' : 'back on') + ' for "' + name + '"')
  return res
}

function setArtifactsFor(name, on) {
  if (!profilesLib.exists(root(), name)) return
  store.setArtifacts(root(), name, on ? 'on' : 'off')
  let applied = false
  if (profilesLib.activeProfile(root()) === name) {
    try { applied = artifactsLib.setOff(!on).changed } catch (e) {
      log('artifacts: ' + (e && e.message))
      vscode.window.showWarningMessage('Artifacts: ' + (e && e.message))
    }
  }
  try {
    if (fs.existsSync(windowsLib.windowDir(root(), name)) && windowsLib.syncSettings(root(), name)) applied = true
  } catch (e) { log('window settings sync: ' + (e && e.message)) }
  refreshAll()
  vscode.window.showInformationMessage('Artifacts are ' + (on ? 'on' : 'off') + ' for "' + labelOf(name) + '"' +
    (on ? ' where Anthropic offers them' : '') +
    (applied ? '. New chats follow it; restart a running chat to be sure it does.' : '.'))
}

function setRemoteFor(name, on) {
  if (!profilesLib.exists(root(), name)) return
  store.setRemote(root(), name, on ? 'on' : 'off')
  let applied = false
  if (profilesLib.activeProfile(root()) === name) applied = !!(applyRemotePreference(name) || {}).changed
  try {
    if (fs.existsSync(windowsLib.windowDir(root(), name)) && windowsLib.syncSettings(root(), name)) applied = true
  } catch (e) { log('window settings sync: ' + (e && e.message)) }
  refreshAll()
  vscode.window.showInformationMessage('Remote Control is ' + (on ? 'on' : 'off') + ' for "' + labelOf(name) + '"' +
    (applied ? '. Chats already running keep their current connection until restarted.' : '.'))
}

async function ensureGlobalMode() {
  if (envBridge.currentConfigDir(vscode)) await envBridge.setConfigDir(vscode, null)
  if (store.getMode(root()) !== 'login') store.setMode(root(), 'login')
  return true
}

async function globalSwitch() {
  await ensureGlobalMode()
  syncStagedLogins()

  const items = globalItems()
  if (!items.length) {
    const go = await vscode.window.showInformationMessage(
      'No saved accounts yet. Save the account you are signed in as now, then add others.',
      'Save Current Login', 'Open Accounts')
    if (go === 'Save Current Login') await saveCurrentLogin()
    if (go === 'Open Accounts') await openAccounts()
    return
  }
  items.push({ label: '$(settings-gear) Manage accounts…', description: 'rename, Remote Control, pins, usage', manage: true })
  const pick = await vscode.window.showQuickPick(items,
    { placeHolder: 'Switch Claude to which account?', matchOnDescription: true })
  if (!pick) return
  if (pick.manage) return openAccounts()
  await switchToProfile(pick.name)
}

async function switchToProfile(name) {
  const pick = { name }
  const active = profilesLib.activeProfile(root())
  if (active === pick.name) {
    vscode.window.showInformationMessage('Already signed in as "' + labelOf(pick.name) + '".')
    return
  }

  const held = []
  const lockNames = [pick.name, active].filter(Boolean).sort()
  const gotLocks = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Waiting for a background login renewal to finish...' },
    async () => {
      for (const n of lockNames) {
        const release = await locksLib.acquire(root(), trackerLib.accountLock(n),
          { waitMs: 45000, staleMs: trackerLib.LOCK_STALE_MS })
        if (!release) return false
        held.push(release)
      }
      return true
    })
  if (!gotLocks) {
    held.forEach((r) => r())
    vscode.window.showErrorMessage('Switch cancelled: a background login renewal did not finish. Try again in a minute.')
    return
  }

  let applied
  try {
    if (active && profilesLib.hasCurrentLogin()) {
      try { profilesLib.capture(root(), active) } catch (e) { log('pre-switch capture failed: ' + e.message) }
    }
    usageLib.rememberClaudeCache(root(), null)
    applied = profilesLib.apply(root(), pick.name)
  } catch (e) {
    vscode.window.showErrorMessage('Switch failed: ' + (e && e.message))
    return
  } finally {
    held.forEach((r) => r())
  }

  applyRemotePreference(pick.name)
  applyArtifactPreference(pick.name)

  const st = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Switching to ' + labelOf(pick.name) + '...' },
    () => Promise.resolve(claude.authStatus(profilesLib.paths().claudeDir)))

  refreshAll()

  if (st.ok && !st.loggedIn) {
    vscode.window.showWarningMessage('Switched to "' + labelOf(pick.name) + '" but it reports signed out. ' +
      'Its saved login may have expired.', 'Sign In Again').then((c) => { if (c) relogin(pick.name) }, () => {})
    return
  }

  const who = (st.ok && st.email) || applied.email || pick.name
  if (pinnedHere()) {
    vscode.window.showInformationMessage('Other windows now use ' + who + '. This window stays on ' +
      labelOf(pinState.name) + ' because its folder is pinned.')
    return
  }
  const choice = await vscode.window.showInformationMessage(
    'Now signed in as ' + who + '. Your chats and history are untouched. ' +
    'Open chats keep the previous account until reopened.',
    'Reload Window', 'Not Now')
  if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow')
}

function accountItems(current) {
  return profilesLib.list(root()).map((p) => ({
    label: (p.name === current ? '$(pin) ' : '$(blank) ') + labelOf(p.name),
    description: [p.email, windowsLib.hasLogin(root(), p.name) ? 'window login ready' : 'needs a one-time sign-in']
      .filter(Boolean).join('  ·  '),
    name: p.name,
  }))
}

async function offerReload(message) {
  const choice = await vscode.window.showInformationMessage(message, 'Reload Window', 'Later')
  if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow')
}

async function pinFolder() {
  await ensureGlobalMode()
  const here = firstFolder()
  const herePin = here ? store.getPin(root(), here) : null

  let mode = 'other'
  if (here) {
    const choices = [
      { label: '$(folder) This folder', description: path.basename(here) + (herePin ? '  ·  pinned to ' + labelOf(herePin) : ''), value: 'here' },
      { label: '$(folder-opened) Another folder…', description: 'opens it in a new window', value: 'other' },
    ]
    if (herePin) choices.push({ label: '$(close) Unpin this folder', description: 'back to the global account', value: 'unpin' })
    const pick = await vscode.window.showQuickPick(choices, { placeHolder: 'Pin which folder?' })
    if (!pick) return
    mode = pick.value
  }

  if (mode === 'unpin') return unpinFolder(here)

  let target = here
  if (mode === 'other') {
    const sel = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Pin This Folder',
    })
    if (!sel || !sel.length) return
    target = sel[0].fsPath
    if (here && store.pinKey(here) === store.pinKey(target)) mode = 'here'
  }

  const current = store.getPin(root(), target)
  const items = accountItems(current)
  if (!items.length) {
    vscode.window.showInformationMessage('No saved accounts yet. Add one first.')
    return
  }
  const pick = await vscode.window.showQuickPick(items,
    { placeHolder: 'Run "' + path.basename(target) + '" as which account?' })
  if (!pick) return
  if (mode === 'here' && pick.name === current && pinnedHere()) {
    vscode.window.showInformationMessage('This folder is already pinned to that account.')
    return
  }
  if (!windowsLib.hasLogin(root(), pick.name) && !(await windowLogin(pick.name))) return
  store.setPin(root(), target, pick.name)
  refreshAll()

  if (mode === 'here') {
    await offerReload('"' + path.basename(target) + '" is pinned to ' + labelOf(pick.name) +
      '. Reload the window to start using it. A prompt still running in this window would be interrupted.')
    return
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true })
  log('opened "' + target + '" pinned to ' + pick.name)
}

async function unpinFolder(folder) {
  if (!folder || !store.getPin(root(), folder)) return
  store.setPin(root(), folder, null)
  refreshAll()
  const here = firstFolder()
  if (here && store.pinKey(here) === store.pinKey(folder) && pinnedHere()) {
    await offerReload('"' + path.basename(here) + '" is unpinned. Reload the window to go back to the global account.')
  } else {
    vscode.window.showInformationMessage('Unpinned "' + path.basename(folder) + '". Its windows use the global account after their next reload.')
  }
}

async function windowLogin(nameArg) {
  let name = typeof nameArg === 'string' && profilesLib.exists(root(), nameArg) ? nameArg : null
  if (!name) {
    const pick = await vscode.window.showQuickPick(accountItems(null),
      { placeHolder: 'Sign in a window login for which account?' })
    if (!pick) return false
    name = pick.name
  }
  if (pinnedHere() && pinState.name === name) {
    vscode.window.showWarningMessage('This window is using that window login right now. ' +
      'Sign it in again from another window.')
    return false
  }

  const expected = (profilesLib.readMeta(root(), name) || {}).email || null
  const dir = windowsLib.prepare(root(), name)
  const startedAt = Date.now()
  const args = ['auth', 'login'].concat(expected ? ['--email', expected] : [])
  if (!launchTerminal('Claude window login: ' + name, dir, args)) return false

  const res = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    cancellable: true,
    title: 'Signing in a window login for "' + name + '"' + (expected ? ' (' + expected + ')' : '') +
      '. Finish in the browser; use a private window if it is signed in to another account.',
  }, (_progress, token) => watchLogin(dir, startedAt, token))
  if (!res || !res.ok) {
    if (res && res.reason === 'timed out') {
      vscode.window.showWarningMessage('Stopped waiting for the window login for "' + name + '".')
    }
    return false
  }

  const id = windowsLib.identity(root(), name)
  const got = (res.status && res.status.email) || (id && id.email) || null
  if (expected && got && got.toLowerCase() !== expected.toLowerCase()) {
    try { credstore.remove(dir) } catch (e) { log('discarding wrong window login failed: ' + (e && e.message)) }
    await vscode.window.showWarningMessage('That signed in as ' + got + ', not ' + expected + ' ("' + name +
      '"), so the login was discarded. Your browser most likely reused another account: use a ' +
      'private window signed in to ' + expected + ' and try again.', { modal: true })
    return false
  }
  store.lockdown(dir)
  log('window login ready for "' + name + '"')
  refreshAll()
  vscode.window.showInformationMessage('Window login ready for "' + name + '"' + (got ? ' (' + got + ')' : '') + '.')
  return true
}

function windowLoginNames() {
  try {
    return fs.readdirSync(windowsLib.windowsRoot(root()))
      .filter((n) => store.validName(n) && fs.statSync(windowsLib.windowDir(root(), n)).isDirectory())
  } catch { return [] }
}

async function forgetWindowLogin(nameArg) {
  const names = windowLoginNames()
  let name = typeof nameArg === 'string' && names.includes(nameArg) ? nameArg : null
  if (!name) {
    if (!names.length) {
      vscode.window.showInformationMessage('No window logins yet.')
      return
    }
    const pick = await vscode.window.showQuickPick(names.map((n) => {
      const id = windowsLib.identity(root(), n)
      return { label: labelOf(n), description: id && id.email ? id.email : undefined, name: n }
    }), { placeHolder: 'Forget which window login?' })
    if (!pick) return
    name = pick.name
  }
  if (pinnedHere() && pinState.name === name) {
    vscode.window.showWarningMessage('This window is using that window login. Unpin this folder and ' +
      'reload first, or forget it from another window.')
    return
  }
  const confirm = await vscode.window.showWarningMessage('Forget the window login for "' + labelOf(name) +
    '"? Folders pinned to it go back to the global account. Your chats, and the account saved in ' +
    'the switcher, are not affected.', { modal: true }, 'Forget')
  if (confirm !== 'Forget') return
  const unpinned = store.unpinAccount(root(), name)
  windowsLib.remove(root(), name)
  refreshAll()
  vscode.window.showInformationMessage('Forgot the window login for "' + labelOf(name) + '"' +
    (unpinned ? '; ' + unpinned + ' folder pin' + (unpinned === 1 ? '' : 's') + ' removed.' : '.'))
}

async function showStatus() {
  output.show(true)
  output.appendLine('')
  output.appendLine('=== Claude accounts ===')
  output.appendLine('edition: ' + edition + (version ? '  v' + version : ''))
  output.appendLine('platform: ' + process.platform + '  ·  saved-account encryption: ' + secretsLib.describe())
  output.appendLine('live login read from: ' + credstore.describe(null))
  output.appendLine('root: ' + root())

  const active = profilesLib.activeProfile(root())
  const st = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking Claude accounts...' },
    () => Promise.resolve(claude.authStatus(profilesLib.paths().claudeDir)))
  output.appendLine('live login: ' + (st.ok
    ? (st.loggedIn ? 'signed in' : 'SIGNED OUT') + '  ' +
      [st.email, st.orgName ? '(' + st.orgName + ')' : null].filter(Boolean).join(' ')
    : 'ERROR: ' + st.error))
  output.appendLine('usage: ' + (usageLib.compactText(usageLib.readBest(root(), null)) || 'n/a'))
  output.appendLine('saved accounts:')
  const saved = profilesLib.list(root())
  if (!saved.length) output.appendLine('   (none saved yet)')
  for (const prof of saved) {
    output.appendLine(' ' + (prof.name === active ? '*' : ' ') + ' ' + prof.name.padEnd(16) +
      ' ' + [prof.email, prof.org].filter(Boolean).join('  ·  ') +
      (prof.capturedAt ? '   saved ' + new Date(prof.capturedAt).toISOString() : '') +
      (prof.needsLogin ? '   NEEDS SIGN-IN' : '') +
      (store.getRemote(root(), prof.name) === 'off' ? '   remote:off' : '') +
      (store.getArtifacts(root(), prof.name) === 'off' ? '   artifacts:off' : ''))
  }
  output.appendLine('(* = active)')
  output.appendLine('this window: ' + (pinnedHere()
    ? 'pinned to ' + pinState.name + ' (' + pinState.source + (pinState.claudeWasActive ? ', Claude Code started first' : '') + ')'
    : 'global account'))
  const pins = store.getPins(root())
  output.appendLine('folder pins: ' + (Object.keys(pins).length ? '' : '(none)'))
  for (const [folder, n] of Object.entries(pins)) output.appendLine('   ' + folder + '  ->  ' + n)
  const wl = windowLoginNames()
  output.appendLine('window logins: ' + (wl.length ? '' : '(none)'))
  for (const n of wl) {
    const id = windowsLib.identity(root(), n)
    output.appendLine('   ' + n.padEnd(16) + ' ' + (windowsLib.hasLogin(root(), n) ? 'signed in' : 'NOT signed in') +
      (id && id.email ? '  ' + id.email : '') + (windowsLib.linksHealthy(root(), n) ? '' : '   LINKS NEED REPAIR'))
  }
}

async function openConfigFile() {
  store.ensureRoot(root())
  const p = path.join(root(), 'registry.json')
  if (!fs.existsSync(p)) store.writeRegistry(root(), store.readRegistry(root()))
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p))
  await vscode.window.showTextDocument(doc)
}

let usageFetchInFlight = false

const usagePausedUntil = new Map()
const DEFAULT_USAGE_PAUSE_MS = 5 * 60 * 1000

function minutesFrom(ms) { return Math.max(1, Math.ceil(ms / 60000)) }

async function refreshUsage() {
  if (usageFetchInFlight) return

  const cur = currentAccount()
  const pauseKey = cur.dir || DEFAULT_NAME
  const pausedFor = (usagePausedUntil.get(pauseKey) || 0) - Date.now()
  if (pausedFor > 0) {
    vscode.window.showInformationMessage('Anthropic is rate-limiting usage checks for this ' +
      'account, so the meter is showing cached figures. Try again in about ' +
      minutesFrom(pausedFor) + ' min.')
    return
  }

  usageFetchInFlight = true
  const previousText = usageBar.text
  usageBar.text = '$(sync~spin) usage...'
  usageBar.tooltip = 'Fetching live usage from Anthropic...'

  try {
    const res = await liveLib.fetchUsage(cur.dir)
    if (res.ok) {
      usageLib.writeLiveCache(root(), cur.dir, res.utilization)
      updateUsageBar()
      postState()
      log('live usage fetched for ' + (cur.name || 'default'))
    } else if (res.rateLimited) {
      const wait = res.retryAfterMs || DEFAULT_USAGE_PAUSE_MS
      usagePausedUntil.set(pauseKey, Date.now() + wait)
      usageBar.text = previousText
      updateUsageBar()
      log('usage rate-limited for ' + (cur.name || 'default') + '; pausing ' + Math.round(wait / 1000) + 's')
      vscode.window.showWarningMessage('Anthropic is rate-limiting usage checks for this account ' +
        'right now, which is common just after switching. The meter is showing cached figures; ' +
        'try again in about ' + minutesFrom(wait) + ' min.')
    } else {
      usageBar.text = previousText
      updateUsageBar()
      vscode.window.showWarningMessage(
        'Couldn\'t fetch live usage: ' + res.reason + '. Showing the last figures we have for now.')
    }
  } catch (e) {
    usageBar.text = previousText
    updateUsageBar()
    vscode.window.showErrorMessage('Usage refresh failed: ' + (e && e.message))
  } finally {
    usageFetchInFlight = false
  }
}

let panel = null
let view = null
let extensionPath = __dirname

function mediaDir() { return path.join(extensionPath, 'media') }

function codiconDir() {
  try {
    const d = path.join(vscode.env.appRoot, 'out', 'media')
    return fs.existsSync(path.join(d, 'codicon.ttf')) ? d : null
  } catch { return null }
}

function webviewOptions() {
  const roots = [vscode.Uri.file(mediaDir())]
  const cd = codiconDir()
  if (cd) roots.push(vscode.Uri.file(cd))
  return { enableScripts: true, localResourceRoots: roots }
}

function pageHtml(webview, layout) {
  const cd = codiconDir()
  return pageLib.render({
    cspSource: webview.cspSource,
    cssUri: String(webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir(), 'accounts.css')))),
    jsUri: String(webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir(), 'accounts.js')))),
    fontUri: cd ? String(webview.asWebviewUri(vscode.Uri.file(path.join(cd, 'codicon.ttf')))) : null,
    layout,
  })
}

function pageState() {
  const active = profilesLib.activeProfile(root())
  const rows = snapshotRows()
  const best = rows.length ? trackerLib.mostRoom(rows) : null
  const pins = store.getPins(root())
  const pinCount = (name) => Object.values(pins).filter((n) => n === name).length
  const windowNames = windowLoginNames()
  const here = firstFolder()
  const id = profilesLib.currentIdentity()

  return {
    now: Date.now(),
    edition,
    version,
    tracking: trackingEnabled(),
    updating: updatingAll || (trackerRunning && trackerManual),
    features: { artifacts: editionLib.hasFeature(edition, 'artifacts') },
    live: { email: (id && id.email) || null, saved: !!active, label: active ? labelOf(active) : null },
    window: {
      folder: here,
      pinnedTo: pinnedHere() ? pinState.name : null,
      pinnedLabel: pinnedHere() ? labelOf(pinState.name) : null,
    },
    accounts: profilesLib.list(root()).map((p) => {
      const r = rows.find((x) => x.name === p.name) || {}
      const disp = store.displayOf(root(), p.name)
      const hasWindowDir = windowNames.includes(p.name)
      const wid = hasWindowDir ? windowsLib.identity(root(), p.name) : null
      return {
        name: p.name,
        label: disp.label,
        icon: disp.icon,
        color: disp.color,
        email: p.email || null,
        org: p.org || null,
        active: p.name === active,
        mostRoom: !!(best && best.name === p.name),
        needsLogin: !!p.needsLogin,
        remoteOff: store.getRemote(root(), p.name) === 'off',
        artifactsOff: store.getArtifacts(root(), p.name) === 'off',
        session: r.session || null,
        weekly: r.weekly || null,
        fetchedAtMs: r.fetchedAtMs || null,
        windowLogin: hasWindowDir ? { signedIn: windowsLib.hasLogin(root(), p.name), email: (wid && wid.email) || null } : null,
        pinCount: pinCount(p.name),
      }
    }),
    pins: Object.entries(pins).map(([folder, name]) => ({
      folder, name, label: labelOf(name), here: !!(here && store.pinKey(here) === folder),
    })),
  }
}

function postState() {
  const targets = []
  if (panel && panel.visible) targets.push(panel.webview)
  if (view && view.visible) targets.push(view.webview)
  if (!targets.length) return
  let state
  try { state = pageState() } catch (e) { log('page state: ' + (e && e.message)); return }
  for (const w of targets) w.postMessage({ type: 'state', state }).then(() => {}, () => {})
}

const PAGE_ACTIONS = {
  ready: () => postState(),
  switch: (m) => switchTo(m.name),
  add: () => addAccount(),
  saveCurrent: () => saveCurrentLogin(),
  update: () => refreshAllAccounts(),
  edit: (m) => {
    if (profilesLib.exists(root(), m.name) && !editAccount(m.name, m.label, m.icon, m.color)) {
      vscode.window.showWarningMessage('Use a display name of 1–40 characters.')
    }
  },
  remote: (m) => setRemoteFor(m.name, m.on === true),
  artifacts: (m) => { if (editionLib.hasFeature(edition, 'artifacts')) setArtifactsFor(m.name, m.on === true) },
  relogin: (m) => relogin(m.name),
  forget: (m) => forgetAccount(m.name),
  windowLogin: (m) => windowLogin(m.name),
  forgetWindowLogin: (m) => forgetWindowLogin(m.name),
  pin: () => pinFolder(),
  unpin: (m) => unpinFolder(m.folder),
  status: () => showStatus(),
  openConfig: () => openConfigFile(),
  openTab: () => openAccountsTab(),
  openSidebar: () => openAccountsSidebar(),
}

async function onPageMessage(msg) {
  if (!msg || typeof msg.type !== 'string' || !Object.prototype.hasOwnProperty.call(PAGE_ACTIONS, msg.type)) return
  for (const k of ['name', 'label', 'icon', 'color', 'folder']) {
    if (msg[k] !== undefined && typeof msg[k] !== 'string') return
  }
  if (msg.name !== undefined && !store.validName(msg.name)) return
  try {
    await PAGE_ACTIONS[msg.type](msg)
  } catch (e) {
    log('page action ' + msg.type + ' failed: ' + (e && e.stack))
    vscode.window.showErrorMessage('Claude Accounts: ' + (e && e.message))
  } finally {
    if (msg.type !== 'ready') postState()
  }
}

function openAccountsTab() {
  if (panel) {
    panel.reveal(undefined, false)
    postState()
    return
  }
  panel = vscode.window.createWebviewPanel('claudeswitcher.accounts', 'Claude Accounts',
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, webviewOptions())
  panel.iconPath = {
    light: vscode.Uri.file(path.join(mediaDir(), 'tab-light.svg')),
    dark: vscode.Uri.file(path.join(mediaDir(), 'tab-dark.svg')),
  }
  panel.webview.html = pageHtml(panel.webview, 'tab')
  panel.webview.onDidReceiveMessage(onPageMessage)
  let wasVisible = true
  panel.onDidChangeViewState(() => {
    const shown = !!(panel && panel.visible)
    if (shown && !wasVisible) postState()
    wasVisible = shown
  })
  panel.onDidDispose(() => { panel = null })
}

async function openAccountsSidebar() {
  await vscode.commands.executeCommand('workbench.view.extension.' + CONTAINER_ID)
  postState()
}

async function openAccounts() {
  const where = vscode.workspace.getConfiguration('claudeswitcher').get('accountsView')
  if (where === 'sidebar') return openAccountsSidebar()
  return openAccountsTab()
}

const viewProvider = {
  resolveWebviewView(webviewView) {
    view = webviewView
    webviewView.webview.options = webviewOptions()
    webviewView.webview.html = pageHtml(webviewView.webview, 'sidebar')
    webviewView.webview.onDidReceiveMessage(onPageMessage)
    webviewView.onDidChangeVisibility(() => { if (view && view.visible) postState() })
    webviewView.onDidDispose(() => { if (view === webviewView) view = null })
  },
}

function activate(context) {
  edition = editionLib.from(context)
  version = (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || null
  extensionPath = (context.extensionPath) || __dirname

  pinState = null
  applyPin()

  output = vscode.window.createOutputChannel('Claude Account Switcher')
  context.subscriptions.push(output)
  if (pinState) {
    log('folder pin: ' + JSON.stringify({ source: pinState.source, name: pinState.name, ready: pinState.ready,
      problem: pinState.problem, claudeWasActive: pinState.claudeWasActive, error: pinState.error }))
  }
  if (pinState && pinState.problem === 'no-login') {
    const n = pinState.name
    vscode.window.showWarningMessage('This folder is pinned to "' + n + '", which has no window login yet, ' +
      'so this window is using the global account.', 'Sign In Now').then((c) => {
      if (c === 'Sign In Now') vscode.commands.executeCommand('claudeswitcher.windowLogin', n)
    }, () => {})
  }

  store.ensureRoot(root())

  if (store.getMode(root()) !== 'login') {
    store.setMode(root(), 'login')
    log('switched to global mode (the older per-window modes were removed)')
  }
  if (envBridge.currentConfigDir(vscode)) {
    envBridge.setConfigDir(vscode, null)
      .then(() => log('cleared a machine-wide CLAUDE_CONFIG_DIR override'))
      .catch((e) => log('could not clear config dir override: ' + (e && e.message)))
  }

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.command = pinnedHere() ? 'claudeswitcher.pinFolder' : 'claudeswitcher.globalSwitch'
  statusBar.name = 'Claude Account'
  context.subscriptions.push(statusBar)

  usageBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
  usageBar.command = 'claudeswitcher.refreshAllAccounts'
  usageBar.name = 'Claude Usage'
  context.subscriptions.push(usageBar)

  const cmds = {
    openAccounts, globalSwitch, globalAdd: addAccount, pinFolder, refreshAllAccounts, showStatus,
    switchTo, refreshUsage, relogin, windowLogin, openAccountsTab,
  }
  for (const id of Object.keys(cmds)) {
    if (!editionLib.includes(edition, id)) continue
    context.subscriptions.push(vscode.commands.registerCommand('claudeswitcher.' + id, (...args) =>
      Promise.resolve(cmds[id](...args)).catch((e) => {
        log(id + ' failed: ' + (e && e.stack))
        vscode.window.showErrorMessage('Claude Accounts: ' + (e && e.message))
      })))
  }

  if (vscode.window.registerWebviewViewProvider) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, viewProvider))
  }

  try { applyRemotePreference(profilesLib.activeProfile(root())) } catch (e) { log('remote pref: ' + e.message) }
  try { applyArtifactPreference(profilesLib.activeProfile(root())) } catch (e) { log('artifacts pref: ' + e.message) }

  const recovered = syncStagedLogins()
  if (recovered.length) {
    vscode.window.showInformationMessage('Added to the account switcher: ' + recovered.join(', ') + '.')
  }

  try {
    const watcher = fs.watch(root(), (_ev, file) => {
      if (file === 'registry.json') refreshAll()
    })
    context.subscriptions.push({ dispose: () => watcher.close() })
  } catch (e) { log('registry watch unavailable: ' + (e && e.message)) }

  usageTimer = setInterval(() => updateUsageBar(), 60000)
  context.subscriptions.push({ dispose: () => clearInterval(usageTimer) })
  context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => {
    if (s.focused) { updateUsageBar(); postState() }
  }))
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('claudeswitcher.trackAllAccounts')) { refreshAll(); trackerTick() }
  }))

  const firstTick = setTimeout(trackerTick, 20000)
  const trackerTimer = setInterval(trackerTick, 5 * 60 * 1000)
  context.subscriptions.push({ dispose: () => { clearTimeout(firstTick); clearInterval(trackerTimer) } })
  context.subscriptions.push({ dispose: () => { if (panel) panel.dispose(); panel = null; view = null } })

  refreshAll()
  log('activated; edition=' + edition + '; root=' + root())
}

function stopLoginWatchers() {
  for (const stop of [...loginWatchers]) stop()
}

function deactivate() {
  if (usageTimer) clearInterval(usageTimer)
  stopLoginWatchers()
}

module.exports = {
  activate,
  deactivate,
  _test: {
    stopLoginWatchers,
    syncStagedLogins,
    settle: () => Promise.all([...pendingLogins]),
    setLoginPollMs: (ms) => { loginPollMs = ms },
    trackerTick,
    refreshAll,
    pageState,
    onPageMessage,
    viewProvider,
  },
}
