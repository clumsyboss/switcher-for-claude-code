const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')

const store = require('./lib/store')
const fsx = require('./lib/fsx')
const claude = require('./lib/claude')
const envBridge = require('./lib/env')
const usageLib = require('./lib/usage')
const profilesLib = require('./lib/profiles')
const liveLib = require('./lib/live')
const secretsLib = require('./lib/secrets')
const shell = require('./lib/shell')
const credstore = require('./lib/credstore')
const trackerLib = require('./lib/tracker')
const locksLib = require('./lib/locks')
const windowsLib = require('./lib/windows')
const editionLib = require('./lib/edition')
const editorsLib = require('./lib/editors')
const moveLib = require('./lib/movefile')
const transferLib = require('./lib/transfer')
const autoLib = require('./lib/autocontinue')
const kickoffLib = require('./lib/kickoff')
const switchLib = require('./lib/switch')
const preferencesLib = require('./lib/preferences')
const artifactsLib = require('./lib/artifacts')
const contextLib = require('./lib/context')
const pageLib = require('./ui/page')
const welcomeLib = require('./lib/welcome')
const chatPins = require('./lib/chatpins')
const loginsLib = require('./lib/logins')
const signinLib = require('./lib/signin')
const healthLib = require('./lib/health')
const requestsLib = require('./lib/requests')
const cardsLib = require('./lib/cards')

const DEFAULT_NAME = store.DEFAULT_NAME
const VIEW_ID = 'claudeswitcher.accountsView'
const PANEL_TYPE = 'claudeswitcher.accounts'
const CONTAINER_ID = 'claudeAccounts'

let edition = editionLib.EXPERIMENTAL
let version = null

let statusBar
let usageBar
let daysBar
let pinDaysBar
let usageTimer
let output

function log(msg) {
  if (output) output.appendLine('[' + new Date().toISOString() + '] ' + msg)
}

function root() { return store.getRoot(vscode) }

function labelOf(name) { return (name && store.displayOf(root(), name).label) || name }

function byLabel(a, b) {
  return String(labelOf(a.name)).localeCompare(String(labelOf(b.name)), undefined, { numeric: true, sensitivity: 'base' })
}

function inOrder(list) { return cardsLib.ordered(list, prefOf('accountOrder'), byLabel) }

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
  const folder = firstFolder()
  const launched = windowPinnedDir()
  if (launched) {
    pinState = { source: 'launch', dir: launched, name: windowsLib.nameForDir(root(), launched), ready: true, folder }
    return
  }
  let name = null
  try { name = folder ? store.getPin(root(), folder) : null } catch (e) { pinState = { error: e && e.message }; return }
  if (!name) { pinState = null; return }
  const ready = pinningReady(name)
  pinState = { source: 'pin', name, ready, folder, problem: ready ? null : 'no-pinning' }
}

const PINNING_MARGIN_MS = 60 * 60 * 1000

function pinningOf(name) {
  try {
    const i = name ? loginsLib.info(root(), name) : null
    return i && i.expiresAt ? { expiresAt: i.expiresAt } : null
  } catch { return null }
}

function pinningReady(name) {
  const p = pinningOf(name)
  return !!(p && p.expiresAt > Date.now() + PINNING_MARGIN_MS)
}

function repin() {
  applyPin()
  if (pinState) log('folder pin: ' + JSON.stringify({ source: pinState.source, name: pinState.name, ready: pinState.ready }))
  syncPins().catch((e) => log('pins: ' + (e && e.message)))
  refreshAll()
}

function runningOn() {
  const out = new Map()
  try { for (const u of loginsLib.listInUse(root())) if (u.sessionId && u.name) out.set(u.sessionId, u.name) } catch {  }
  return out
}

function claudeCacheMixed() {
  const active = profilesLib.activeProfile(root())
  try { return loginsLib.listInUse(root()).some((u) => u.name && u.name !== active) } catch { return false }
}

function accountCtx() {
  return { pins: store.getPins(root()), chatPins: chatPins.read(root()), liveLog: store.getLiveLog(root()), running: runningOn() }
}

function currentAccount() {
  const chat = focusedChatPin()
  if (chat) return { dir: null, name: chat, pinned: true, byKey: true, chat: true }
  if (pinnedHere()) return { dir: pinState.source === 'launch' ? pinState.dir : null, name: pinState.name, pinned: true, byKey: pinState.source === 'pin' }
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

function loginExpiryOf(name, dir, inUse) {
  const live = inUse ? usageLib.readLiveLoginExpiry(root(), dir) : null
  if (live) return live
  const m = name ? profilesLib.readMeta(root(), name) : {}
  return typeof m.loginExpiresAt === 'number' ? m.loginExpiresAt : null
}

function loginSuffix(expiresAt) {
  if (!prefOf('statusLoginDays')) return ''
  const t = usageLib.loginDaysText(expiresAt)
  return t ? ' (' + t + ')' : ''
}

function loginLine(expiresAt) {
  if (typeof expiresAt !== 'number') return null
  const days = Math.floor((expiresAt - Date.now()) / 86400000)
  const when = new Date(expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return expiresAt < Date.now() ? '⚠ Login expired on ' + when + '. Sign in again from the Accounts page.'
    : 'Login: sign in again by ' + when + ' (' + (days === 0 ? 'today' : days === 1 ? '1 day left' : days + ' days left') + ').'
}

function updateStatusBar() {
  if (!statusBar) return

  if (pinnedHere()) {
    const name = pinState.name
    const disp = name ? store.displayOf(root(), name) : { label: 'pinned', icon: 'account' }
    const meta = name ? profilesLib.readMeta(root(), name) || {} : {}
    statusBar.command = 'claudeswitcher.pinFolder'
    const pin = pinState.source === 'pin' && name ? pinningOf(name) : null
    const until = pin ? pin.expiresAt : loginExpiryOf(name, pinState.dir, true)
    statusBar.text = '$(pin) ' + disp.label
    statusBar.backgroundColor = undefined
    statusBar.tooltip = trustedTip([
      '**This window is pinned to ' + mdEscape(disp.label) + '**',
      meta.email ? 'Email: ' + mdEscape(meta.email) : null,
      pin ? 'Pinning login: ' + daysWords(pin.expiresAt) + '.' : loginLine(until),
      pinState.folder ? 'Folder: ' + mdEscape(pinState.folder) : null,
      'Chats in this folder run as ' + mdEscape(disp.label) + ', on its pinning login, so they never sign your other chats out. ' +
        'They keep your usual settings, skills and history. The global switcher doesn\'t change this folder.',
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
  const until = loginExpiryOf(active, null, true)
  statusBar.text = store.iconText((disp && disp.icon) || 'account') + ' ' + label
  statusBar.backgroundColor = active ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground')
  statusBar.tooltip = trustedTip([
    '**Claude account: ' + mdEscape(label) + '**',
    id && id.email ? 'Email: ' + mdEscape(id.email) : null,
    id && id.org ? 'Org: ' + mdEscape(id.org) : null,
    loginLine(until),
    'Every window that isn\'t pinned uses this account. Your chats stay right where they are when you switch.',
    active ? null : '⚠ This login isn\'t saved yet. Open the Claude Accounts page and choose "Save it" so you can come back to it later.',
    active && store.getRemote(root(), active) === 'off' ? 'Remote Control: **off** for this account.' : null,
    active && store.getArtifacts(root(), active) === 'off' ? 'Artifacts: **off** for this account.' : null,
    launched ? '⚠ This window was launched with CLAUDE_CONFIG_DIR=' + mdEscape(launched) + ', so it does not follow the switcher.' : null,
    store.registryError(root()) ? '⚠ ' + mdEscape(store.registryError(root())) : null,
    '', 'Click to switch accounts for every window that isn\'t pinned.',
  ], [])
  statusBar.show()
}

function usageShort(usage) {
  if (!usage) return null
  const p = (l) => (l && typeof l.percent === 'number' ? Math.round(l.percent) + '%' : null)
  const sc = Array.isArray(usage.scoped) ? usage.scoped[0] : null
  const model = sc && sc.scope && sc.scope.model && sc.scope.model.display_name
  const cells = [
    usage.session ? p(usage.session) : null,
    sc && p(sc) ? String(model || 'S').charAt(0).toUpperCase() + ' ' + p(sc) : null,
    usage.weekly && p(usage.weekly) ? 'W ' + p(usage.weekly) : null,
  ].filter(Boolean)
  return cells.length ? cells.join(' · ') : null
}

function daysShort(expiresAt) {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'ended'
  return ms < DAY_MS ? Math.max(1, Math.floor(ms / 3600000)) + 'h' : Math.floor(ms / DAY_MS) + 'd'
}

function daysColour(expiresAt) {
  if (expiresAt <= Date.now()) return new vscode.ThemeColor('errorForeground')
  return expiresAt - Date.now() < 5 * DAY_MS ? new vscode.ThemeColor('editorWarning.foreground') : undefined
}

function updateDaysBar() {
  if (!daysBar || !pinDaysBar) return
  const cur = currentAccount()
  const name = cur.name
  const main = name && !cur.dir ? mainEndOf(name) : loginExpiryOf(name, cur.dir, true)
  const pin = name ? pinningOf(name) : null
  if (!prefOf('statusLoginDays') || typeof main !== 'number') { daysBar.hide(); pinDaysBar.hide(); return }
  const tip = ['Main login: ' + (main <= Date.now() ? 'ended.' : daysPhrase(main) + ' left.'),
    pin ? 'Pinning login: ' + (pin.expiresAt <= Date.now() ? 'ended.' : daysPhrase(pin.expiresAt) + ' left.') : null].filter(Boolean).join(' ')
  daysBar.text = daysShort(main)
  daysBar.color = daysColour(main)
  daysBar.tooltip = tip
  daysBar.show()
  if (!pin) { pinDaysBar.hide(); return }
  pinDaysBar.text = '· $(pin) ' + daysShort(pin.expiresAt)
  pinDaysBar.color = daysColour(pin.expiresAt)
  pinDaysBar.tooltip = tip
  pinDaysBar.show()
}

function focusedChatPin() {
  try {
    const g = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup
    const t = g && g.activeTab
    const view = t && t.input && t.input.viewType
    if (typeof view !== 'string' || !/claudeVSCodePanel$/.test(view)) return null
    const p = chatPins.read(root()).find((x) => chatPins.tabMatches(t.label, x.title))
    return p && pinningReady(p.name) ? p.name : null
  } catch { return null }
}

function usageIcon() {
  const v = vscode.workspace.getConfiguration('claudeswitcher').get('usageIcon')
  return v && store.validIcon(v) ? v : 'pulse'
}

function updateUsageBar() {
  if (!usageBar) return
  if (!prefOf('statusUsage')) { usageBar.hide(); return }
  const cur = currentAccount()
  const usage = cur.byKey ? usageOfAccount(cur.name) : usageLib.readBest(root(), cur.dir, { skipClaude: !cur.dir && claudeCacheMixed() })
  const text = usageShort(usage)
  const top = text ? usageLib.peak(usage) : 0
  usageBar.text = updatingAll ? '$(sync~spin) Updating…' : store.iconText(usageIcon()) + ' ' + (text ? text + (usage.stale ? ' (old)' : '') : '--')
  usageBar.backgroundColor = top >= 95
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : top >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
  usageBar.tooltip = usageTooltip(cur, usage)
  usageBar.show()
  updateDaysBar()
}

function refreshAll() {
  updateStatusBar()
  updateUsageBar()
  updateContextBar()
  postState()
}

let contextBar = null
let contextCache = { chats: [], at: 0 }

function refreshContext() {
  if (!editionLib.hasFeature(edition, 'context')) return
  try {
    try { store.recordLive(root(), profilesLib.activeProfile(root())) } catch {  }
    contextCache = { chats: contextLib.withFill(contextLib.recentChats({})), at: Date.now() }
  } catch (e) { log('context: ' + (e && e.message)) }
  updateContextBar()
  postState()
}

function themeKind() {
  const k = vscode.window.activeColorTheme && vscode.window.activeColorTheme.kind
  return k === 1 || k === 4 ? 'light' : 'dark'
}

let compactAnim = null
let compactingIds = new Set()
let compactTick = 0
function checkCompacting() {
  if (!contextBar) return
  compactTick++
  const mine = contextLib.currentChat(contextCache.chats, firstFolder())
  const now = new Set()
  for (const c of contextCache.chats) {
    if (c !== mine && compactTick % 10 !== 0) {
      if (compactingIds.has(c.id)) now.add(c.id)
      continue
    }
    try { if (contextLib.isCompacting(c)) now.add(c.id) } catch {  }
  }
  const changed = now.size !== compactingIds.size || [...now].some((id) => !compactingIds.has(id))
  const finished = [...compactingIds].some((id) => !now.has(id))
  compactingIds = now
  if (changed) { updateContextBar(); postState() }
  if (finished && !compactAnim) { refreshContext(); return }
  const cur = contextLib.currentChat(contextCache.chats, firstFolder())
  const on = !!(cur && compactingIds.has(cur.id))
  if (on && !compactAnim) {
    let i = 0
    compactAnim = setInterval(() => { contextBar.text = contextLib.fillFrame(i++, 5) }, 100)
  } else if (!on && compactAnim) {
    clearInterval(compactAnim)
    compactAnim = null
    refreshContext()
  }
}

function updateContextBar() {
  if (!contextBar) return
  const chats = contextCache.chats
  const cur = contextLib.currentChat(chats, firstFolder())
  if (!cur) { contextBar.hide(); return }
  if (!compactAnim) contextBar.text = contextLib.brailleBar(cur.pct, 5)
  contextBar.color = new vscode.ThemeColor(cur.pct >= 95 ? 'charts.red' : cur.pct >= 80 ? 'charts.yellow' : 'charts.green')
  contextBar.tooltip = contextTooltip(cur, chats)
  contextBar.show()
}

function contextTooltip(cur, chats) {
  const theme = themeKind()
  const entry = (c, rows) => '**' + mdEscape(c.title) + '** · ' + c.pct + '%  \n![](' +
    contextLib.svgDataUri(contextLib.gridSvg(c.pct, { cols: 20, rows, size: 10, gap: 3, theme, shuffle: compactingIds.has(c.id) })) + ')'
  const parts = [entry(cur, 5)]
  for (const c of chats) if (c !== cur) parts.push(entry(c, 2))
  const md = new vscode.MarkdownString(parts.slice(0, 7).join('\n\n'))
  md.supportThemeIcons = true
  return md
}

function contextByAccount() {
  if (!editionLib.hasFeature(edition, 'context')) return {}
  const ctx = accountCtx()
  const out = {}
  for (const c of contextCache.chats) {
    const name = contextLib.accountOf(c, ctx)
    if (name && !out[name]) out[name] = { pct: c.pct, compacting: compactingIds.has(c.id) }
  }
  return out
}

function orgOf(name) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(store.configDir(root(), name), '.claude.json'), 'utf8'))
    return (j && j.oauthAccount && j.oauthAccount.organizationUuid) || null
  } catch { return null }
}

const PREFS = {
  tint: { key: 'cards.tint', def: true },
  context: { key: 'cards.context', def: false },
  cardToggles: { key: 'cards.toggles', def: true },
  statusUsage: { key: 'statusBar.usage', def: true },
  statusLoginDays: { key: 'statusBar.loginDays', def: true },
  confirmOrgSwitch: { key: 'confirmOrganizationSwitch', def: true },
  trackAll: { key: 'trackAllAccounts', def: true },
  accountsView: { key: 'accountsView', def: 'tab', values: ['tab', 'sidebar'] },
  askSecondLogin: { state: 'claudeswitcher.askSecondLogin', def: true },
  compact: { state: 'claudeswitcher.compactView', def: false },
  validity: { state: 'claudeswitcher.validityStroke', def: true },
  listView: { state: 'claudeswitcher.listView', def: false },
  groupByOrg: { state: 'claudeswitcher.groupByOrg', def: false },
  accountOrder: { state: 'claudeswitcher.accountOrder', def: [], clean: (v) => cardsLib.cleanOrder(v, accountNames()) },
  dismissedNotes: { state: 'claudeswitcher.dismissedNotes', def: {}, clean: (v) => cardsLib.cleanNotes(v, accountNames()) },
}

function accountNames() { try { return profilesLib.list(root()).map((p) => p.name) } catch { return [] } }

function prefOf(name) {
  const p = PREFS[name]
  if (p.state) {
    const v = extContext && extContext.globalState ? extContext.globalState.get(p.state) : undefined
    if (p.clean) { const c = v === undefined ? null : p.clean(v); return c === null ? p.def : c }
    return typeof v === 'boolean' ? v : p.def
  }
  const v = vscode.workspace.getConfiguration('claudeswitcher').get(p.key)
  if (p.values) return p.values.includes(v) ? v : p.def
  return typeof v === 'boolean' ? v : p.def
}

function allPrefs() {
  const out = {}
  for (const name of Object.keys(PREFS)) out[name] = prefOf(name)
  return out
}

function setPref(name, value) {
  const p = Object.prototype.hasOwnProperty.call(PREFS, name) ? PREFS[name] : null
  if (!p) return Promise.resolve()
  if (p.clean) {
    if (!accountNames().length) return Promise.resolve()
    const c = p.clean(value)
    if (c === null) return Promise.resolve()
    value = c
  } else if (p.values ? !p.values.includes(value) : typeof value !== 'boolean') return Promise.resolve()
  if (p.state) return extContext && extContext.globalState ? Promise.resolve(extContext.globalState.update(p.state, value)) : Promise.resolve()
  return vscode.workspace.getConfiguration('claudeswitcher').update(p.key, value, vscode.ConfigurationTarget.Global)
}

const PRESERVED_THINKING_URL = 'https://platform.claude.com/docs/en/build-with-claude/preserved-thinking'

function setConfirmOrgSwitch(on) { return setPref('confirmOrgSwitch', !!on) }

function confirmOrgSwitchOn() { return prefOf('confirmOrgSwitch') }

async function confirmOrgSwitch(name) {
  if (!confirmOrgSwitchOn()) return true
  const active = profilesLib.activeProfile(root())
  if (!name || name === active) return true
  const id = active ? null : profilesLib.currentIdentity()
  const from = active ? orgOf(active) : (id && id.orgUuid)
  const to = orgOf(name)
  if (!from || !to || from === to) return true
  const pick = await notify('warn', labelOf(name) + ' is in another organization',
    { modal: true, detail: 'Chats that continue there can’t use Claude’s earlier thinking or cache, so the whole chat is read again and uses more tokens.' },
    'Learn More', 'Switch')
  if (pick === 'Learn More') {
    vscode.env.openExternal(vscode.Uri.parse(PRESERVED_THINKING_URL))
    return false
  }
  return pick === 'Switch'
}

function trackingEnabled() {
  return vscode.workspace.getConfiguration('claudeswitcher').get('trackAllAccounts') !== false
}

function mdEscape(t) { return String(t).replace(/[\r\n]+/g, ' ').replace(/[|\\[\]*_`<>!()#~]/g, (c) => '\\' + c) }

function useCell(l, withTime) {
  if (!l) return 'n/a'
  if (l.resetSince) return '0% (reset)'
  const left = withTime ? usageLib.untilTime(l.resetsAt) : null
  return l.percent + '%' + (left ? ' (' + left + ')' : '')
}

function usageOfAccount(name) {
  const r = snapshotRows().find((x) => x.name === name)
  if (!r) return null
  return { session: r.session || null, weekly: r.weekly || null, scoped: r.scoped ? [r.scoped] : [], fetchedAtMs: r.fetchedAtMs || null, stale: !!r.stale }
}

function snapshotRows() {
  try { return trackingEnabled() ? trackerLib.snapshot(root(), { skipClaudeCache: claudeCacheMixed() }) : [] } catch (e) {
    log('tracker snapshot: ' + e.message)
    return []
  }
}

function staleLine(cur, usage) {
  const who = mdEscape(labelOf(cur.name) || 'This account')
  const why = 'a chat runs on another account\'s pinning login, so Claude Code\'s own figures can\'t be told apart, and the Switcher hasn\'t read newer ones ' +
    '(usage tracking is off, or Anthropic asked it to wait).'
  if (usage && usage.stale && usage.fetchedAtMs) return '_' + who + '\'s figures are from ' + clockText(usage.fetchedAtMs) + ': ' + why + '_'
  if (!usage && !cur.dir && !cur.byKey && claudeCacheMixed()) return '_No current figures for ' + who + ': ' + why + '_'
  return null
}

function usageTooltip(cur, usage) {
  let rows = inOrder(snapshotRows()).sort((a, b) => b.active - a.active)
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
      if (canStartSession(r)) {
        name += ' [$(play)](command:claudeswitcher.startSession?' + encodeURIComponent(JSON.stringify([r.name])) +
          ' "Start a 5-hour session for ' + label + '")'
      }
    }
    const cells = r.needsLogin ? ['n/a' + GAP, 'n/a' + GAP, 'n/a']
      : [(r.noSession ? 'none' : useCell(r.session, true)) + GAP, useCell(r.weekly, true) + GAP, useCell(r.scoped, false)]
    table.push('| ' + (r.name && r.name === cur.name ? '$(check)' : '') + ' | ' + name + ' | ' + cells.join(' | ') + ' |')
  }

  const extra = usageLib.extraText(usage)
  return trustedTip([
    table.join('\n'),
    staleLine(cur, usage),
    extra ? 'Extra usage for ' + mdEscape(labelOf(cur.name) || 'this account') + ': ' + extra + ' this month.' : null,
    'Click to update every account.  \nClick a name to switch to that account globally.  \n_(pinned folders are unaffected)_',
  ], ['claudeswitcher.switchTo', 'claudeswitcher.startSession'])
}

let trackerRunning = false
let trackerManual = false

const startingSessions = new Set()
let kickoffRun = null

function sessionRunning(limit) {
  if (!limit || limit.resetSince || !limit.resetsAt) return false
  return Date.parse(limit.resetsAt) > Date.now()
}

function canStartSession(row) {
  return editionLib.hasFeature(edition, 'startSession') && !!row && !!row.name && !row.active && !row.needsLogin &&
    !row.noSession && !sessionRunning(row.session) && !startingSessions.has(row.name)
}

async function startSessionFor(nameArg) {
  if (!editionLib.hasFeature(edition, 'startSession')) return
  const name = typeof nameArg === 'string' && profilesLib.exists(root(), nameArg) ? nameArg : null
  if (!name || startingSessions.has(name)) return
  const label = labelOf(name)
  if (name === profilesLib.activeProfile(root())) {
    notify('info', '"' + label + '" is the account Claude Code is using, so its session starts with your next message.')
    return
  }
  const row = snapshotRows().find((r) => r.name === name)
  if (row && sessionRunning(row.session)) {
    notify('info', '"' + label + '" already has a 5-hour session running. It resets in ' +
      (usageLib.untilTime(row.session.resetsAt) || 'a moment') + '.')
    return
  }

  startingSessions.add(name)
  refreshAll()
  try {
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Starting a 5-hour session for "' + label + '"…' },
      () => kickoffLib.startSession(root(), name, { renew: trackerLib.renew, run: kickoffRun || undefined }))
    if (!res || !res.ok) {
      log('start session for "' + name + '" failed: ' + (res && res.reason))
      notify('warn', "Couldn't start a session for \"" + label + '": ' + ((res && res.reason) || 'something went wrong') + '.')
      return
    }
    log('started a 5-hour session for "' + name + '"')
    try { await trackerLib.poll(root(), name, { force: true }) } catch (e) { log('usage after start: ' + (e && e.message)) }
    const after = snapshotRows().find((r) => r.name === name)
    const left = after && sessionRunning(after.session) ? usageLib.untilTime(after.session.resetsAt) : null
    notify('info', 'Started a 5-hour session for "' + label + '".' +
      (left ? ' It resets in ' + left + '.' : ' Its usage will catch up in a moment.'))
  } finally {
    startingSessions.delete(name)
    refreshAll()
  }
}

let handoffRun = null
let keepAliveRun = null
let limitChecking = false
const keepAliveBusy = new Set()
const LIMIT_WORDS = { session: '5-hour limit', weekly: 'weekly limit', model: 'weekly model limit' }
const ACTIVE_STOP = ['new', 'asked', 'waiting', 'switching', 'sending', 'sent', 'trust']

function autoContinueOn() { return editionLib.hasFeature(edition, 'autoContinue') }

function clockText(ms) {
  const d = new Date(ms)
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + t
}

const sameProject = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

function chatIsHere(chat) {
  const f = firstFolder()
  return !!f && contextLib.folderKeys(f).some((k) => sameProject(k, chat.project))
}

function chatPin(chat) {
  const running = runningOn().get(chat.id)
  if (running) return running
  return pinnedTo(chat)
}

function pinnedTo(chat) {
  const own = chatPins.read(root()).find((p) => p.id === chat.id)
  if (own) return own.name
  for (const [folder, name] of Object.entries(store.getPins(root()))) {
    if (contextLib.folderKeys(folder).some((k) => sameProject(k, chat.project))) return name
  }
  return null
}

function openChat(sessionId, prompt) {
  vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId, prompt).then(() => {}, (e) => {
    log('open chat: ' + (e && e.message))
    notify('warn', "Couldn't open the chat in Claude Code. Open it yourself and type \"continue\".")
  })
}

const ROOM_SEEN_KEY = 'claudeswitcher.roomBackSeen'
const roomWaiting = {}
const roomPolled = new Set()
let roomChecking = false
const ROOM_READ_AFTER_MS = 60 * 1000

const roomTold = new Set()

function pageOnScreen() { return !!(noticesInPage && ((panel && panel.visible) || (view && view.visible))) }

async function roomBackCheck() {
  if (roomChecking) return
  if (!trackingEnabled()) { for (const k of Object.keys(roomWaiting)) delete roomWaiting[k]; return }
  roomChecking = true
  try {
    const gs = extContext && extContext.globalState
    const seenNow = () => { const v = gs && gs.get(ROOM_SEEN_KEY); return v && typeof v === 'object' ? v : {} }
    const seenFor = () => (pageOnScreen() ? {} : seenNow())
    let res = cardsLib.roomBack(snapshotRows(), roomWaiting, seenFor(), Date.now())
    let read = false
    for (const name of res.due) {
      const until = roomWaiting[name]
      const k = name + ':' + until
      if (!until || roomPolled.has(k) || Date.now() < until + ROOM_READ_AFTER_MS || trackerRunning) continue
      roomPolled.add(k)
      try {
        const r = await trackerLib.poll(root(), name, { force: true })
        if (r && r.polled) read = true
      } catch (e) { log('room again: read ' + name + ': ' + (e && e.message)) }
    }
    if (read) { res = cardsLib.roomBack(snapshotRows(), roomWaiting, seenFor(), Date.now()); refreshAll() }
    const inPage = pageOnScreen()
    const fire = res.fire.filter((f) => !roomTold.has(f.name + ':' + f.until))
    const canTell = inPage || (panel && panel.visible) || (view && view.visible) || (vscode.window.state && vscode.window.state.focused)
    if (!fire.length || !canTell) return
    const active = profilesLib.activeProfile(root())
    const seen = Object.assign({}, seenNow())
    const names = new Set(accountNames())
    for (const k of Object.keys(seen)) if (!names.has(k)) delete seen[k]
    const tell = fire.filter((f) => f.name !== active && names.has(f.name) && (inPage || seen[f.name] !== f.until))
    for (const f of fire) { seen[f.name] = f.until; roomTold.add(f.name + ':' + f.until) }
    if (gs) await gs.update(ROOM_SEEN_KEY, seen)
    for (const f of tell) {
      log('room again: ' + f.name)
      notify('info', labelOf(f.name) + ' has room again', 'Switch').then(async (v) => {
        if (v === 'Switch' && await confirmOrgSwitch(f.name)) await switchTo(f.name)
      }, () => {})
    }
  } catch (e) {
    log('room again: ' + (e && e.message))
  } finally {
    roomChecking = false
  }
}

async function checkLimits() {
  if (!autoContinueOn() || limitChecking) return
  limitChecking = true
  try {
    const settings = store.getAutoContinue(root())
    const now = Date.now()
    for (const [id, e] of Object.entries(autoLib.readState(root()).stops)) {
      if (e.state === 'waiting' && e.resetAt && now >= e.resetAt + autoLib.AFTER_RESET_MS) {
        if (e.to && e.to !== profilesLib.activeProfile(root())) await switchAndContinue({ ...e, id }, e.to)
        else await deliverNotice(id, 'reset')
      }
      else if (e.state === 'sent' && now - (e.sentAt || 0) > 45000) followUp(id, e)
      else if (e.state === 'trust' && autoLib.trusted(e.file, e.trustAt)) await deliverNotice(id, 'reset', { again: true })
    }
    if (settings.mode === 'off') return
    for (const c of contextCache.chats) {
      const stop = autoLib.limitStop(c.file)
      if (!stop || now - (stop.at || now) > autoLib.MAX_WAIT_MS) continue
      const known = autoLib.readState(root()).stops
      if (known[stop.id]) continue
      if (Object.values(known).some((e) => e.chat === c.id && ACTIVE_STOP.includes(e.state) &&
        now - (e.at || 0) < autoLib.MAX_WAIT_MS)) continue
      if (!chatIsHere(c) && now - (stop.at || now) < 30000) continue
      const info = contextLib.sessionInfo(c.id)
      if (!info || info.status !== 'idle' || !info.inbox || !info.name) continue
      handleStop(c, stop, info, settings)
    }
  } catch (e) {
    log('auto-continue: ' + (e && e.message))
  } finally {
    limitChecking = false
  }
}

function handleStop(chat, stop, info, settings) {
  const account = contextLib.accountOf(chat, accountCtx())
  const rows = snapshotRows()
  const pinned = chatPin(chat)
  const resetAt = autoLib.resetFor(stop, rows.find((r) => r.name === (pinned || account)))
  const entry = { id: stop.id, chat: chat.id, file: chat.file, name: info.name, title: chat.title, account: pinned || account,
    kind: stop.kind, resetAt, pinned: !!pinned,
    stillRunning: !!pinned && pinnedTo(chat) !== pinned, permissionMode: stop.permissionMode || null, state: 'new' }
  if (!autoLib.claim(root(), entry)) return
  log('auto-continue: "' + chat.title + '" stopped at its ' + LIMIT_WORDS[stop.kind] + (entry.account ? ' on "' + entry.account + '"' : ''))
  const canWait = !!resetAt && resetAt - Date.now() <= autoLib.MAX_WAIT_MS
  const to = pinned ? null : autoLib.pickAccount(rows, { exclude: entry.account, kind: stop.kind, pick: settings.pick, order: settings.order })
  if (settings.mode === 'ask') { askAbout(entry, to, canWait); return }
  if (settings.mode === 'switch' && !pinned) {
    if (to) { switchAndContinue(entry, to); return }
    const next = autoLib.nextAvailable(rows, { exclude: entry.account, stoppedAt: resetAt, kind: stop.kind, pick: settings.pick, order: settings.order })
    if (next && next.at - Date.now() <= autoLib.MAX_WAIT_MS) {
      const other = next.name !== entry.account ? next.name : null
      autoLib.mark(root(), entry.id, { resetAt: next.at, to: other })
      waitForReset({ ...entry, resetAt: next.at, to: other }, 'No account has room now, so it')
      return
    }
  }
  if (canWait) { waitForReset(entry, 'It'); return }
  autoLib.mark(root(), entry.id, { state: 'skipped' })
  notify('info', '"' + entry.title + '" stopped at its ' + LIMIT_WORDS[stop.kind] +
    ', which resets too far ahead to wait for, and no other account has room.')
}

function askAbout(entry, to, canWait) {
  autoLib.mark(root(), entry.id, { state: 'asked' })
  const SWITCH = to ? 'Switch to ' + labelOf(to) + ' and Continue' : null
  const WAIT = canWait ? 'Continue at ' + clockText(entry.resetAt) : null
  const what = '"' + entry.title + '" stopped at its ' + LIMIT_WORDS[entry.kind] + (entry.account ? ' on ' + labelOf(entry.account) : '') +
    '. Switcher for Claude Code can continue it for you.' + (entry.pinned ? (entry.stillRunning ? ' It still runs on ' + labelOf(entry.account) + '\'s pinning login until it\'s reopened, so it stays on that account.'
      : ' It\'s pinned to ' + labelOf(entry.account) + ', so it stays on that account.') : '')
  notify('info', what, ...[SWITCH, WAIT, 'Settings'].filter(Boolean)).then((pick) => {
    if (pick && pick === SWITCH) switchAndContinue(entry, to)
    else if (pick && pick === WAIT) waitForReset(entry, 'It')
    else {
      autoLib.mark(root(), entry.id, { state: 'skipped' })
      if (pick === 'Settings') openAccounts()
    }
  }, () => {})
}

function waitForReset(entry, subject) {
  autoLib.mark(root(), entry.id, { state: 'waiting' })
  postState()
  notify('info', subject + ' will continue "' + entry.title + '" at ' + clockText(entry.resetAt) +
    (entry.to ? ' on ' + labelOf(entry.to) + ', the first account with room again.' : ', when the limit resets.'), 'Cancel').then((pick) => {
    if (pick === 'Cancel') cancelWait(entry)
  }, () => {})
}

function cancelWait(entry) {
  const cancelled = autoLib.updateState(root(), (s) => {
    const cur = s.stops[entry.id]
    if (!cur || cur.state !== 'waiting' || cur.resetAt !== entry.resetAt) return false
    s.stops[entry.id] = { ...cur, state: 'cancelled' }
    return true
  })
  if (cancelled) { postState(); return }
  if (cancelled === false) { log('auto-continue: Cancel on "' + entry.title + '" came after its wait was over; nothing to cancel'); return }
  log('auto-continue: Cancel on "' + entry.title + '": auto-continue was busy; not cancelled')
  notify('warn', 'Switcher couldn\'t cancel continuing "' + entry.title + '" just now (busy).', 'Try again').then((pick) => {
    if (pick === 'Try again') cancelWait(entry)
  }, () => {})
}

async function switchAndContinue(entry, to) {
  const mine = autoLib.updateState(root(), (s) => {
    const cur = s.stops[entry.id]
    if (!cur || !['new', 'asked', 'waiting'].includes(cur.state)) return false
    s.stops[entry.id] = { ...cur, state: 'switching', to }
    return true
  })
  if (!mine) return
  try { await switchTo(to) } catch (e) { log('auto-continue switch: ' + (e && e.message)) }
  if (profilesLib.activeProfile(root()) !== to) {
    autoLib.mark(root(), entry.id, { state: 'failed' })
    notify('warn', "Couldn't switch to \"" + labelOf(to) + '", so "' + entry.title + "\" wasn't continued.")
    return
  }
  await new Promise((r) => setTimeout(r, 2000))
  await deliverNotice(entry.id, 'switched')
}

async function deliverNotice(id, how, opts) {
  const o = opts || {}
  const e = autoLib.readState(root()).stops[id]
  if (!e) return
  if (!o.again) {
    const stop = autoLib.limitStop(e.file)
    if (!stop) { autoLib.mark(root(), id, { state: 'moved' }); postState(); return }
  }
  const info = contextLib.sessionInfo(e.chat)
  if (!info || !info.inbox || !info.name) {
    autoLib.mark(root(), id, { state: 'closed' })
    postState()
    notify('info', '"' + e.title + '" was closed, so it couldn\'t be continued.', 'Open Chat')
      .then((p) => { if (p) openChat(e.chat, 'continue') }, () => {})
    return
  }
  const from = e.state
  if (!autoLib.updateState(root(), (s) => {
    if (!s.stops[id] || s.stops[id].state !== from) return false
    s.stops[id].state = 'sending'
    return true
  })) return
  if (!autoLib.canReceive(e.permissionMode)) {
    autoLib.mark(root(), id, { state: 'manual' })
    postState()
    notify('info', (how === 'switched' ? 'Switched to ' + labelOf(profilesLib.activeProfile(root())) + '. '
      : 'The limit has reset. ') + '"' + e.title + '" skips permission prompts, so it only takes "continue" from you.', 'Open Chat')
      .then((p) => { if (p) openChat(e.chat, 'continue') }, () => {})
    return
  }
  const res = await (handoffRun || autoLib.send)(info.name, autoLib.noticeFor({ kind: e.kind }, how))
  if (res && res.ok) {
    autoLib.mark(root(), id, { state: 'sent', sentAt: Date.now(), name: info.name })
    log('auto-continue: sent "' + e.title + '" its notice (' + how + ')')
  } else {
    autoLib.mark(root(), id, { state: 'failed' })
    log('auto-continue: sending failed: ' + (res && res.reason))
    notify('warn', "Couldn't continue \"" + e.title + '" automatically: ' + ((res && res.reason) || 'the notice wasn\'t sent') + '.',
      'Continue Now').then((p) => { if (p) openChat(e.chat, 'continue') }, () => {})
  }
  postState()
}

function followUp(id, e) {
  const outcome = autoLib.afterNotice(e.file)
  const info = contextLib.sessionInfo(e.chat)
  if (outcome === 'pending') {
    if (info && info.status === 'busy') return
    if (Date.now() - (e.sentAt || 0) < 5 * 60e3) return
    autoLib.mark(root(), id, { state: 'failed' })
    notify('warn', '"' + e.title + '" didn\'t pick up the notice to continue.', 'Continue Now')
      .then((p) => { if (p) openChat(e.chat, 'continue') }, () => {})
    return
  }
  if (outcome === 'replied' && info && info.status === 'busy') return
  autoLib.mark(root(), id, { state: outcome })
  if (outcome === 'continued') {
    log('auto-continue: "' + e.title + '" continued')
    notify('info', 'Continued "' + e.title + '" after its usage limit.')
  } else if (outcome === 'replied') {
    notify('warn', '"' + e.title + '" answered the notice instead of continuing. ' +
      'Some chats wait for you to say so first: tell it once to accept Switcher\'s notices, and it continues by itself from then on.',
    'Continue Now', 'Let It Trust Switcher').then((p) => {
      if (p === 'Continue Now') openChat(e.chat, 'continue')
      else if (p === 'Let It Trust Switcher') {
        autoLib.mark(root(), id, { state: 'trust', trustAt: Date.now() })
        openChat(e.chat, autoLib.TRUST_PROMPT)
        notify('info', 'Send the message typed into the chat. Switcher for Claude Code then sends its notice again.')
      }
    }, () => {})
  }
}

async function keepAliveTick() {
  if (!editionLib.hasFeature(edition, 'keepAlive')) return
  const names = store.keepAliveNames(root())
  if (!names.length) return
  const rows = snapshotRows()
  for (const name of names) {
    const row = rows.find((r) => r.name === name)
    if (!row || row.needsLogin || !row.session || keepAliveBusy.has(name) || startingSessions.has(name)) continue
    if (sessionRunning(row.session) || (row.weekly && !row.weekly.resetSince && row.weekly.percent >= 100)) continue
    const due = autoLib.updateState(root(), (s) => {
      if (Date.now() - (s.keepAlive[name] || 0) < 10 * 60e3) return false
      s.keepAlive[name] = Date.now()
      return true
    })
    if (!due) continue
    keepAliveBusy.add(name)
    try {
      const live = name === profilesLib.activeProfile(root())
      const res = live
        ? await kickoffLib.runLive(keepAliveRun || undefined)
        : await kickoffLib.startSession(root(), name, { renew: trackerLib.renew, run: kickoffRun || undefined })
      log('keep alive: ' + (res && res.ok ? 'started the next 5-hour session for "' + name + '"' : '"' + name + '" failed: ' + (res && res.reason)))
      if (res && res.ok) {
        if (live) await refreshLiveQuietly()
        else { try { await trackerLib.poll(root(), name, { force: true }) } catch (e) { log('usage after keep alive: ' + (e && e.message)) } }
      }
    } catch (e) {
      log('keep alive "' + name + '": ' + (e && e.message))
    } finally {
      keepAliveBusy.delete(name)
      refreshAll()
    }
  }
}

const LIVE_EVERY_MS = 2 * 60 * 1000
const LIVE_MIXED_EVERY_MS = 5 * 60 * 1000
let liveUsageRun = null
let livePolling = false
async function pollLiveUsage() {
  if (!trackingEnabled() || livePolling) return
  livePolling = true
  try {
    const key = usageLib.accountKey(null)
    const fresh = () => {
      const ours = usageLib.readLiveCache(root(), null)
      const mixed = claudeCacheMixed()
      const claudes = mixed ? null : usageLib.readUsage(null)
      const newest = Math.max((ours && ours.fetchedAtMs) || 0, (claudes && claudes.fetchedAtMs) || 0)
      return Date.now() - newest < (mixed ? LIVE_MIXED_EVERY_MS : LIVE_EVERY_MS) - 5000
    }
    if (usageLib.pausedUntil(root(), key) > Date.now() || fresh()) return
    const release = locksLib.tryAcquire(root(), 'live-usage', 30000)
    if (!release) return
    try {
      if (fresh()) return
      const res = await (liveUsageRun || liveLib.fetchUsage)(null)
      if (res && res.ok) usageLib.writeLiveCache(root(), null, res.utilization, res.loginExpiresAt)
      else if (res && res.rateLimited) usageLib.pauseUntil(root(), key, Date.now() + (res.retryAfterMs || DEFAULT_USAGE_PAUSE_MS))
      else log('live usage (every minute): ' + (res && res.reason))
    } finally { release() }
    updateUsageBar()
    postState()
  } catch (e) {
    log('live usage (every minute) failed: ' + (e && e.message))
  } finally {
    livePolling = false
  }
}

let earlyBusy = false
function earlySwitchCheck() {
  if (!autoContinueOn() || earlyBusy) return
  const st = store.getAutoContinue(root())
  if (!st.early || (st.mode !== 'switch' && st.mode !== 'ask')) return
  const live = profilesLib.activeProfile(root())
  if (!live) return
  const rows = snapshotRows()
  const row = rows.find((r) => r.name === live)
  const why = autoLib.earlyTrigger(row, st.early)
  if (!why) return
  const lim = why === 'weekly' ? row.weekly : row.session
  const to = autoLib.pickEarly(rows, { exclude: live, kind: why, pick: st.pick, order: st.order, early: st.early })
  if (!to) return
  const windowKey = live + '@' + ((lim && lim.resetsAt) || 'unknown')
  const mine = autoLib.updateState(root(), (s) => {
    const e = s.early || {}
    const handled = Object.fromEntries(Object.entries(e.handled || {}).filter(([, at]) => Date.now() - at < 8 * 86400e3))
    if (Date.now() - (e.lastAt || 0) < autoLib.EARLY_COOLDOWN_MS || handled[windowKey]) return false
    s.early = { lastAt: Date.now(), handled: { ...handled, [windowKey]: Date.now() } }
    return true
  })
  if (!mine) return
  const what = labelOf(live) + ' reached ' + Math.round(lim.percent) + '% of its ' + (why === 'weekly' ? 'weekly limit' : '5-hour limit')
  log('early switch: ' + what + '; next is "' + to + '"')
  if (st.mode === 'ask') {
    notify('info', what + '. Switch to ' + labelOf(to) + ' now, so work doesn\'t stop?', 'Switch Now', 'Not Now')
      .then((p) => { if (p === 'Switch Now') earlySwitch(live, to, what) }, () => {})
    return
  }
  earlySwitch(live, to, what)
}

async function earlySwitch(from, to, what) {
  earlyBusy = true
  try {
    try { await switchTo(to, { quiet: true }) } catch (e) { log('early switch: ' + (e && e.message)) }
    if (profilesLib.activeProfile(root()) !== to) {
      notify('warn', "Couldn't switch to \"" + labelOf(to) + '" early. ' + what + '.')
      return
    }
    notify('info', 'Switched to ' + labelOf(to) + ': ' + what + '. Work carries on from the next message.',
      'Switch Back').then(async (p) => { if (p === 'Switch Back' && (await confirmOrgSwitch(from))) switchTo(from) }, () => {})
  } finally {
    earlyBusy = false
  }
}

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
      if (res.ok) usageLib.writeLiveCache(root(), dir, res.utilization, res.loginExpiresAt)
      else if (res.rateLimited) usagePausedUntil.set(pauseKey, Date.now() + (res.retryAfterMs || DEFAULT_USAGE_PAUSE_MS))
      else log('live usage (update): ' + res.reason)
    } catch (e) { log('live usage (update) failed: ' + (e && e.message)) }
  }
  updateUsageBar()
}

let trackerAuto = true
let loginAuto = true

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
        notify('info', 'Updated. Anthropic is rate-limiting usage checks for ' +
          limited.join(', ') + ', so ' +
          (limited.length === 1 ? 'that account shows its' : 'those show their') + ' last figures for now.')
      }
    }
    for (const r of results) {
      if (r.renewed) log('renewed saved login for "' + r.name + '"')
      else if (r.failed === 'rejected') {
        log('saved login for "' + r.name + '" was rejected; marked sign-in-again')
        notify('warn', 'The saved login for "' + r.name + '" has expired.',
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

async function switchTo(name, opts) {
  if (typeof name !== 'string' || !profilesLib.exists(root(), name)) return
  await ensureGlobalMode()
  await switchToProfile(name, opts)
}

function loginArgs(email) {
  return ['auth', 'login'].concat(shell.validEmail(email) ? ['--email', email] : [])
}

function launchTerminal(title, dir, args) {
  const bin = claude.resolveBin()
  if (!bin) {
    notify('error', "Couldn't find Claude Code's command-line tool (claude). Install Claude Code, or add it to your PATH, and try again.")
    return null
  }
  if (dir) prepareLoginDir(dir)
  const env = { CLAUDE_CONFIG_DIR: dir || null, CLAUDE_SECURESTORAGE_CONFIG_DIR: null }
  const term = vscode.window.createTerminal({
    name: title, env, iconPath: new vscode.ThemeIcon('account'), ...shell.terminalSpec(bin, args),
  })
  term.show()
  return term
}

let loginPollMs = 1500
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const IDENTITY_GRACE_MS = 10000
const loginWatchers = new Set()
const pendingLogins = new Set()

const PENDING_FILE = '.login-pending'

function prepareLoginDir(dir) {
  const cfgPath = path.join(dir, '.claude.json')
  try {
    const { data, stamp } = fsx.readJsonForWrite(cfgPath)
    if (data.oauthAccount !== undefined || data.userID !== undefined) {
      delete data.oauthAccount
      delete data.userID
      fsx.writeJsonAtomic(cfgPath, data, { expect: stamp, mode: 0o600 })
    }
  } catch (e) {
    if (e.code === 'EUNREADABLEJSON') fs.rmSync(cfgPath, { force: true })
    else log('preparing ' + dir + ': ' + (e && e.message))
  }
  try { fsx.writeJsonAtomic(path.join(dir, PENDING_FILE), { pid: process.pid, startedAt: Date.now() }) } catch {  }
}

function finishLoginDir(dir) {
  try { fs.rmSync(path.join(dir, PENDING_FILE), { force: true }) } catch {  }
}

function loginPending(dir) {
  const m = fsx.readJsonLoose(path.join(dir, PENDING_FILE), null)
  if (!m || !Number.isInteger(m.pid)) return false
  return fsx.pidAlive(m.pid) && Date.now() - (Number(m.startedAt) || 0) < LOGIN_TIMEOUT_MS + 60000
}

function watchLogin(dir, startedAt, cancelToken) {
  return new Promise((resolve) => {
    let lastCheckedMtime = 0
    let polls = 0
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
        const cfgPath = path.join(dir, '.claude.json')
        const id = store.identityFromFile(cfgPath)
        const st = fsx.stamp(cfgPath)
        const fresh = !!(id && id.email && st && st.mtimeMs >= startedAt - 2000)
        if (fresh || Date.now() - confirmedAt > IDENTITY_GRACE_MS) {
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
      polls++
      if (mtime === null) {
        if (polls % 5 !== 0) return
      } else {
        if (mtime < startedAt - 2000) return
        if (mtime === lastCheckedMtime && polls % 5 !== 0) return
        lastCheckedMtime = mtime
      }

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
      finishLoginDir(dir)
      if (res.ok) return finalizeLogin(name, dir, res.status, isNew)
      if (res.reason === 'timed out') {
        notify('warn', 
          'Stopped waiting for "' + name + '" after 15 minutes. If you did finish, reload the ' +
          'window and it will be picked up automatically.')
      }
      return null
    })
    .catch((e) => {
      finishLoginDir(dir)
      log('login tracking for ' + name + ' failed: ' + (e && e.stack))
      notify('error', 'Claude Accounts: ' + (e && e.message))
    })
  pendingLogins.add(run)
  run.then(() => pendingLogins.delete(run), () => pendingLogins.delete(run))
  return run
}

function signedInAs(dir, st) {
  const id = store.identityFromFile(path.join(dir, '.claude.json'))
  return { accountUuid: (id && id.accountUuid) || null, email: (id && id.email) || (st && st.email) || null }
}

async function finalizeLogin(name, dir, st, isNew) {
  store.lockdown(dir)
  const fallback = { email: st.email, org: st.orgName }
  const who = signedInAs(dir, st)

  const dup = profilesLib.findSameAccount(root(), who, name)
  if (dup) {
    const update = 'Update "' + dup + '"'
    const choice = await notify('warn', 
      'You signed in as ' + who.email + ', which is already saved as "' + dup + '". ' +
      'Your browser probably reused an account it was already signed in to. ' +
      'Try a private window to sign in to a different one.',
      { modal: true }, update, 'Discard This Login')
    if (choice === update) {
      profilesLib.importFromDir(root(), dup, dir, { move: true, fallback, sameAccountOnly: true, confirmedEmail: st.loggedIn ? st.email : null })
      notify('info', 'Refreshed the saved login for "' + dup + '".')
    } else {
      try { credstore.remove(dir) } catch (e) { log('discard failed: ' + (e && e.message)) }
    }
    if (isNew) {
      try { store.removeAccount(root(), name) } catch (e) { log('removing "' + name + '": ' + (e && e.message)) }
    }
    refreshAll()
    return
  }

  try {
    profilesLib.importFromDir(root(), name, dir, { move: true, fallback, sameAccountOnly: !isNew, confirmedEmail: st.loggedIn ? st.email : null })
  } catch (e) {
    if (e && e.code === 'ENOIDENTITY') {
      notify('info', '"' + name + '" signed in. It will be added as soon as Claude Code has ' +
        'written its account details, on its own or at the next reload.')
      return
    }
    if (e && e.code === 'EACCOUNTMISMATCH') {
      try { credstore.remove(dir) } catch (e2) { log('discarding wrong login failed: ' + (e2 && e2.message)) }
      await notify('warn', e.message + ' Your browser most likely reused another account: ' +
        'sign in again from a private window.', { modal: true })
      return
    }
    throw e
  }

  if (profilesLib.activeProfile(root()) === name) {
    profilesLib.apply(root(), name)
    refreshAll()
    notify('info', 'Signed "' + name + '" in again. Its fresh login is active now.')
    return
  }

  refreshAll()
  const go = await notify('info', 
    'Added "' + name + '"' + (st.email ? ' (' + st.email + ')' : '') + '. It is in the account switcher now.',
    'Switch to It Now')
  if (go === 'Switch to It Now' && (await confirmOrgSwitch(name))) await switchToProfile(name)
}

function syncStagedLogins() {
  const imported = []
  let accounts = []
  try { accounts = store.readRegistry(root()).accounts } catch (e) { log('staged logins: ' + (e && e.message)); return imported }
  for (const a of accounts) {
    let dir
    try { dir = store.configDir(root(), a.name) } catch { continue }
    if (loginPending(dir)) continue
    let mtime
    try {
      const st = credstore.stat(dir)
      if (!st.exists) continue
      mtime = st.modifiedMs
    } catch (e) { log('staged login check for "' + a.name + '": ' + (e && e.message)); continue }
    if (profilesLib.exists(root(), a.name) && (mtime === null || mtime <= profilesLib.capturedAt(root(), a.name))) continue

    const id = store.identity(root(), a.name)
    if (!id || (!id.email && !id.accountUuid)) continue
    const dup = profilesLib.findSameAccount(root(), id, a.name)
    if (dup) {
      log('not importing "' + a.name + '": it is the same account as "' + dup + '"')
      notify('warn', '"' + a.name + '" is signed in as ' + id.email +
        ', which is already saved as "' + dup + '", so it was not added twice.')
      continue
    }
    const release = locksLib.tryAcquire(root(), trackerLib.accountLock(a.name), trackerLib.LOCK_STALE_MS)
    if (!release) continue
    try {
      profilesLib.importFromDir(root(), a.name, dir, { move: true, sameAccountOnly: true })
      imported.push(a.name)
      log('imported staged login "' + a.name + '" (' + id.email + ')')
    } catch (e) {
      log('import of "' + a.name + '" failed: ' + (e && e.message))
    } finally {
      release()
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
  const unsaved = liveLoginUnsaved()
  const canImport = editionLib.hasFeature(edition, 'transfer')
  if (unsaved || canImport) {
    const id = unsaved ? profilesLib.currentIdentity() : null
    const pick = await ui.pick([
      unsaved ? { label: '$(save) Save the account you are signed in to now', description: (id && id.email) || '', value: 'save' } : null,
      { label: '$(sign-in) Sign in to another account', description: 'opens the Claude login in your browser', value: 'new' },
      canImport ? { label: '$(cloud-download) Import from a move file', description: 'accounts moved here from another PC', value: 'import' } : null,
    ].filter(Boolean), { placeHolder: 'Add a Claude account' })
    if (!pick) return
    if (pick.value === 'save') return saveCurrentLogin()
    if (pick.value === 'import') return importFromFile()
  }
  return signInNewAccount()
}

async function saveCurrentLogin(suggested) {
  if (!profilesLib.hasCurrentLogin()) {
    notify('warn', "You're not signed in to Claude Code yet, so there's nothing to save. Sign in first, then try again.")
    return null
  }
  const id = profilesLib.currentIdentity()
  const already = id ? profilesLib.findSameAccount(root(), id, null) : null
  let name = await ui.input({
    title: 'Save Current Login',
    prompt: 'Name for the account currently signed in' + (id && id.email ? ' (' + id.email + ')' : ''),
    value: suggested || already || '',
    placeHolder: 'work-team',
    validateInput: (v) => {
      if (!v) return 'Name is required'
      if (!store.validName(v)) return 'Use 1-32 chars: letters, digits, dot, underscore, hyphen'
      if (v !== already && profilesLib.exists(root(), v) && !(id && profilesLib.sameAccount(profilesLib.savedWho(root(), v), id))) {
        return '"' + v + '" is another saved account. Pick a new name.'
      }
      return null
    },
  })
  if (!name) return null
  if (already && name !== already) {
    const update = 'Update "' + already + '"'
    const choice = await notify('info', 
      'This account is already saved as "' + labelOf(already) + '". Update that one instead?', { modal: true }, update)
    if (choice !== update) return null
    name = already
  }
  let saved
  try { saved = profilesLib.capture(root(), name) } catch (e) {
    notify('warn', 'Nothing was saved: ' + (e && e.message))
    return null
  }
  refreshAll()
  notify('info', 'Saved "' + name + '"' + (saved.email ? ' (' + saved.email + ')' : '') + '.')
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
    if (r.noSession) return 'weekly ' + useCell(r.weekly, false) + (r.scoped ? ' · ' + r.scoped.model + ' ' + useCell(r.scoped, false) : '')
    return '5h ' + useCell(r.session, false) + ' · weekly ' + useCell(r.weekly, false)
  }
  return inOrder(profilesLib.list(root())).map((p) => ({
    label: (p.name === active ? '$(check) ' : '$(blank) ') + labelOf(p.name),
    description: [figures(p.name), p.email, p.org].filter(Boolean).join('  ·  '),
    name: p.name,
  }))
}

async function pickSaved(placeHolder) {
  const items = globalItems()
  if (!items.length) {
    notify('info', 'No saved accounts yet.')
    return null
  }
  const pick = await ui.pick(items, { placeHolder, matchOnDescription: true })
  return pick ? pick.name : null
}

async function forgetAccount(nameArg) {
  const name = typeof nameArg === 'string' && profilesLib.exists(root(), nameArg)
    ? nameArg : await pickSaved('Forget which saved account?')
  if (!name) return
  const confirm = await notify('warn', 
    'Forget "' + labelOf(name) + '"? This deletes its saved login and its pinning login, and unpins its chats and folders. ' +
    'Your chats, and the Claude account itself, are untouched.',
    { modal: true }, 'Forget')
  if (confirm !== 'Forget') return
  profilesLib.remove(root(), name)
  setPref('accountOrder', prefOf('accountOrder')).then(() => {}, () => {})
  setPref('dismissedNotes', prefOf('dismissedNotes')).then(() => {}, () => {})
  try {
    chatPins.forget(root(), name)
    for (const [folder, n] of Object.entries(store.getPins(root()))) if (n === name) store.setPin(root(), folder, null)
    await loginsLib.remove(root(), name)
    await syncPins()
    repin()
  } catch (e) { log('pins: ' + e.message) }
  try { store.setArtifacts(root(), name, 'on') } catch (e) { log('artifacts pref: ' + e.message) }
  writePinnedSettings(name)
  refreshAll()
  notify('info', 'Forgot "' + labelOf(name) + '".')
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

function applyPreferences(name) {
  return preferencesLib.applyPreferences(root(), name, { log })
}

function setArtifactsFor(name, on) {
  if (!profilesLib.exists(root(), name)) return
  const { applied, warning } = preferencesLib.setArtifactsFor(root(), name, on, { log })
  if (warning) notify('warn', 'Artifacts: ' + warning)
  writePinnedSettings(name)
  refreshAll()
  notify('info', 'Artifacts are ' + (on ? 'on' : 'off') + ' for "' + labelOf(name) + '"' +
    (on ? ' where Anthropic offers them' : ', with Claude Docs and the other tools that publish to claude.ai') +
    (applied ? '. New chats follow it; restart a running chat to be sure it does.' : '.'))
}

function setRemoteFor(name, on) {
  if (!profilesLib.exists(root(), name)) return
  const { applied, warning } = preferencesLib.setRemoteFor(root(), name, on, { log })
  if (warning) notify('warn', 'Remote Control: ' + warning)
  writePinnedSettings(name)
  refreshAll()
  notify('info', 'Remote Control is ' + (on ? 'on' : 'off') + ' for "' + labelOf(name) + '"' +
    (applied ? '. Chats already running keep their current connection until restarted.' : '.'))
}

function pinnedSettingsFile(name) { return path.join(loginsLib.pinningRoot(root()), name + '.settings.json') }

function writePinnedSettings(name) {
  if (!store.validName(name)) return
  const file = pinnedSettingsFile(name)
  const out = {}
  if (store.getRemote(root(), name) === 'off') out.disableRemoteControl = true
  if (editionLib.hasFeature(edition, 'artifacts') && store.getArtifacts(root(), name) === 'off') {
    out.enableArtifact = false
    out.permissions = { deny: [...artifactsLib.DENY] }
  }
  try {
    if (!Object.keys(out).length || !profilesLib.exists(root(), name)) { fs.rmSync(file, { force: true }); return }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fsx.writeJsonAtomic(file, out, { mode: 0o600 })
  } catch (e) { log('pinned chat settings for "' + name + '": ' + (e && e.message)) }
}

function writePinnedSettingsAll() {
  for (const p of profilesLib.list(root())) writePinnedSettings(p.name)
  let names = []
  try { names = fs.readdirSync(loginsLib.pinningRoot(root())) } catch { return }
  for (const n of names) {
    const m = /^(.+)\.settings\.json$/.exec(n)
    if (m && !profilesLib.exists(root(), m[1])) { try { fs.rmSync(path.join(loginsLib.pinningRoot(root()), n), { force: true }) } catch {  } }
  }
}

async function ensureGlobalMode() {
  await resolveMachineConfigDir(true)
  try { if (store.getMode(root()) !== 'login') store.setMode(root(), 'login') } catch (e) { log('mode: ' + (e && e.message)) }
  return true
}

let extContext = null
const CONFIG_DIR_CHOICE = 'claudeswitcher.machineConfigDir'

async function resolveMachineConfigDir(modal) {
  const dir = envBridge.currentConfigDir(vscode)
  if (!dir) return true
  const state = extContext && extContext.globalState
  const choice = state ? state.get(CONFIG_DIR_CHOICE) : undefined
  if (choice === 'keep') return false
  if (choice !== 'clear') {
    const msg = 'Claude Code is set to use CLAUDE_CONFIG_DIR=' + dir + ' in every window (in the ' +
      'claudeCode.environmentVariables setting). While it is set, switching accounts and folder pins have no effect. Clear it?'
    const pick = modal
      ? await notify('warn', msg, { modal: true }, 'Clear It', 'Keep It')
      : await notify('warn', msg, 'Clear It', 'Keep It')
    if (pick === 'Keep It') {
      if (state) await state.update(CONFIG_DIR_CHOICE, 'keep')
      log('kept the machine-wide CLAUDE_CONFIG_DIR, as asked')
      return false
    }
    if (pick !== 'Clear It') return false
    if (state) await state.update(CONFIG_DIR_CHOICE, 'clear')
  }
  await envBridge.setConfigDir(vscode, null)
  log('cleared the machine-wide CLAUDE_CONFIG_DIR override')
  return true
}

async function globalSwitch() {
  await ensureGlobalMode()
  syncStagedLogins()
  await openAccounts()
}

let switchQueue = Promise.resolve()
function switchToProfile(name, opts) {
  const run = switchQueue.then(() => doSwitch(name, opts))
  switchQueue = run.catch(() => {})
  return run
}

function lockAccounts(names) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Waiting for a background login renewal to finish...' },
    () => switchLib.lockAccounts(root(), names))
}

async function doSwitch(name, opts) {
  const quiet = !!(opts && opts.quiet)
  const pick = { name }
  let active = profilesLib.activeProfile(root())
  if (active === pick.name) {
    notify('info', 'Already signed in as "' + labelOf(pick.name) + '".')
    return
  }

  if (!active && liveLoginUnsaved()) {
    const id = profilesLib.currentIdentity()
    const choice = await notify('warn', 
      'The account Claude Code is using now' + (id && id.email ? ' (' + id.email + ')' : '') + " isn't saved in the " +
      'switcher. Switching replaces its login, so save it first if you want to come back to it.',
      { modal: true }, 'Save It First', 'Switch Without Saving')
    if (choice === 'Save It First') {
      active = await saveCurrentLogin()
      if (!active) return
    } else if (choice !== 'Switch Without Saving') return
  }

  let applied
  try {
    const res = await switchLib.switchAccount(root(), pick.name, { lock: lockAccounts, log, withoutSaving: true, skipClaudeCache: claudeCacheMixed() })
    if (!res.switched) {
      notify('info', 'Already signed in as "' + labelOf(pick.name) + '".')
      return
    }
    applied = res
  } catch (e) {
    const code = e && e.code
    if (code === 'BUSY') notify('error', 'Switch cancelled: a background login renewal did not finish. Try again in a minute.')
    else if (code === 'MOVING') notify('error', 'Switch cancelled: the live account kept changing in another window. Try again.')
    else if (code === 'CAPTURE') {
      const why = e.cause && e.cause.message
      log('pre-switch capture of "' + e.account + '" failed: ' + why)
      notify('error', 'Switch cancelled: the login Claude Code is using now couldn\'t be saved to "' +
        labelOf(e.account) + '" first. ' + why + ' Nothing was changed.')
    } else {
      const why = String((e && e.message) || 'something went wrong').replace(/\.?$/, '.')
      notify('error', 'Switch failed: ' + why + (code === 'ENOIDENTITY' ? '' : ' Your previous login is still in place.'))
    }
    return
  }

  const st = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Switching to ' + labelOf(pick.name) + '...' },
    () => Promise.resolve(claude.authStatus(profilesLib.paths().claudeDir)))

  refreshAll()

  if (st.ok && !st.loggedIn) {
    notify('warn', 'Switched to "' + labelOf(pick.name) + '" but it reports signed out. ' +
      'Its saved login may have expired.', 'Sign In Again').then((c) => { if (c) relogin(pick.name) }, () => {})
    return
  }

  const who = (st.ok && st.email) || applied.email || pick.name
  if (pinnedHere()) {
    notify('info', 'Other windows now use ' + who + '. This window stays on ' +
      labelOf(pinState.name) + ' because its folder is pinned.')
    return
  }
  if (quiet) return
  notify('info', 'Now signed in as ' + who + '. Your chats and history are untouched, ' +
    'and open chats use it from their next message.')
}

function accountItems(current) {
  return inOrder(profilesLib.list(root())).map((p) => ({
    label: (p.name === current ? '$(pin) ' : '$(blank) ') + labelOf(p.name),
    description: [p.email, pinningReady(p.name) ? 'pinning login: ' + daysPhrase(pinningOf(p.name).expiresAt) + ' left' : 'needs a pinning login (one more sign-in)']
      .filter(Boolean).join('  ·  '),
    name: p.name,
  }))
}

async function pinFolder(preset) {
  await ensureGlobalMode()
  const here = firstFolder()
  const herePin = here ? store.getPin(root(), here) : null

  let mode = 'other'
  if (here) {
    const choices = [
      { label: '$(folder) This folder', description: path.basename(here) + (herePin ? '  ·  pinned to ' + labelOf(herePin) : ''), value: 'here' },
      { label: '$(folder-opened) Another folder…', description: 'any window on it follows the pin', value: 'other' },
    ]
    if (herePin) choices.push({ label: '$(close) Unpin this folder', description: 'back to the global account', value: 'unpin' })
    const pick = await ui.pick(choices, { placeHolder: 'Pin which folder?' })
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
    notify('info', 'No saved accounts yet. Add one first.')
    return
  }
  const pick = typeof preset === 'string' && profilesLib.exists(root(), preset) ? { name: preset }
    : await ui.pick(items, { placeHolder: 'Run "' + path.basename(target) + '" as which account?' })
  if (!pick) return
  if (mode === 'here' && pick.name === current && pinnedHere()) {
    notify('info', 'This folder is already pinned to that account.')
    return
  }
  if (!(await ensurePinning(pick.name))) return
  store.setPin(root(), target, pick.name)
  repin()
  notify('info', '"' + path.basename(target) + '" is pinned to ' + labelOf(pick.name) +
    '. New chats there run on its pinning login now; chats already open move to it when you reopen them.')
  log('pinned "' + target + '" to ' + pick.name)
}

let wrapperPath = null
let foreignWrapperWarned = false

async function syncPins() {
  let count = 0
  try {
    const folders = Object.entries(store.getPins(root())).map(([folder, name]) => ({ folder, name }))
    count = chatPins.writeWrapperFile(root(), folders, (n) => loginsLib.wrapperLogin(root(), n))
  } catch (e) { log('pins: writing the wrapper\'s list: ' + (e && e.message)) }
  return syncWrapper(count > 0)
}

async function syncWrapper(any) {
  if (!wrapperPath) return false
  const cfg = vscode.workspace.getConfiguration('claudeCode')
  const current = cfg.get('claudeProcessWrapper')
  const act = chatPins.wrapperAction(current, wrapperPath, any)
  try {
    if (act === 'on') await cfg.update('claudeProcessWrapper', wrapperPath, vscode.ConfigurationTarget.Global)
    if (act === 'off') await cfg.update('claudeProcessWrapper', undefined, vscode.ConfigurationTarget.Global)
  } catch (e) { log('chat pins: wrapper setting: ' + (e && e.message)); return false }
  if (act === 'foreign' && any && !foreignWrapperWarned) {
    foreignWrapperWarned = true
    notify('warn', 'Pins need Claude Code\'s "Claude Process Wrapper" setting, which is already set to ' +
      'another program, so pinned chats and folders run as the window\'s account. Clear that setting to use pins.')
  }
  return act !== 'foreign'
}

function daysPhrase(expiresAt) {
  if (typeof expiresAt !== 'number') return 'unknown'
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'ended'
  if (ms < DAY_MS) { const h = Math.max(1, Math.floor(ms / 3600000)); return h + (h === 1 ? ' hour' : ' hours') }
  const d = Math.floor(ms / DAY_MS)
  return d + (d === 1 ? ' day' : ' days')
}

function daysWords(expiresAt) {
  const when = new Date(expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return expiresAt <= Date.now() ? 'ended on ' + when : daysPhrase(expiresAt) + ' left (until ' + when + ')'
}

const DAY_MS = 86400000

function mainEndOf(name) {
  return loginExpiryOf(name, null, name === profilesLib.activeProfile(root()))
}

function usesPinning(name) {
  if (pinningOf(name)) return true
  if (Object.values(store.getPins(root())).includes(name)) return true
  return chatPins.read(root()).some((p) => p.name === name)
}

function signinBin() {
  let b = null
  try { b = claude.resolveBin() } catch { b = null }
  if (b && (process.platform !== 'win32' || /\.exe$/i.test(b))) return b
  try { return claude.bundled(os.homedir(), claudeExtPath ? [claudeExtPath] : []).find((c) => fs.existsSync(c)) || null } catch { return null }
}
let claudeExtPath = null

let signinStart = (o) => signinLib.start(o)
const signinCodes = new Map()

function newSigninDir() {
  const dir = path.join(root(), 'accounts', '.signin-' + require('crypto').randomBytes(6).toString('hex'))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

let signinDropRetryMs = [6000, 30000]
function dropSigninDir(dir, attempt) {
  if (!dir || !path.basename(dir).startsWith('.signin-')) return
  try { credstore.remove(dir) } catch (e) { log('sign-in folder: ' + (e && e.message)) }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {
    const n = attempt || 0
    if (n < signinDropRetryMs.length) { setTimeout(() => dropSigninDir(dir, n + 1), signinDropRetryMs[n]).unref(); return }
    log('sign-in folder, left for the next start: ' + (e && e.message))
  }
}

function cleanupSigninDirs() {
  const base = path.join(root(), 'accounts')
  let names = []
  try { names = fs.readdirSync(base) } catch { return }
  for (const n of names) {
    if (!n.startsWith('.signin-')) continue
    const dir = path.join(base, n)
    if (!signinLib.isPending(dir)) dropSigninDir(dir)
  }
}

async function signIn(purpose, name) {
  const bin = signinBin()
  if (!bin) {
    notify('warn', 'Claude Code\'s program wasn\'t found, so the sign-in can\'t start. Install or update the Claude Code extension, then try again.')
    return null
  }
  const label = name ? labelOf(name) : null
  const email = name ? (profilesLib.readMeta(root(), name) || {}).email || null : null
  let spec = {
    kind: 'signin', title: 'Finish signing in on the browser', url: '', email, stage: 'waiting', error: null,
    confirmLabel: purpose === 'relogin' ? 'Sign in' : 'Add account',
    message: purpose === 'pinning' ? 'Your browser opened the Claude sign-in page, to sign ' + label + ' in once more for pinning.'
      : purpose === 'relogin' ? 'Your browser opened the Claude sign-in page, to sign ' + label + ' in again.'
        : 'Your browser opened the Claude sign-in page. Sign in there and this finishes by itself.',
  }
  const q = openAsk(spec)
  let handle = null
  let over = false
  q.answer.then(() => { if (!over) { over = true; if (handle) handle.cancel() } })
  const dir = newSigninDir()
  try {
    for (;;) {
      let codeSent = false
      handle = signinStart({ bin, configDir: dir, email, log: (m) => log('sign-in: ' + m) })
      signinCodes.set(q.id, (code) => {
        codeSent = true
        spec = Object.assign({}, spec, { stage: 'checking', error: null })
        updateAsk(q.id, spec)
        handle.sendCode(code)
      })
      handle.url.then((u) => { if (u && !over) { spec = Object.assign({}, spec, { url: u }); updateAsk(q.id, spec) } }, () => {})
      if (over) handle.cancel()
      const r = await handle.done
      if (over) { dropSigninDir(dir); return null }
      if (r && r.ok) {
        over = true
        endAsk(q.id, undefined)
        withIdentity(dir, r.email)
        return { dir, email: r.email || null, accountUuid: r.accountUuid || null }
      }
      if (codeSent && r && r.reason === 'exited') {
        spec = Object.assign({}, spec, { stage: 'waiting', url: '',
          error: 'That code didn\'t work. Copy it again from the browser page and paste it here.' })
        updateAsk(q.id, spec)
        continue
      }
      over = true
      endAsk(q.id, undefined)
      dropSigninDir(dir)
      notify('warn', r && r.reason === 'timed out' ? 'The sign-in took too long and was stopped. Try again when you\'re ready.'
        : 'The sign-in stopped before it finished' + (r && r.detail ? ' (' + r.detail + ')' : '') + '. Try again.')
      return null
    }
  } catch (e) {
    over = true
    endAsk(q.id, undefined)
    dropSigninDir(dir)
    throw e
  } finally {
    signinCodes.delete(q.id)
  }
}

function withIdentity(dir, email) {
  const cfg = path.join(dir, '.claude.json')
  const j = fsx.readJsonLoose(cfg, null) || {}
  if (j.oauthAccount && typeof j.oauthAccount === 'object') return
  if (!email) return
  try { fsx.writeJsonAtomic(cfg, Object.assign({}, j, { oauthAccount: { emailAddress: email } }), { mode: 0o600 }) } catch (e) { log('sign-in identity: ' + (e && e.message)) }
}

function newAccountName(label, email) {
  const from = String(label || String(email || '').split('@')[0] || 'account')
  let base = from.toLowerCase().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 28).replace(/\.settings$/, '-settings') || 'account'
  if (!store.validName(base)) base = 'account'
  const taken = (n) => profilesLib.exists(root(), n) || store.readRegistry(root()).accounts.some((a) => a.name === n)
  if (!taken(base)) return base
  for (let i = 2; i < 1000; i++) if (!taken(base + '-' + i)) return base + '-' + i
  return base + '-' + Date.now()
}

function labelFromEmail(email) {
  const s = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim()
  return s ? (s[0].toUpperCase() + s.slice(1)).slice(0, 40) : 'Account'
}

async function signInNewAccount() {
  const look = await ui.account({ title: 'Add an account', prompt: 'How it looks in VS Code. You can change it any time.' })
  if (!look) return
  const s = await signIn('add', null)
  if (!s) return
  const who = { email: s.email, accountUuid: s.accountUuid }
  const known = profilesLib.findSameAccount(root(), who, null)
  if (known) return alreadySaved(known, s, {})
  let name
  try {
    name = newAccountName(look.label, s.email)
    profilesLib.importFromDir(root(), name, s.dir, { move: true, confirmedEmail: s.email })
  } catch (e) {
    notify('warn', 'The account couldn\'t be added: ' + (e && e.message))
    return
  } finally { dropSigninDir(s.dir) }
  editAccount(name, look.label || labelFromEmail(s.email), look.icon, look.color)
  log('added "' + name + '"')
  refreshAll()
  return addedNew(name)
}

async function addedNew(name) {
  const m = profilesLib.readMeta(root(), name) || {}
  const offer = prefOf('askSecondLogin')
  const v = await ui.ask({ kind: 'confirm', art: 'success', title: 'Your account has been successfully added',
    facts: [['Email', m.email || 'unknown'], ['Organisation', m.org || 'Personal account'], ['Plan', profilesLib.planName(m.plan) || 'unknown'],
      ['Days left', daysPhrase(mainEndOf(name))]],
    sections: offer ? [{ title: 'Add a second login?', text: 'Switcher supports pinning individual chats and folders to specific accounts but this feature requires another login.' }] : [],
    check: offer ? { label: 'Don\'t ask again', checked: false } : null,
    buttons: offer ? ['No thank you', 'Add account for pinning'] : ['Done'], cancel: false })
  if (v && v.checked === true) await setPref('askSecondLogin', false)
  if (v && v.value === 'Add account for pinning') return addPinning(name)
}

async function alreadySaved(name, s, o) {
  const prevEnd = mainEndOf(name)
  const prevOk = typeof prevEnd === 'number' && prevEnd > Date.now()
  let r
  try {
    await clearHeldFirst(name)
    r = await loginsLib.adoptNewLogin(root(), name, s.dir, { mode: 'main-keep-old-for-pinning', confirmedEmail: s.email })
  } finally { dropSigninDir(s.dir) }
  if (!r || !r.ok) { notify('warn', 'The new login for ' + labelOf(name) + ' couldn\'t be kept (' + ((r && r.reason) || 'unknown') + '). Try again.'); return }
  const fresh = r.main && r.main.expiresAt
  let title
  let message
  let warning = null
  const moved = r.kept === 'old-main'
  if (moved) {
    title = 'Account added for pinning!'
    message = 'This account was already logged in so we\'ve renewed your account validity from ' + daysPhrase(prevEnd) + ' to ~' +
      daysPhrase(fresh) + ', and your previous login is now available for pinning chats (valid for ~' + daysPhrase(prevEnd) + ').'
    if (prevEnd - Date.now() < 3 * DAY_MS) {
      warning = 'Heads-up: that previous login ends in ' + daysPhrase(prevEnd) + ', so pinned chats will need a new pinning login soon. We\'ll remind you before then.'
    }
  } else if (prevOk) {
    title = 'Account renewed'
    message = 'This account was already logged in so we\'ve renewed your account validity from ' + daysPhrase(prevEnd) + ' to ~' +
      daysPhrase(fresh) + '. Its pinning login already lasts longer than the previous login, so it stays as it is (valid for ~' +
      daysPhrase(r.pinning && r.pinning.expiresAt) + ').'
  } else {
    title = 'Account signed in again'
    message = 'This account was already saved, but its login had ended. It\'s signed in again now, valid for ~' + daysPhrase(fresh) + '.'
  }
  afterLoginChange()
  const pinOk = pinningReady(name)
  const v = await ui.ask({ kind: 'confirm', art: moved ? 'pin' : 'success', title, message: (o.intro ? o.intro + ' ' : '') + message, warning,
    buttons: ['Add another account', pinOk ? 'Done' : 'Add account for pinning'], cancel: false })
  if (!v) return
  if (v.value === 'Add another account') return addAccount()
  if (v.value === 'Add account for pinning') return addPinning(name)
}

async function addPinning(nameArg, opts) {
  const o = opts || {}
  let name = typeof nameArg === 'string' && profilesLib.exists(root(), nameArg) ? nameArg : null
  if (!name) {
    const pk = await ui.pick(accountItems(null), { title: 'Add account for pinning', placeHolder: 'A second login for which account?' })
    if (!pk) return false
    name = pk.name
  }
  const s = await signIn('pinning', name)
  if (!s) return false
  const who = { email: s.email, accountUuid: s.accountUuid }
  const mine = profilesLib.savedWho(root(), name)
  if (!mine || profilesLib.sameAccount(mine, who)) {
    const mainEnd = mainEndOf(name)
    let r
    try {
      await clearHeldFirst(name)
      r = await loginsLib.adoptNewLogin(root(), name, s.dir, { mode: 'pinning', confirmedEmail: s.email })
    } catch (e) {
      dropSigninDir(s.dir)
      throw e
    }
    dropSigninDir(s.dir)
    if (!r || !r.ok) { notify('warn', 'The pinning login couldn\'t be kept (' + ((r && r.reason) || 'unknown') + '). Try again.'); return false }
    const fresh = r.pinning && r.pinning.expiresAt
    const outlasts = typeof mainEnd === 'number' && mainEnd > Date.now() && fresh > mainEnd
    afterLoginChange()
    const v = await ui.ask({ kind: 'confirm', art: 'pin', title: 'Account added for pinning!',
      message: 'Congratulations! ' + labelOf(name) + ' can now pin chats and folders. They run on a login of their own, so they never sign out your other chats.',
      check: outlasts ? { label: 'Use this login to keep main login active?', checked: true,
        help: 'Your main login ends in ' + daysPhrase(mainEnd) + '. Ticking this makes the new login your main one (' + daysPhrase(fresh) +
          ') and uses the current main login for pinning until it ends. Nothing else changes.' } : null,
      buttons: o.midFlow ? ['Continue'] : ['Add another account', 'Done'], cancel: false })
    if (outlasts && (v ? v.checked !== false : true)) {
      const x = await loginsLib.exchange(root(), name, { active: name === profilesLib.activeProfile(root()) })
      if (!x.ok) log('pinning: keeping main active: exchange said ' + x.reason)
      afterLoginChange()
    }
    if (!o.midFlow && v && v.value === 'Add another account') addAccount().catch((e) => log('add: ' + (e && e.message)))
    return true
  }
  const other = profilesLib.findSameAccount(root(), who, null)
  if (other) {
    await alreadySaved(other, s, { intro: 'You signed in as ' + (s.email || 'another account') + ', which is ' + labelOf(other) + ', not ' +
      labelOf(name) + ', so this login went to ' + labelOf(other) + '.' })
    return false
  }
  let b
  try {
    b = newAccountName(null, s.email)
    profilesLib.importFromDir(root(), b, s.dir, { move: true, confirmedEmail: s.email })
  } finally { dropSigninDir(s.dir) }
  editAccount(b, labelFromEmail(s.email))
  refreshAll()
  const v = await ui.ask({ kind: 'confirm', art: 'success', title: 'A second account was added',
    message: 'You signed in as ' + s.email + ', which isn\'t ' + labelOf(name) + ' (' + (mine.email || 'its email') + '), so it\'s been added as an account of its own. ' +
      'To add a pinning login for ' + labelOf(name) + ', sign in as ' + (mine.email || 'that account') + ' instead; a private browser window helps.',
    field: { label: 'Name', value: labelOf(b) }, buttons: ['Done', 'Add account for pinning'], cancel: false })
  if (v && typeof v.text === 'string' && v.text.trim()) editAccount(b, v.text.trim().slice(0, 40))
  if (v && v.value === 'Add account for pinning') addPinning(b).catch((e) => log('pinning: ' + (e && e.message)))
  return false
}

async function ensurePinning(name) {
  if (!profilesLib.exists(root(), name)) return false
  if (pinningReady(name)) return true
  return addPinning(name, { midFlow: true })
}

async function relogin(nameArg, which) {
  const name = typeof nameArg === 'string' && profilesLib.exists(root(), nameArg)
    ? nameArg : await pickSaved('Sign in again to which account?')
  if (!name) return
  if (which === 'pinning') return addPinning(name)
  const s = await signIn('relogin', name)
  if (!s) return
  const mine = profilesLib.savedWho(root(), name)
  const who = { email: s.email, accountUuid: s.accountUuid }
  if (mine && !profilesLib.sameAccount(mine, who)) {
    const known = profilesLib.findSameAccount(root(), who, null)
    const v = await ui.ask({ kind: 'confirm', art: 'warn', title: 'That\'s a different account',
      message: 'You signed in as ' + (s.email || 'another account') + ', not ' + (mine.email || labelOf(name)) + ' (' + labelOf(name) + '), so ' +
        labelOf(name) + ' wasn\'t changed. Your browser probably reused an account it was already signed in to; a private window helps.',
      buttons: [known ? null : 'Add it as its own account', 'Try again'].filter(Boolean) })
    if (v && v.value === 'Add it as its own account') {
      let b
      try {
        b = newAccountName(null, s.email)
        profilesLib.importFromDir(root(), b, s.dir, { move: true, confirmedEmail: s.email })
      } finally { dropSigninDir(s.dir) }
      editAccount(b, labelFromEmail(s.email))
      refreshAll()
      return addedNew(b)
    }
    dropSigninDir(s.dir)
    if (v && v.value === 'Try again') return relogin(name)
    return
  }
  const prevEnd = mainEndOf(name)
  const pin = pinningOf(name)
  const keepOld = usesPinning(name) && typeof prevEnd === 'number' && prevEnd > Date.now() && (!pin || pin.expiresAt <= Date.now() || prevEnd > pin.expiresAt)
  let r
  try {
    if (keepOld) await clearHeldFirst(name)
    r = await loginsLib.adoptNewLogin(root(), name, s.dir, { mode: keepOld ? 'main-keep-old-for-pinning' : 'main-only', confirmedEmail: s.email })
  } finally { dropSigninDir(s.dir) }
  if (!r || !r.ok) { notify('warn', labelOf(name) + ' couldn\'t be signed in again (' + ((r && r.reason) || 'unknown') + '). Try again.'); return }
  afterLoginChange()
  const moved = r.kept === 'old-main'
  notify('info', labelOf(name) + ' is signed in again. Its main login is good for about ' + daysPhrase(r.main && r.main.expiresAt) + ' now.' +
    (moved ? ' Its previous login now keeps its pinned chats and folders going for about ' + daysPhrase(prevEnd) + '.' : ''))
}

function afterLoginChange() {
  repin()
  scheduleLoginWatch()
}

const LOGIN_WATCH_MS = 5 * 60 * 1000
const LOGIN_WATCH_LOCK = 'login-watch'
let loginWatchTimer = null
let loginWatchSoon = null
let loginWatchRunning = false
const remindersOpen = new Set()
const endsNoted = new Set()

function scheduleLoginWatch() {
  if (loginWatchSoon) return
  loginWatchSoon = setTimeout(() => { loginWatchSoon = null; loginWatch().catch((e) => log('login watch: ' + (e && e.message))) }, 1500)
}

function busySessions() {
  const out = new Set()
  const dir = path.join(windowsLib.claudeDir(), 'sessions')
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')) } catch { return out }
  for (const n of names) {
    const j = fsx.readJsonLoose(path.join(dir, n), null)
    if (!j || j.status !== 'busy' || typeof j.sessionId !== 'string') continue
    const pid = Number.isInteger(j.pid) ? j.pid : parseInt(n, 10)
    if (Number.isInteger(pid) && pid > 0 && fsx.pidAlive(pid)) out.add(j.sessionId)
  }
  return out
}

function liveSessions() {
  const out = new Map()
  const dir = path.join(windowsLib.claudeDir(), 'sessions')
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')) } catch { return out }
  for (const n of names) {
    const j = fsx.readJsonLoose(path.join(dir, n), null)
    if (!j || typeof j.sessionId !== 'string') continue
    const pid = Number.isInteger(j.pid) ? j.pid : parseInt(n, 10)
    if (!(Number.isInteger(pid) && pid > 0 && fsx.pidAlive(pid))) continue
    const had = out.get(j.sessionId)
    if (had && had.status !== 'idle') continue
    out.set(j.sessionId, {
      status: typeof j.status === 'string' ? j.status : null,
      name: typeof j.name === 'string' ? j.name : null,
      cwd: typeof j.cwd === 'string' ? j.cwd : null,
    })
  }
  return out
}

function accountBusy(name, busy) {
  if (!busy.size) return false
  if (name === profilesLib.activeProfile(root())) return true
  let inUse = []
  try { inUse = loginsLib.listInUse(root(), name) } catch { inUse = [] }
  return inUse.some((u) => !u.sessionId || busy.has(u.sessionId))
}

function loginPairs() {
  return profilesLib.list(root()).map((p) => {
    const end = mainEndOf(p.name)
    return { name: p.name, main: typeof end === 'number' ? { expiresAt: end } : null, pinning: pinningOf(p.name) }
  })
}

async function loginWatch() {
  if (loginWatchRunning) return
  loginWatchRunning = true
  const release = locksLib.tryAcquire(root(), LOGIN_WATCH_LOCK, 2 * 60 * 1000)
  try {
    await settleWaitingChats()
    if (!release) return
    const busy = busySessions()
    const now = Date.now()
    for (const a of loginPairs()) {
      if (!a.pinning) continue
      const d = loginsLib.decideExchange({ now, main: a.main, pinning: a.pinning, busy: accountBusy(a.name, busy) })
      if (d === 'exchange') await lastDayExchange(a.name)
      else if (d === 'wait' && a.main && a.main.expiresAt <= now && !endsNoted.has(a.name + '|main|' + a.main.expiresAt)) {
        endsNoted.add(a.name + '|main|' + a.main.expiresAt)
        notify('warn', labelOf(a.name) + '\'s main login has ended. Its pinning login takes over as soon as no chat on ' + labelOf(a.name) +
          ' is replying, or you can sign in again now.', 'Sign in again', 'Not now')
          .then((b) => { if (b === 'Sign in again') return relogin(a.name) }, () => {})
      }
    }
    remindAll()
  } finally {
    if (release) release()
    loginWatchRunning = false
  }
}

async function lastDayExchange(name) {
  const active = name === profilesLib.activeProfile(root())
  const mainEnd = mainEndOf(name)
  if (typeof mainEnd === 'number' && mainEnd <= Date.now()) return pinningTakesOver(name, active)
  const x = await loginsLib.exchange(root(), name, { active })
  if (!x.ok) { log('last-day exchange for "' + name + '": ' + x.reason); return }
  log('last-day exchange for "' + name + '"')
  try {
    let st = loginsLib.readReminderState(root())
    for (const kind of ['3-days', 'last-day']) {
      st = loginsLib.answerReminder(st, { key: name + '|pinning|' + x.pinning.expiresAt + '|' + kind }, {})
    }
    loginsLib.writeReminderState(root(), st)
  } catch (e) { log('reminders: ' + (e && e.message)) }
  afterLoginChange()
  const label = labelOf(name)
  notify('info', label + '\'s main login was on its last day, so it quietly swapped places with its pinning login. The main login now has ' +
    daysPhrase(x.main.expiresAt) + ' left, and the old one keeps pinned chats going for its last ' + daysPhrase(x.pinning.expiresAt) +
    '. Add a new pinning login so pinning carries on after that.', 'Add account for pinning', 'Not now')
    .then((b) => { if (b === 'Add account for pinning') return addPinning(name) }, () => {})
}

async function pinningTakesOver(name, active) {
  const x = await loginsLib.exchange(root(), name, { active, retire: true })
  if (!x.ok) { log('pinning login taking over as main for "' + name + '": ' + x.reason); return }
  log('pinning login of "' + name + '" took over as its main login; main had ended')
  afterLoginChange()
  const label = labelOf(name)
  notify('info', label + '\'s main login had ended, so its pinning login is now the main login, good for about ' + daysPhrase(x.main.expiresAt) +
    '. ' + label + ' needs a new pinning login: until you add one, its pinned chats and folders start on the active account.',
    'Add account for pinning', 'Not now')
    .then((b) => { if (b === 'Add account for pinning') return addPinning(name) }, () => {})
}

function remindAll() {
  let st
  try { st = loginsLib.readReminderState(root()) } catch (e) { log('reminders: ' + (e && e.message)); return }
  const pinned = (n) => Object.values(store.getPins(root())).includes(n) || chatPins.read(root()).some((p) => p.name === n)
  const due = loginsLib.dueReminders({ now: Date.now(), accounts: loginPairs(), state: st })
    .filter((r) => !remindersOpen.has(r.key) && (r.which === 'main' || pinned(r.name)))
    .filter((r) => !(r.which === 'main' && r.kind === 'expired' && endsNoted.has(r.name + '|main|' + mainEndOf(r.name))))
  if (!due.length) return
  for (const r of due) st = loginsLib.answerReminder(st, r, { notNow: true })
  try { loginsLib.writeReminderState(root(), st) } catch (e) { log('reminders: ' + (e && e.message)); return }
  for (const r of due) showReminder(r)
}

function reminderText(r) {
  const label = labelOf(r.name)
  const end = r.which === 'main' ? mainEndOf(r.name) : (pinningOf(r.name) || {}).expiresAt
  const when = r.kind === 'expired' ? 'has ended'
    : 'ends in ' + daysPhrase(end) + ', ' + (r.kind === 'last-day'
      ? 'at ' + new Date(end).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : 'on ' + new Date(end).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))
  return r.which === 'main'
    ? label + '\'s main login ' + when + '. Sign in again to renew it for about 30 days: it takes a minute in your browser, and nothing else changes.'
    : label + '\'s pinning login ' + when + '. After that its pinned chats and folders start on the active account. Sign in again to keep them on ' + label + '.'
}

function showReminder(r) {
  remindersOpen.add(r.key)
  notify(r.kind === '3-days' ? 'info' : 'warn', reminderText(r), 'Sign in again', 'Not now', 'Don\'t ask again').then((b) => {
    remindersOpen.delete(r.key)
    if (b === 'Sign in again' || b === 'Don\'t ask again') {
      try { loginsLib.writeReminderState(root(), loginsLib.answerReminder(loginsLib.readReminderState(root()), r, {})) } catch (e) { log('reminders: ' + (e && e.message)) }
    }
    if (b === 'Sign in again') return r.which === 'main' ? relogin(r.name) : addPinning(r.name)
  }, () => remindersOpen.delete(r.key))
}

async function startupLogins() {
  try { await loginsLib.recover(root()) } catch (e) { log('logins: recover: ' + (e && e.message)) }
  try {
    const own = windowPinnedDir()
    const done = await loginsLib.migrateWindowLogins(root(), Date.now(), {
      skip: (name) => (own && windowsLib.nameForDir(root(), own) === name) || windowStillOpen(name),
    })
    for (const r of done) {
      if (r.moved || r.removed) log('1.3 window login "' + r.name + '": ' + (r.moved ? 'now its pinning login' : 'removed'))
      if (r.error) log('1.3 window login "' + r.name + '": its old folder is left for the next start: ' + r.error)
      else if (!r.moved && !r.removed && r.reason) log('1.3 window login "' + r.name + '": left for now (' + (r.reason === 'skipped' ? 'its window may still be open' : r.reason) + ')')
    }
    if (done.some((r) => r.moved || r.removed)) afterLoginChange()
  } catch (e) { log('logins: migrate: ' + (e && e.message)) }
  try { askAboutHeldLogins() } catch (e) { log('held logins: ' + (e && e.message)) }
}

function windowStillOpen(name) {
  let dir
  try { dir = windowsLib.windowDir(root(), name) } catch { return false }
  const live = (sub, ext, pidFromName) => {
    const d = path.join(dir, sub)
    if (windowsLib.isLink(d)) return false
    let names = []
    try { names = fs.readdirSync(d).filter((n) => n.endsWith(ext)) } catch { return false }
    return names.some((n) => {
      const j = fsx.readJsonLoose(path.join(d, n), null)
      const pid = j && Number.isInteger(j.pid) ? j.pid : pidFromName ? parseInt(n, 10) : NaN
      return Number.isInteger(pid) && pid > 0 && fsx.pidAlive(pid)
    })
  }
  return live('ide', '.lock', false) || live('sessions', '.json', true)
}

const LOGIN_CHANGE_MS = loginsLib.loginCheckMs(process.platform)
const WAITING_CHECK_MS = 5000
let lastLoginCheck = 0
let identityWaitMs = 10000
const loginStamps = new Map()
let loginChangeRunning = false
const oauthRt = (c) => (c && c.claudeAiOauth && c.claudeAiOauth.refreshToken) || null

function loginStoreChanged(key, dir) {
  let st = null
  try { st = credstore.stat(dir) } catch { return false }
  if (st && st.exists && st.modifiedMs == null) { loginStamps.delete(key); return true }
  const ms = st && st.exists ? (st.modifiedMs || 0) : -1
  if (loginStamps.get(key) === ms) return false
  loginStamps.set(key, ms)
  return ms !== -1
}

async function fastTick() {
  requestsLib.beat(root(), { version })
  await requestsTick()
  if (waitingChats.size || takeouts.size) await settleWaitingChats()
  if (Date.now() - lastLoginCheck < LOGIN_CHANGE_MS - 500) return
  lastLoginCheck = Date.now()
  await loginChangeTick()
}

async function loginChangeTick() {
  if (loginChangeRunning) return
  loginChangeRunning = true
  try {
    if (loginStoreChanged('', null)) await claudeLoginCheck()
    for (const name of loginsLib.names(root())) {
      if (loginStoreChanged(name, loginsLib.dirFor(root(), name))) await pinnedLoginCheck(name)
    }
    lastActive = profilesLib.activeProfile(root())
  } finally { loginChangeRunning = false }
}

function lockAccount(name) {
  return locksLib.acquire(root(), trackerLib.accountLock(name), { waitMs: 45000, staleMs: trackerLib.LOCK_STALE_MS })
}
const heldLock = async () => () => {}

async function claudeLoginCheck() {
  let snap = profilesLib.liveSnapshot()
  const end = profilesLib.loginExpiresAt(snap.credentials)
  if (!snap.refreshToken || !end) return
  const name = profilesLib.findSameAccount(root(), snap, null)
  if (!name) { refreshAll(); return }
  const savedEnd = profilesLib.readMeta(root(), name).loginExpiresAt
  if (typeof savedEnd === 'number' && (end <= savedEnd || loginsLib.sameLoginEnd(end, savedEnd))) return
  const release = await lockAccount(name)
  if (!release) { log('/login: "' + name + '" is locked; next time'); loginStamps.delete(''); return }
  let prevEnd = null
  let moved = false
  try {
    snap = profilesLib.liveSnapshot()
    if (profilesLib.findSameAccount(root(), snap, null) !== name) return
    const newEnd = profilesLib.loginExpiresAt(snap.credentials)
    const old = profilesLib.readPayload(root(), name)
    const prev = old && old.credentials
    prevEnd = profilesLib.loginExpiresAt(prev)
    if (oauthRt(prev) === snap.refreshToken || (prevEnd && loginsLib.sameLoginEnd(prevEnd, newEnd))) return
    const pin = pinningOf(name)
    const wasActive = lastActive === null ? true : lastActive === name
    if (wasActive) log('/login: "' + name + '" was the active account; its previous login is not kept for pinning')
    let oldSignedInAt = null
    try { oldSignedInAt = profilesLib.readMeta(root(), name).signedInAt } catch { oldSignedInAt = null }
    if (!Number.isFinite(oldSignedInAt)) oldSignedInAt = null
    const keepOld = !wasActive && usesPinning(name) && oauthRt(prev) && typeof prevEnd === 'number' && prevEnd > Date.now() &&
      (!pin || pin.expiresAt <= Date.now() || prevEnd > pin.expiresAt)
    profilesLib.updateCredentials(root(), name, snap.credentials)
    try {
      const pm = profilesLib.readMeta(root(), name)
      pm.signedInAt = Date.now()
      profilesLib.writeMeta(root(), name, pm)
    } catch {  }
    if (keepOld) {
      const r = await loginsLib.setPinningLogin(root(), name, prev, (old.identity && old.identity.oauthAccount) || null, { lock: heldLock, signedInAt: oldSignedInAt })
      moved = !!(r && r.ok)
      if (!moved) log('/login: the previous login of "' + name + '" was not kept for pinning: ' + (r && r.reason))
    }
  } finally { release() }
  log('/login: kept the new login of "' + name + '" as its main login' + (moved ? '; the previous one is its pinning login now' : ''))
  afterLoginChange()
  const label = labelOf(name)
  const ended = typeof prevEnd === 'number' && prevEnd <= Date.now()
  notify('info', (ended ? 'Claude Code signed in to ' + label + ' again, so Switcher renewed its main login by itself: good for about '
    : 'Claude Code signed in as ' + label + '. Switcher kept that fresh login as its main login: good for about ') + daysPhrase(end) + '.' +
    (moved ? ' The previous login now keeps its pinned chats and folders going for about ' + daysPhrase(prevEnd) + '.' : ''))
}

function liveAccountByLogin(liveCreds) {
  const end = profilesLib.loginExpiresAt(liveCreds)
  if (end) {
    const all = profilesLib.list(root())
    const exact = all.find((p) => p.loginExpiresAt === end)
    if (exact) return exact.name
    const mine = lastActive && all.find((p) => p.name === lastActive)
    if (mine && loginsLib.sameLoginEnd(mine.loginExpiresAt, end)) return lastActive
    const near = all.filter((p) => loginsLib.sameLoginEnd(p.loginExpiresAt, end))
    if (near.length === 1) return near[0].name
  }
  return lastActive
}
let lastActive = null

function liveLoginIs(name) {
  let live = null
  try { live = credstore.read(null) } catch { return false }
  let saved = null
  try { saved = (profilesLib.readPayload(root(), name) || {}).credentials } catch { saved = null }
  if (oauthRt(live) && oauthRt(live) === oauthRt(saved)) return true
  const end = profilesLib.loginExpiresAt(live)
  if (!end) return false
  const all = profilesLib.list(root())
  const exact = all.find((p) => p.loginExpiresAt === end)
  if (exact) return exact.name === name
  const me = all.find((p) => p.name === name)
  if (!me || !loginsLib.sameLoginEnd(me.loginExpiresAt, end)) return false
  return name === lastActive || all.filter((p) => loginsLib.sameLoginEnd(p.loginExpiresAt, end)).length === 1
}

function restoreLiveIdentity(active, writers) {
  if (!active || !profilesLib.exists(root(), active)) { log('/login in a pinned chat: no saved active account to put back'); return }
  try {
    if (!liveLoginIs(active)) { log('pinned chat: the live login isn\'t the saved one of "' + active + '" any more (a switch or a sign-in meanwhile); ~/.claude.json left as it is'); return }
    const identity = (profilesLib.readPayload(root(), active) || {}).identity || {}
    if (!identity.oauthAccount) return
    const file = profilesLib.paths().claudeJson
    const allowed = [profilesLib.savedWho(root(), active)].concat((writers || []).filter(Boolean))
    for (let attempt = 0; ; attempt++) {
      const { data: cfg, stamp } = fsx.readJsonForWrite(file)
      const o = cfg.oauthAccount && typeof cfg.oauthAccount === 'object' ? cfg.oauthAccount : null
      const fileWho = { accountUuid: (o && o.accountUuid) || null, email: (o && o.emailAddress) || null }
      if ((fileWho.accountUuid || fileWho.email) && !allowed.some((w) => profilesLib.sameAccount(w, fileWho))) {
        log('pinned chat: ~/.claude.json names another account (' + (fileWho.email || fileWho.accountUuid) + ') now; left as it is')
        return
      }
      const same = profilesLib.IDENTITY_KEYS.every((k) => sameJson(cfg[k], identity[k]))
      if (same) return
      for (const k of profilesLib.IDENTITY_KEYS) {
        if (identity[k] !== undefined) cfg[k] = identity[k]
        else delete cfg[k]
      }
      if (!liveLoginIs(active)) { log('pinned chat: the live login changed just now; ~/.claude.json left as it is'); return }
      try { fsx.writeFileAtomic(file, JSON.stringify(cfg, null, 2), { expect: stamp }); break } catch (e) {
        if (e.code !== 'ECONCURRENTWRITE' || attempt >= 4) throw e
      }
    }
    log('/login in a pinned chat: put "' + active + '" back as the account in use')
  } catch (e) { log('/login in a pinned chat: putting the active account back: ' + (e && e.message)) }
}

function sameJson(a, b) {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k]))
}

async function identityWritten(dir) {
  let since = null
  try { const st = credstore.stat(dir); since = st && st.exists && st.modifiedMs ? st.modifiedMs : null } catch { since = null }
  if (!since) since = Date.now()
  const cfgMs = () => { try { return fs.statSync(profilesLib.paths().claudeJson).mtimeMs } catch { return 0 } }
  const step = Math.min(250, Math.max(5, Math.floor(identityWaitMs / 10)))
  for (;;) {
    if (cfgMs() >= since) return true
    if (Date.now() >= since + identityWaitMs) return false
    await new Promise((r) => setTimeout(r, step))
  }
}

function pinnedLoginChange(name) {
  let creds = null
  try { creds = credstore.read(loginsLib.dirFor(root(), name)) } catch { return null }
  const meta = loginsLib.readMeta(root(), name)
  const end = profilesLib.loginExpiresAt(creds)
  if (!oauthRt(creds) || !meta) return null
  const known = meta.foreign ? meta.foreign.expiresAt : meta.expiresAt
  if (end === known) return null
  const fresh = !meta.foreign && Number.isFinite(meta.signedInAt) && Date.now() - meta.signedInAt < FRESH_SIGNIN_MS
  if (typeof known === 'number' && loginsLib.sameLoginEnd(end, known) && !fresh) return { renewal: true, end, held: !!meta.foreign }
  return { creds }
}
const FRESH_SIGNIN_MS = 2 * loginsLib.RENEWAL_SLACK_MS

async function pinnedRenewal(name, dir, active) {
  const release = await lockAccount(name)
  if (!release) { log('pinning login of "' + name + '": renewed by a chat, but locked; next time'); loginStamps.delete(name); return }
  let r = null
  try {
    const now = pinnedLoginChange(name)
    if (!now || !now.renewal) { loginStamps.delete(name); return }
    r = await loginsLib.followRenewal(root(), name, now.end, { lock: heldLock })
  } finally { release() }
  if (!r || !r.ok) { log('pinning login of "' + name + '": following its renewal: ' + (r && r.reason)); return }
  log('pinning login of "' + name + '": renewed by a chat; its end date follows')
  if (!(loginsLib.readMeta(root(), name) || {}).foreign) await syncPins()
  if (await identityWritten(dir)) restoreLiveIdentity(active, [profilesLib.savedWho(root(), name)])
}

async function pinnedLoginCheck(name) {
  const dir = loginsLib.dirFor(root(), name)
  const isNew = () => { const c = pinnedLoginChange(name); return c && c.creds ? c.creds : null }
  const first = pinnedLoginChange(name)
  if (!first) return
  if (locksLib.isHeld(root(), trackerLib.accountLock(name), trackerLib.LOCK_STALE_MS)) { loginStamps.delete(name); return }
  const active = liveAccountByLogin(credstore.read(null))
  if (first.renewal) { await pinnedRenewal(name, dir, active); return }
  const written = await identityWritten(dir)
  const cfg = written ? (fsx.readJsonLoose(profilesLib.paths().claudeJson, null) || {}) : {}
  const raw = cfg.oauthAccount && typeof cfg.oauthAccount === 'object' ? cfg.oauthAccount : null
  const who = { accountUuid: (raw && raw.accountUuid) || null, email: (raw && raw.emailAddress) || null }
  const meta = loginsLib.readMeta(root(), name) || {}
  const mine = meta.accountUuid || meta.email ? { accountUuid: meta.accountUuid || null, email: meta.email || null } : profilesLib.savedWho(root(), name)
  const unknown = !(who.accountUuid || who.email)
  const same = unknown || profilesLib.sameAccount(mine, who)
  if (!written) log('/login in a pinned chat of "' + name + '": ~/.claude.json didn\'t change within ' + Math.round(identityWaitMs / 1000) + ' s; taken as the same account')
  else if (unknown) log('/login in a pinned chat of "' + name + '": who signed in can\'t be read; taken as the same account')

  const release = await lockAccount(name)
  if (!release) { log('/login in a pinned chat of "' + name + '": locked; next time'); loginStamps.delete(name); return }
  let creds = null
  try {
    creds = isNew()
    if (!creds) return
    if (same) {
      const r = await loginsLib.setPinningLogin(root(), name, creds, raw && !unknown ? raw : null, { lock: heldLock })
      if (!r.ok) { log('/login in a pinned chat of "' + name + '": ' + r.reason); return }
    } else {
      await loginsLib.holdForeign(root(), name, { expiresAt: profilesLib.loginExpiresAt(creds), oauthAccount: raw, activeWas: active }, { lock: heldLock })
      takeouts.delete(name)
    }
  } finally { release() }
  restoreLiveIdentity(active, [who, mine])
  if (!same) await syncPins()
  afterLoginChange()
  const label = labelOf(name)
  if (same) {
    notify('info', 'A chat pinned to ' + label + ' signed in to ' + label + ' again, so ' + label + '\'s pinning login is renewed: good for about ' +
      daysPhrase(profilesLib.loginExpiresAt(creds)) + '.')
    return
  }
  log('/login in a pinned chat of "' + name + '": signed in as another account; held, no longer its pinning login')
  await askAboutHeld(name, who)
}

async function askAboutHeld(name, who) {
  const label = labelOf(name)
  let held = null
  try { held = loginsLib.foreignOf(root(), name) } catch { held = null }
  if (held && heldLooksLikeRenewal(name, held, who)) return askAboutHeldRenewal(name, who)
  const other = profilesLib.findSameAccount(root(), who, null)
  const useFor = other && other !== name ? 'Use it for ' + labelOf(other) : null
  const addOwn = 'Add it as its own account'
  const b = await notify('warn', 'A chat pinned to ' + label + ' signed in as ' + (who.email || 'another account') + ', which isn\'t ' + label +
    '. Pinned chats only use ' + label + '\'s own logins, so new chats pinned to ' + label + ' start on the active account until ' + label +
    ' has a new pinning login. ' +
    (useFor ? 'It belongs to ' + labelOf(other) + ': use it as ' + labelOf(other) + '\'s pinning login?' : 'Add ' + (who.email || 'it') + ' as an account of its own?') +
    ' The chats on that login reopen first, each when its reply finishes.',
    useFor || addOwn, 'Discard it')
  const action = useFor && b === useFor ? 'use' : !useFor && b === addOwn ? 'add' : b === 'Discard it' ? 'discard' : null
  if (!action) { log('/login in a pinned chat of "' + name + '": no answer; the login stays with its chat'); return }
  if (takeouts.has(name)) return
  await takeOutWhenFree(name, { action, other: useFor ? other : null, who, label })
}

function heldLooksLikeRenewal(name, held, who) {
  if (profilesLib.sameAccount(profilesLib.savedWho(root(), name), who)) return true
  if ('activeWas' in held) return false
  const end = held.expiresAt, since = held.since
  if (!Number.isFinite(end) || !Number.isFinite(since)) return false
  if (end - since >= RENEWED_SHORT_OF_MS) return false
  let signedInAt = null
  try { signedInAt = (loginsLib.readMeta(root(), name) || {}).signedInAt } catch { signedInAt = null }
  if (!Number.isFinite(signedInAt) || Math.abs(end - (signedInAt + LOGIN_LIFETIME_MS)) <= LIFETIME_SLACK_MS) return true
  let active = null
  try { active = profilesLib.activeProfile(root()) } catch { active = null }
  return !!active && active !== name && profilesLib.sameAccount(profilesLib.savedWho(root(), active), who)
}
const LOGIN_LIFETIME_MS = 30 * 86400000
const RENEWED_SHORT_OF_MS = LOGIN_LIFETIME_MS - 3600000
const LIFETIME_SLACK_MS = 2 * 86400000

async function askAboutHeldRenewal(name, who) {
  const label = labelOf(name)
  const keep = 'Keep it as ' + label + '\'s pinning login'
  const whoText = who.email || 'another account'
  const b = await notify('warn', 'A chat pinned to ' + label + ' renewed ' + label + '\'s pinning login, and an earlier version of Switcher took that for a sign-in as ' +
    whoText + ' and set the login aside. Until it\'s back, new chats pinned to ' + label + ' start on the active account. ' +
    keep + '? If you really signed in as ' + whoText + ' in that chat, discard it instead.',
    keep, 'Discard it')
  if (b === keep) { await keepHeldAsPinning(name); return }
  if (b !== 'Discard it') { log('held login of "' + name + '": no answer; the login stays with its chat'); return }
  if (takeouts.has(name)) return
  await takeOutWhenFree(name, { action: 'discard', other: null, who, label })
}

async function keepHeldAsPinning(name) {
  const label = labelOf(name)
  const release = await lockAccount(name)
  if (!release) { notify('warn', label + '\'s login is busy right now. Try again in a minute (Switcher asks again at the next start).'); return }
  let r = null
  try {
    const f = loginsLib.foreignOf(root(), name)
    let creds = null
    try { creds = credstore.read(loginsLib.dirFor(root(), name)) } catch { creds = null }
    if (!f) r = { ok: false, reason: 'not held any more' }
    else if (!oauthRt(creds) || !loginsLib.sameLoginEnd(profilesLib.loginExpiresAt(creds), f.expiresAt)) r = { ok: false, reason: 'the folder holds another login now' }
    else {
      let own = null
      try { own = ((profilesLib.readPayload(root(), name) || {}).identity || {}).oauthAccount || null } catch { own = null }
      const signedInAt = (loginsLib.readMeta(root(), name) || {}).signedInAt
      r = await loginsLib.setPinningLogin(root(), name, creds, own, { lock: heldLock, signedInAt })
    }
  } finally { release() }
  if (!r.ok) { log('held login of "' + name + '": not kept: ' + r.reason); return }
  log('held login of "' + name + '": kept as its pinning login again')
  await syncPins()
  afterLoginChange()
  notify('info', label + '\'s pinning login is back: pinned chats and folders use it again, good for about ' + daysPhrase(r.expiresAt) + '.')
}

const heldAsked = new Set()
function askAboutHeldLogins() {
  for (const p of profilesLib.list(root())) {
    let f = null
    try { f = loginsLib.foreignOf(root(), p.name) } catch { f = null }
    if (!f || takeouts.has(p.name)) continue
    const key = p.name + '|' + (f.since || '') + '|' + (f.expiresAt || '')
    if (heldAsked.has(key)) continue
    heldAsked.add(key)
    const o = f.oauthAccount || {}
    const who = { accountUuid: o.accountUuid || null, email: o.emailAddress || null }
    log('held login of "' + p.name + '": still held after a start; asking again')
    askAboutHeld(p.name, who).catch((e) => log('held login of "' + p.name + '": ' + (e && e.message)))
  }
}

const takeouts = new Map()

function chatTitleOf(id) {
  const pin = chatPins.read(root()).find((p) => p.id === id)
  return liveTitle(id, pin && pin.title)
}

function liveTitle(id, saved) {
  try {
    const f = chatPins.chatFile(path.join(windowsLib.claudeDir(), 'projects'), id)
    const t = f ? chatPins.titleOf(f) : null
    if (t) return t
  } catch {  }
  return saved || null
}

async function takeOutWhenFree(name, plan) {
  plan.reopened = new Set()
  plan.told = false
  takeouts.set(name, plan)
  let inUse = []
  try { inUse = loginsLib.listInUse(root(), name) } catch { inUse = [] }
  for (const u of inUse) {
    const title = u.sessionId ? chatTitleOf(u.sessionId) : null
    if (!title || !chatTabs(title).length) continue
    plan.reopened.add(u.pid)
    if (chatBusy(u.sessionId)) {
      waitingChats.set(u.sessionId, { name, title, takeout: name })
      notify('info', '"' + title + '" runs on a login that isn\'t ' + plan.label + '\'s, so it reopens on the active account when this reply finishes.', 'Reopen now')
        .then((b) => { if (b === 'Reopen now' && waitingChats.has(u.sessionId)) { waitingChats.delete(u.sessionId); return reopenChat(u.sessionId, title).then(() => settleTakeouts()) } }, () => {})
    } else {
      await reopenChat(u.sessionId, title)
    }
  }
  await settleTakeouts()
}

async function settleTakeouts() {
  for (const [name, plan] of [...takeouts]) {
    if ([...waitingChats.values()].some((w) => w.takeout === name)) continue
    let left = []
    try { left = loginsLib.listInUse(root(), name) } catch { left = [] }
    if (left.length) {
      if (!plan.told && left.some((u) => !plan.reopened.has(u.pid))) {
        plan.told = true
        notify('info', 'A chat still runs on the login ' + (plan.who.email || 'of another account') + ' signed in to (in another window, or not open in a tab). ' +
          'Close that chat, and Switcher finishes with the login then.')
      }
      continue
    }
    takeouts.delete(name)
    try { await finishTakeout(name, plan) } finally { for (const done of plan.waiters || []) done() }
  }
}

async function clearHeldFirst(name) {
  const f = loginsLib.foreignOf(root(), name)
  if (!f) return
  let inUse = []
  try { inUse = loginsLib.listInUse(root(), name) } catch { inUse = [] }
  if (!inUse.length && !takeouts.has(name)) return
  const label = labelOf(name)
  const o = f.oauthAccount || {}
  const who = { accountUuid: o.accountUuid || null, email: o.emailAddress || null }
  let plan = takeouts.get(name)
  const fresh = !plan
  if (fresh) plan = { action: 'discard', other: null, who, label }
  if (plan.action === 'discard') plan.replacing = true
  const done = new Promise((resolve) => { plan.waiters = (plan.waiters || []).concat(resolve) })
  log('pinning login for "' + name + '": waits for the chats on the held login of another account')
  notify('info', label + '\'s new pinning login goes in once the chats on the login ' + (who.email || 'of another account') +
    ' have reopened, each when its reply finishes.')
  if (fresh) await takeOutWhenFree(name, plan)
  else await settleTakeouts()
  await done
}

async function finishTakeout(name, plan) {
  const { who, label } = plan
  if (plan.action === 'discard') {
    const r = await loginsLib.takeOutForeign(root(), name, null)
    if (!r.ok) { log('held login of "' + name + '": ' + r.reason); return }
    afterLoginChange()
    if (plan.replacing) { log('held login of "' + name + '": discarded; a new pinning login replaces it'); return }
    notify('info', 'The login ' + (who.email || 'of another account') + ' was discarded. ' + label + ' needs a new pinning login.', 'Add account for pinning', 'Not now')
      .then((b) => { if (b === 'Add account for pinning') return addPinning(name) }, () => {})
    return
  }
  const tmp = newSigninDir()
  try {
    const r = await loginsLib.takeOutForeign(root(), name, tmp)
    if (!r.ok || !r.moved) { log('held login of "' + name + '": ' + (r.reason || 'nothing to move')); return }
    afterLoginChange()
    const other = plan.other
    if (plan.action === 'use' && other && profilesLib.exists(root(), other)) {
      const cur = pinningOf(other)
      const fresh = profilesLib.loginExpiresAt(credstore.read(tmp))
      if (!cur || cur.expiresAt <= Date.now() || (fresh && cur.expiresAt < fresh)) {
        const x = await loginsLib.importPinning(root(), other, tmp)
        if (!x.ok) { notify('warn', 'That login couldn\'t be kept for ' + labelOf(other) + ' (' + x.reason + ').'); return }
      }
      afterLoginChange()
      notify('info', labelOf(other) + ' has a pinning login now, good for about ' + daysPhrase((pinningOf(other) || {}).expiresAt) + '.')
    } else if (plan.action === 'add') {
      const nb = newAccountName(null, who.email)
      profilesLib.importFromDir(root(), nb, tmp, { move: true, confirmedEmail: who.email })
      editAccount(nb, labelFromEmail(who.email))
      refreshAll()
      const v = await ui.ask({ kind: 'confirm', art: 'success', title: 'A second account was added',
        message: (who.email || 'It') + ' is an account of its own now. To give ' + label + ' its pinning login back, use Sign in again in its pin panel.',
        field: { label: 'Name', value: labelOf(nb) }, buttons: ['Done', 'Add account for pinning'], cancel: false })
      if (v && typeof v.text === 'string' && v.text.trim()) editAccount(nb, v.text.trim().slice(0, 40))
      if (v && v.value === 'Add account for pinning') addPinning(nb).catch((e) => log('pinning: ' + (e && e.message)))
    }
  } finally { dropSigninDir(tmp) }
}

async function checkAll() {
  const spec = { kind: 'checks', title: 'Check everything', message: 'A quick look at everything Switcher looks after on this PC.',
    items: [{ label: 'Checking', status: 'run', detail: '' }], done: false }
  const q = openAsk(spec)
  const fixes = []
  let items
  try {
    const claudeExt = vscode.extensions && vscode.extensions.getExtension('anthropic.claude-code')
    const claudeVersion = (claudeExt && claudeExt.packageJSON && claudeExt.packageJSON.version) || null
    const self = wrapperPath ? await healthLib.selfTest(wrapperPath, { timeoutMs: 5000 }) : { ok: false, version: null, reason: 'not installed' }
    const logins = loginPairs().map((l) => ({ name: l.name, main: l.main,
      pinning: l.pinning ? { expiresAt: l.pinning.expiresAt, dir: loginsLib.dirFor(root(), l.name) } : null }))
    const rows = await healthLib.report({ root: root(), wrapperPath, logins, claudeVersion, selfTest: self,
      wrapperSetting: vscode.workspace.getConfiguration('claudeCode').get('claudeProcessWrapper') || null })
    items = rows.map((r) => {
      const acct = profilesLib.exists(root(), r.name) ? r.name : null
      const label = r.area === 'login' ? labelOf(r.name) + ': main login'
        : r.area === 'pinning' ? labelOf(r.name) + ': pinning login'
          : r.area === 'pins' && acct ? labelOf(r.name) + ': pins'
            : r.area === 'wrapper' ? 'Pin wrapper: ' + r.name : r.name
      let fix = null
      if (r.state !== 'ok' && acct && r.area === 'login') fix = { label: 'Sign in again', run: () => relogin(acct) }
      else if (r.state !== 'ok' && acct && (r.area === 'pinning' || r.area === 'pins')) {
        fix = { label: pinningOf(acct) ? 'Sign in again' : 'Add account for pinning', run: () => addPinning(acct) }
      } else if (r.state !== 'ok' && r.area === 'wrapper') fix = { label: 'Set it up again', run: () => syncPins() }
      fixes.push(fix)
      return { label, status: r.state, detail: r.text, fix: fix ? fix.label : null }
    })
    if (liveLoginUnsaved()) {
      const id = profilesLib.currentIdentity()
      fixes.push({ label: 'Save it', run: () => saveCurrentLogin() })
      items.push({ label: 'The login in use', status: 'warn', detail: ((id && id.email) || 'It') + ' isn\'t saved yet.', fix: 'Save it' })
    }
  } catch (e) {
    log('check everything: ' + (e && e.stack))
    items = [{ label: 'Check everything', status: 'bad', detail: 'The checks couldn\'t run: ' + (e && e.message), fix: null }]
  }
  const need = items.filter((x) => x.status === 'bad' || x.status === 'warn').length
  updateAsk(q.id, Object.assign({}, spec, { items, done: true,
    summary: need ? need + (need === 1 ? ' thing needs' : ' things need') + ' a look. The rest is fine.' : 'Everything works.' }))
  const ans = await q.answer
  if (!ans) return
  if (ans.value === 'again') return checkAll()
  const f = ans.value === 'fix' ? fixes[ans.index] : null
  if (f) return f.run()
}

function folderChats(folder) {
  return chatPins.listChats(path.join(windowsLib.claudeDir(), 'projects'), folder, 40)
}

function agoText(ms) {
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + ' min ago'
  const h = Math.round(m / 60)
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago')
  const d = Math.round(h / 24)
  return d + (d === 1 ? ' day ago' : ' days ago')
}

async function pinChat(preset) {
  await ensureGlobalMode()
  const folder = firstFolder()
  if (!folder) { notify('info', 'Open a folder first: chats are pinned from the folder they belong to.'); return }
  const chats = folderChats(folder)
  if (!chats.length) { notify('info', 'No chats in "' + path.basename(folder) + '" yet. Start one, then pin it.'); return }
  const pinned = new Map(chatPins.read(root()).map((p) => [p.id, p]))
  const presetName = typeof preset === 'string' && profilesLib.exists(root(), preset) ? preset : null
  const chat = await ui.pick(chats.map((c) => ({
    label: (pinned.has(c.id) ? '$(pin) ' : '$(comment-discussion) ') + (c.title || 'Untitled chat'),
    description: agoText(c.at) + (pinned.has(c.id) ? '  ·  pinned to ' + labelOf(pinned.get(c.id).name) : ''),
    chat: c,
  })), { title: presetName ? 'Pin a chat to ' + labelOf(presetName) : null, placeHolder: 'Pin which chat?', matchOnDescription: true })
  if (!chat) return
  const c = chat.chat
  const current = pinned.has(c.id) ? pinned.get(c.id).name : null
  let pick = presetName ? { name: presetName } : null
  if (!pick) {
    const items = accountItems(current)
    if (current) items.push({ label: '$(close) Unpin this chat', description: 'back to the active account', unpin: true })
    pick = await ui.pick(items, { placeHolder: 'Run "' + (c.title || 'this chat') + '" as which account?' })
    if (!pick) return
    if (pick.unpin) { await confirmUnpinChat(c.id); return }
  }
  if (pick.name === current) { notify('info', 'That chat is already pinned to ' + labelOf(current) + '.'); return }
  if (!(await ensurePinning(pick.name))) return
  const name = c.title || 'this chat'
  const label = labelOf(pick.name)
  const fit = phoneReopenable(c.id, c.title)
  const open = fit === 'ok' || fit === 'busy'
  const ok = await ui.confirm({
    title: 'Pin "' + name + '" to ' + label + '?',
    message: 'It uses ' + label + '\'s pinning login, a separate login that never signs out your other chats. ' +
      (open ? 'If the chat is replying, it finishes first, then reopens on ' + label + '.'
        : fit === 'unsure' ? unsureLine(c.title, label)
          : 'It opens on ' + label + ' the next time you open it.'),
    confirmLabel: open ? 'Pin and reopen' : 'Pin',
  })
  if (!ok) return
  const r = await applyChatPin(c.id, pick.name, c.title, { reopen: fit !== 'closed', safe: true })
  if (r.state === 'pinned') notify('info', '"' + name + '" is pinned to ' + label + '. It opens on ' + label + ' the next time you open it.')
  else if (r.state === 'needs-reopen') {
    notify('info', chatTabs(c.title).length ? pinUnsureText('"' + name + '"', label)
      : '"' + name + '" is pinned to ' + label + '. It\'s running, but not in a tab here, so it keeps its current login until you reopen it: it moves to ' + label + ' then.')
  }
}

function pinUnsureText(chat, label) {
  return chat + ' is pinned to ' + label + ', but VS Code couldn\'t be sure which open tab is it, so it wasn\'t reopened. ' +
    'Reopen it by hand: it moves to ' + label + ' then.'
}

function unsureLine(title, to) {
  return chatTabs(title).length ? 'VS Code can\'t be sure which open tab is it, so it isn\'t reopened. Reopen it by hand: it runs on ' + to + ' then.'
    : 'It\'s running, but not in a tab here (another window?), so it keeps its current login until you reopen it: it runs on ' + to + ' then.'
}

function unpinUnsureText(chat, to) {
  return chat + ' is unpinned, but VS Code couldn\'t be sure which open tab is it, so it wasn\'t reopened. ' +
    'Reopen it by hand: it runs on ' + to + ' then.'
}

async function applyChatPin(id, name, title, o) {
  const opt = o || {}
  chatPins.set(root(), id, name, title)
  if (!(await syncPins())) { chatPins.remove(root(), id); await syncPins(); refreshAll(); return { ok: false, state: 'failed' } }
  refreshAll()
  if (opt.reopen) return reopenWhenIdle(id, title, name, opt)
  return { ok: true, state: 'pinned' }
}

const waitingChats = new Map()

function chatBusy(id) {
  try { return busySessions().has(id) } catch { return false }
}

async function reopenWhenIdle(id, title, name, o) {
  const quiet = !!(o && o.quiet)
  const safe = !!(o && o.safe)
  const label = labelOf(name)
  const fit = safe ? phoneReopenable(id, title) : chatBusy(id) ? 'busy' : 'ok'
  if (fit === 'closed') return { ok: true, state: 'pinned' }
  if (fit === 'unsure') return { ok: true, state: 'needs-reopen' }
  if (fit === 'busy') {
    waitingChats.set(id, { name, title, safe })
    scheduleLoginWatch()
    if (!quiet) notify('info', '"' + (title || 'The chat') + '" is pinned to ' + label + '. Claude is still replying, so it moves to ' + label +
      ' when this reply finishes. To move it now, use Reopen now in the Pinned list.')
    return { ok: true, state: 'waiting' }
  }
  waitingChats.delete(id)
  if (!(await reopenChat(id, title))) return { ok: true, state: 'needs-reopen' }
  if (!quiet) notify('info', '"' + (title || 'The chat') + '" is pinned to ' + label + ' and reopened on it. It runs on ' + label + '\'s pinning login from now on.')
  return { ok: true, state: 'reopened' }
}

let settlingChats = false
async function settleWaitingChats() {
  if (settlingChats) return
  settlingChats = true
  try { await settleWaitingChatsNow(); if (takeouts.size) await settleTakeouts() } finally { settlingChats = false }
}

async function settleWaitingChatsNow() {
  for (const [id, w] of [...waitingChats]) {
    if (w.safe) { await settleFromPhone(id, w); continue }
    if (w.takeout || w.unpinned) {
      if (chatBusy(id)) continue
      waitingChats.delete(id)
      const to = w.unpinned ? fallbackAccount(id).label : 'the active account'
      if (await reopenChat(id, w.title)) notify('info', '"' + (w.title || 'The chat') + '" finished its reply and reopened on ' + to + '.')
      continue
    }
    const pin = chatPins.read(root()).find((p) => p.id === id)
    if (!pin) { waitingChats.delete(id); continue }
    if (chatBusy(id)) continue
    waitingChats.delete(id)
    if (await reopenChat(id, w.title)) {
      notify('info', '"' + (w.title || 'The chat') + '" finished its reply and reopened on ' + labelOf(pin.name) + '. It runs on ' +
        labelOf(pin.name) + '\'s pinning login from now on.')
    }
    refreshAll()
  }
}

async function settleFromPhone(id, w) {
  const pin = chatPins.read(root()).find((p) => p.id === id)
  if (!w.unpinned && !pin) { waitingChats.delete(id); return }
  const title = liveTitle(id, w.title)
  const fit = phoneReopenable(id, title)
  if (fit === 'busy') return
  waitingChats.delete(id)
  const to = w.unpinned ? fallbackAccount(id).label : labelOf(pin.name)
  const chat = '"' + (title || 'The chat') + '"'
  if (fit === 'ok') {
    if (await reopenChat(id, title)) notify('info', chat + ' finished its reply and reopened on ' + to + '.')
  } else if (fit === 'unsure') {
    notify('info', chat + ' finished its reply, but another open chat could be the one in its tab, so it wasn\'t reopened, to be sure the right one ' +
      'restarts. Close it, then open it again from Claude Code\'s past conversations: it starts on ' + to + ' then.')
  }
  refreshAll()
}

async function reopenNow(id) {
  const pin = chatPins.read(root()).find((p) => p.id === id)
  if (!pin) return
  waitingChats.delete(id)
  if (await reopenChat(id, pin.title)) notify('info', '"' + (pin.title || 'The chat') + '" reopened on ' + labelOf(pin.name) + '. The reply it was writing stopped part-way, so ask it to carry on if you need the rest.')
}

async function movePin(m) {
  const to = typeof m.to === 'string' && store.validName(m.to) && profilesLib.exists(root(), m.to) ? m.to : null
  if (!to || !pinningReady(to)) return
  if (typeof m.id === 'string' && chatPins.validId(m.id)) {
    const pin = chatPins.read(root()).find((p) => p.id === m.id)
    if (!pin || pin.name === to) return
    chatPins.set(root(), m.id, to, pin.title)
    await syncPins()
    refreshAll()
    const r = await reopenWhenIdle(m.id, pin.title, to, { safe: true })
    if (r.state === 'needs-reopen') notify('info', pinUnsureText('"' + (pin.title || 'The chat') + '"', labelOf(to)))
    else if (r.state === 'pinned') notify('info', '"' + (pin.title || 'The chat') + '" is pinned to ' + labelOf(to) + ' now.')
  } else if (typeof m.folder === 'string' && store.getPin(root(), m.folder)) {
    store.setPin(root(), m.folder, to)
    repin()
    notify('info', '"' + path.basename(m.folder) + '" is pinned to ' + labelOf(to) + ' now. New chats there run on it; chats already open move when you reopen them.')
  }
}

async function unpinChat(id, o) {
  const opt = o || {}
  const pin = chatPins.read(root()).find((p) => p.id === id)
  if (!pin || !chatPins.remove(root(), id)) return null
  waitingChats.delete(id)
  await syncPins()
  refreshAll()
  if (!opt.quiet) notify('info', '"' + (pin.title || 'The chat') + '" is unpinned. It runs on ' + fallbackAccount(id).label + ' the next time it opens.')
  if (!opt.reopen) return { ok: true, state: 'unpinned', reopened: false, waiting: false }
  const title = liveTitle(id, pin.title)
  const fit = opt.safe ? phoneReopenable(id, title) : chatBusy(id) ? 'busy' : 'ok'
  if (fit === 'busy') {
    waitingChats.set(id, { name: null, title, unpinned: true, safe: !!opt.safe })
    scheduleLoginWatch()
    return { ok: true, state: 'unpinned', reopened: false, waiting: true }
  }
  if (fit !== 'ok') return { ok: true, state: fit === 'unsure' ? 'needs-reopen' : 'unpinned', reopened: false, waiting: false }
  const reopened = await reopenChat(id, title, { quiet: !!opt.quiet })
  return { ok: true, state: reopened ? 'unpinned' : 'needs-reopen', reopened, waiting: false }
}

async function confirmUnpinChat(id) {
  const pin = chatPins.read(root()).find((p) => p.id === id)
  if (!pin) return
  const title = liveTitle(id, pin.title)
  const name = title || 'this chat'
  const to = fallbackAccount(id).label
  const fit = phoneReopenable(id, title)
  const open = fit === 'ok' || fit === 'busy'
  const ok = await ui.confirm({
    title: 'Unpin "' + name + '"?',
    message: 'It goes back to ' + to + '. ' +
      (open ? 'If the chat is replying, it finishes first, then reopens on ' + to + '.'
        : fit === 'unsure' ? unsureLine(title, to)
          : 'It opens on ' + to + ' the next time you open it.'),
    confirmLabel: open ? 'Unpin and reopen' : 'Unpin',
  })
  if (!ok) return
  const r = await unpinChat(id, { reopen: fit !== 'closed', quiet: true, safe: true })
  if (!r) return
  const chat = '"' + (title || 'The chat') + '"'
  if (r.waiting) {
    notify('info', chat + ' is unpinned. Claude is still replying, so it reopens on ' + to + ' when this reply finishes. ' +
      'Reopen now moves it at once, but the reply stops part-way.', 'Reopen now')
      .then((b) => {
        const w = waitingChats.get(id)
        if (b !== 'Reopen now' || !w || !w.unpinned) return
        waitingChats.delete(id)
        const now = phoneReopenable(id, liveTitle(id, w.title))
        if (now !== 'ok' && now !== 'busy') { if (now === 'unsure') notify('info', unpinUnsureText(chat, to)); return }
        return reopenChat(id, w.title).then((done) => { if (done) notify('info', chat + ' reopened on ' + to + '. The reply it was writing stopped part-way, so ask it to carry on if you need the rest.') })
      }, () => {})
  } else if (r.reopened) {
    notify('info', chat + ' is unpinned and reopened on ' + to + '. It runs on ' + to + ' from now on.')
  } else if (r.state === 'needs-reopen') {
    notify('info', chatTabs(title).length ? unpinUnsureText(chat, to)
      : chat + ' is unpinned. It\'s running, but not in a tab here, so it keeps its current login until you reopen it: it runs on ' + to + ' then.')
  } else {
    notify('info', chat + ' is unpinned. It opens on ' + to + ' the next time you open it.')
  }
}

function fallbackAccount(id) {
  let lines = []
  try { lines = fs.readFileSync(chatPins.wrapperFile(root()), 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('chat\t')) } catch { lines = [] }
  let name = null
  try { name = lines.length ? chatPins.pinFor(lines, id, chatCwd(id)) : null } catch { name = null }
  if (name) return { name, label: labelOf(name), folder: true }
  const active = store.getActive(root())
  return { name: active || null, label: active ? labelOf(active) : 'the active account', folder: false }
}

function chatCwd(id) {
  const live = liveSessions().get(id)
  if (live && live.cwd) return live.cwd
  let fd
  try {
    const f = chatPins.chatFile(path.join(windowsLib.claudeDir(), 'projects'), id)
    if (!f) return null
    fd = fs.openSync(f, 'r')
    const buf = Buffer.alloc(64 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n))
    return m ? JSON.parse('"' + m[1] + '"') : null
  } catch { return null } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {  } }
}

function phoneReopenable(id, title) {
  const live = liveSessions()
  const me = live.get(id)
  if (!me) return 'closed'
  const tabs = chatTabs(title)
  if (tabs.length !== 1) return 'unsure'
  for (const [sid, s] of live) {
    if (sid === id) continue
    const other = liveTitle(sid, s.name)
    if (other && tabs.some((t) => chatPins.tabMatches(t.label, other))) return 'unsure'
  }
  return me.status === 'idle' ? 'ok' : 'busy'
}

const REQUESTS_PER_TICK = 5

let requestsRunning = false
async function requestsTick() {
  if (requestsRunning) return
  requestsRunning = true
  try {
    let done = 0
    for (const r of requestsLib.pending(root())) {
      if (done >= REQUESTS_PER_TICK) break
      const title = requestsLib.validSession(r.sessionId) ? chatTitleOf(r.sessionId) : null
      const fit = title ? phoneReopenable(r.sessionId, title) : 'closed'
      const here = fit === 'ok' || fit === 'busy'
      if (!here && r.ageMs < requestsLib.CLAIM_ANY_MS) continue
      const req = requestsLib.claim(root(), r.id)
      if (!req) continue
      done++
      try {
        let res
        try { res = await handleRequest(req, here) } catch (e) {
          log('phone request: ' + (e && e.message))
          res = { ok: false, state: 'failed', text: 'The Switcher couldn\'t do this: ' + ((e && e.message) || e) }
        }
        requestsLib.finish(root(), r.id, res)
      } catch (e) { log('phone request: answering: ' + (e && e.message)) }
    }
    requestsLib.sweep(root())
  } catch (e) { log('phone requests: ' + (e && e.message)) } finally { requestsRunning = false }
}

async function handleRequest(req, here) {
  const c = requestsLib.check(root(), req)
  if (!c.ok) return { ok: false, state: 'failed', text: c.text }
  const id = req.sessionId
  const title = chatTitleOf(id)
  const chat = '"' + (title || 'The chat') + '"'
  const openElsewhere = !here && liveSessions().has(id)
  if (req.kind === 'unpinChat') {
    const r = await unpinChat(id, { reopen: here, quiet: true, safe: true })
    if (!r) return { ok: true, state: 'unpinned', text: chat + ' wasn\'t pinned.' }
    const state = openElsewhere ? 'needs-reopen' : r.state
    const fb = fallbackAccount(id)
    const to = fb.folder ? fb.label + ' (its folder\'s account)' : fb.label
    notify('info', 'Unpinned ' + chat + ' from your phone.' + (r.waiting ? ' It moves to ' + fb.label + ' when this reply finishes.' : ''))
    const text = state === 'needs-reopen' ? unpinUnsureText(chat, to)
      : r.waiting ? chat + ' is unpinned. It moves to ' + to + ' when its current reply finishes.'
        : r.reopened ? chat + ' is unpinned and reopened on ' + to + '.'
          : chat + ' is unpinned. It runs on ' + to + ' the next time it opens.'
    return { ok: true, state, text }
  }
  const name = req.account
  const label = labelOf(name)
  const current = chatPins.read(root()).find((p) => p.id === id)
  if (current && current.name === name && (!here || waitingChats.has(id))) {
    return waitingChats.has(id) ? { ok: true, state: 'waiting', text: chat + ' is already pinned to ' + label + ' and moves when its current reply finishes.' }
      : { ok: true, state: 'pinned', text: chat + ' is already pinned to ' + label + '.' }
  }
  const r = await applyChatPin(id, name, title, { reopen: here, quiet: true, safe: true })
  if (!r.ok) return { ok: false, state: 'failed', text: 'Claude Code\'s "Claude Process Wrapper" setting couldn\'t be set (it may be set to another program), so nothing was pinned.' }
  if (openElsewhere && r.state === 'pinned') r.state = 'needs-reopen'
  notify('info', 'Pinned ' + chat + ' to ' + label + ' from your phone.' + (r.state === 'waiting' ? ' It moves when this reply finishes.' : ''))
  const text = {
    pinned: chat + ' is pinned to ' + label + '. It moves to ' + label + ' the next time it opens.',
    waiting: chat + ' is pinned to ' + label + '. It moves when its current reply finishes.',
    reopened: chat + ' is pinned to ' + label + ' and reopened on it.',
    'needs-reopen': pinUnsureText(chat, label),
  }[r.state]
  return { ok: true, state: r.state, text }
}

async function reopenChat(id, savedTitle, o) {
  const title = liveTitle(id, savedTitle)
  const tabs = chatTabs(title)
  if (tabs.length > 1) {
    log('chat pins: not reopening "' + title + '": ' + tabs.length + ' open chats show that title')
    if (!(o && o.quiet)) notify('info', tabs.length + ' open chats are called "' + title + '", so the one that moved wasn\'t reopened, to be sure the right one ' +
      'restarts. Close it, then open it again from Claude Code\'s past conversations: it starts on its new account then.')
    return false
  }
  try {
    if (tabs.length) await vscode.window.tabGroups.close(tabs)
    log('chat pins: reopening "' + (title || id) + '" (' + tabs.length + ' tab' + (tabs.length === 1 ? '' : 's') + ' closed)')
  } catch (e) { log('reopen chat: closing its tab: ' + (e && e.message)) }
  await vscode.commands.executeCommand('claude-vscode.editor.open', id)
  return true
}

function chatTabs(title) {
  const out = []
  if (!title || !vscode.window.tabGroups) return out
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      const view = t.input && t.input.viewType
      if (typeof view === 'string' && /claudeVSCodePanel$/.test(view) && chatPins.tabMatches(t.label, title)) out.push(t)
    }
  }
  return out
}

async function unpinFolder(folder) {
  if (!folder || !store.getPin(root(), folder)) return
  store.setPin(root(), folder, null)
  repin()
  notify('info', '"' + path.basename(folder) + '" is unpinned. New chats there use the active account now; ' +
    'chats already open move to it when you reopen them.')
}

function sparesRoot() { return path.join(root(), 'spares') }

const SPARE_MAX_AGE_MS = LOGIN_TIMEOUT_MS + 5 * 60 * 1000

function destroySpare(dir) {
  try { credstore.remove(dir) } catch (e) { log('spare login cleanup (will retry): ' + (e && e.message)); return false }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { log('spare folder cleanup: ' + (e && e.message)) }
  return true
}

function cleanupSpares() {
  let entries = []
  try { entries = fs.readdirSync(sparesRoot()) } catch { return 0 }
  let removed = 0
  for (const e of entries) {
    const dir = path.join(sparesRoot(), e)
    const owner = fsx.readJsonLoose(path.join(dir, 'owner.json'), null)
    let born = 0
    try { born = (owner && Number(owner.startedAt)) || fs.statSync(dir).mtimeMs } catch { continue }
    if (owner && fsx.pidAlive(owner.pid) && Date.now() - born < SPARE_MAX_AGE_MS) continue
    if (destroySpare(dir)) removed++
  }
  if (removed) log('removed ' + removed + ' unfinished login(s) for another PC')
  return removed
}

async function askPassphrase(title) {
  const first = await ui.input({
    title: title || 'Passphrase for the login file',
    prompt: 'You will type this again on the other PC to import it. At least ' + moveLib.MIN_PASSPHRASE + ' characters.',
    password: true, ignoreFocusOut: true,
    validateInput: (v) => (v && v.length >= moveLib.MIN_PASSPHRASE ? null : 'Use at least ' + moveLib.MIN_PASSPHRASE + ' characters.'),
  })
  if (!first) return null
  const again = await ui.input({
    title: title || 'Passphrase for the login file',
    prompt: 'Type it once more.', password: true, ignoreFocusOut: true,
  })
  if (again === undefined) return null
  if (again !== first) {
    notify('warn', "The two passphrases didn't match, so nothing was made. Try again whenever you like.")
    return null
  }
  return first
}

async function makeSpareLogin(nameArg) {
  const name = typeof nameArg === 'string' && profilesLib.exists(root(), nameArg) ? nameArg : null
  if (!name) return false
  const meta = profilesLib.readMeta(root(), name) || {}
  const expected = meta.email || null
  const label = labelOf(name)

  const go = await notify('info', 
    'Make a separate login for "' + label + '" to take to another PC?',
    { modal: true, detail: 'You will sign in to ' + (expected || 'the account') + ' once more in the browser, ' +
      'so you need its login or a code from its owner. The new login goes into a passphrase-protected file. ' +
      'This PC keeps its own login for "' + label + '", and nothing here changes.\n\n' +
      'Like any login, it lasts about four weeks from today, even while it sits in the file.' },
    'Continue')
  if (go !== 'Continue') return false

  const passphrase = await askPassphrase()
  if (!passphrase) return false

  const target = await vscode.window.showSaveDialog({
    title: 'Save the login for another PC',
    saveLabel: 'Save login file',
    defaultUri: vscode.Uri.file(path.join(os.homedir(), name + '-login.move')),
    filters: { 'Account move file': ['move'] },
  })
  if (!target) return false

  fs.mkdirSync(sparesRoot(), { recursive: true })
  const dir = fs.mkdtempSync(path.join(sparesRoot(), name + '-' + process.pid + '-'))
  store.lockdown(dir)
  fsx.writeJsonAtomic(path.join(dir, 'owner.json'), { pid: process.pid, startedAt: Date.now() })
  let term = null
  try {
    const startedAt = Date.now()
    term = launchTerminal('Claude login for another PC: ' + label, dir,
      loginArgs(expected))
    if (!term) return false

    const res = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      cancellable: true,
      title: 'Signing in a login for another PC: "' + label + '"' + (expected ? ' (' + expected + ')' : '') +
        '. Finish in the browser; use a private window if it is signed in to another account.',
    }, (_progress, token) => watchLogin(dir, startedAt, token))
    finishLoginDir(dir)
    if (!res || !res.ok) {
      if (res && res.reason === 'timed out') notify('warn', 'Stopped waiting for the login for "' + label + '". Nothing was saved.')
      return false
    }

    let cfg = {}
    try { cfg = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')) || {} } catch {  }
    const o = cfg.oauthAccount || {}
    const got = (res.status && res.status.email) || o.emailAddress || null
    if (expected && (!got || got.toLowerCase() !== expected.toLowerCase())) {
      await notify('warn', 'That signed in as ' + (got || 'an unknown account') + ', not ' + expected +
        ', so nothing was saved. Your browser probably reused another account. Try again in a private window signed in to ' +
        expected + '.', { modal: true })
      return false
    }
    const credentials = credstore.read(dir)
    if (!credentials || !credentials.claudeAiOauth || !credentials.claudeAiOauth.refreshToken) {
      throw new Error('the sign-in finished, but its login could not be read')
    }

    const identity = {}
    for (const k of profilesLib.IDENTITY_KEYS) if (cfg[k] !== undefined) identity[k] = cfg[k]
    const capturedAt = new Date().toISOString()
    const account = {
      name,
      payload: { credentials, identity, capturedAt },
      meta: { email: got || expected, org: o.organizationName || meta.org || null, subscription: o.seatTier || null,
        plan: profilesLib.planOf(o, credentials), loginExpiresAt: profilesLib.loginExpiresAt(credentials), capturedAt,
        accountUuid: o.accountUuid || meta.accountUuid || null },
      display: store.displayOf(root(), name),
      remote: store.getRemote(root(), name),
      artifacts: store.getArtifacts(root(), name),
    }
    const file = target.fsPath
    fsx.writeFileAtomic(file, moveLib.seal({ exportedAt: capturedAt, kind: 'login-for-another-pc', accounts: [account] }, passphrase),
      { mode: 0o600, forceMode: true, fsync: true })
    const back = moveLib.open(fs.readFileSync(file, 'utf8'), passphrase)
    if (!back.accounts || !back.accounts[0] ||
      back.accounts[0].payload.credentials.claudeAiOauth.refreshToken !== credentials.claudeAiOauth.refreshToken) {
      throw new Error("the file didn't read back correctly")
    }
    log('made a login for another PC for "' + name + '"')
    notify('info', 'Saved a separate login for "' + label + '" to ' + file + '. ' +
      importHint() + ' It lasts about four weeks from today.')
    return true
  } finally {
    if (term) { try { term.dispose() } catch {  } }
    destroySpare(dir)
  }
}

function importHint() {
  return editionLib.hasFeature(edition, 'transfer')
    ? 'On the other PC, open Claude Accounts → Add account → Import from a move file, type the same passphrase, then delete the file.'
    : 'On the other PC, import it with move-accounts.js and the same passphrase, then delete the file.'
}

function downloadsDir() {
  const d = path.join(os.homedir(), 'Downloads')
  return fs.existsSync(d) ? d : os.homedir()
}

function revealFile(file) {
  vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file)).then(() => {}, () => {})
}

async function moveToAnotherPC(nameArg) {
  const name = typeof nameArg === 'string' && profilesLib.exists(root(), nameArg) ? nameArg : null
  if (!name) return false
  const label = labelOf(name)
  if (profilesLib.activeProfile(root()) === name) {
    await notify('warn', '"' + label + '" is the account Claude Code is using now, so it can\'t leave this PC yet.',
      { modal: true, detail: 'Switch to another account first, then move it.' })
    return false
  }
  const go = await notify('warn', 'Move "' + label + '" to another PC?', {
    modal: true,
    detail: 'It will be removed from this PC as soon as the file is saved. To use it here again later, sign in again, ' +
      'or move it back from the other PC.\n\nTo keep it here as well, use "Make a login for another PC…" instead.',
  }, 'Move it')
  if (go !== 'Move it') return false

  const passphrase = await askPassphrase('Passphrase for the move file')
  if (!passphrase) return false
  const target = await vscode.window.showSaveDialog({
    title: 'Save "' + label + '" for the other PC',
    saveLabel: 'Save and remove from this PC',
    defaultUri: vscode.Uri.file(path.join(downloadsDir(), name + '.move')),
    filters: { 'Account move file': ['move'] },
  })
  if (!target) return false

  const res = await transferLib.exportAccounts(root(), [name], passphrase, target.fsPath, { overwrite: true })
  try { store.setArtifacts(root(), name, 'on') } catch (e) { log('artifacts pref: ' + e.message) }
  log('moved "' + name + '" out of this PC')
  refreshAll()
  notify('info', 'Moved "' + label + '" out of this PC, into ' + res.file + '. ' + importHint(), 'Show file')
    .then((pick) => { if (pick === 'Show file') revealFile(res.file) }, () => {})
  return true
}

async function importFromFile() {
  const sel = await vscode.window.showOpenDialog({
    title: 'Import accounts from a move file',
    openLabel: 'Import',
    canSelectMany: false,
    defaultUri: vscode.Uri.file(downloadsDir()),
    filters: { 'Account move file': ['move'] },
  })
  if (!sel || !sel[0]) return false
  const file = sel[0].fsPath
  if (transferLib.wasImported(file)) {
    notify('warn', path.basename(file) + ' was imported once already. A login can only be used on one PC; ' +
      'ask for a new file instead.')
    return false
  }

  let read = null
  for (;;) {
    const passphrase = await ui.input({
      title: 'Passphrase for ' + path.basename(file),
      prompt: 'The passphrase chosen when the file was made.',
      password: true, ignoreFocusOut: true,
    })
    if (!passphrase) return false
    try {
      read = transferLib.readFile(file, passphrase)
      break
    } catch (e) {
      if (e.code !== 'EPASSPHRASE') throw e
      if ((await notify('warn', e.message, 'Try again')) !== 'Try again') return false
    }
  }

  const replace = new Set()
  for (const a of read.accounts) {
    if (transferLib.planFor(root(), a, read.exportedAt).action !== 'replace') continue
    const ok = await notify('warn', '"' + a.name + '" is already saved here. Replace its login with the one in the file?',
      { modal: true, detail: 'Do this when the one here has expired. The login saved here is kept in backups.' }, 'Replace')
    if (ok === 'Replace') replace.add(a.name)
  }

  const res = await transferLib.importAccounts(root(), read, { replace })
  const got = res.added.concat(res.replaced)
  const skipped = res.skipped.map((s) => s.name + ' (' + s.reason + ')').join(', ')
  if (!got.length) {
    notify('warn', 'Nothing was imported from ' + path.basename(file) + (skipped ? ': ' + skipped + '.' : '.'))
    return false
  }
  const used = transferLib.markImported(file) || file
  log('imported ' + got.join(', ') + ' from a move file')
  refreshAll()
  notify('info', 
    (res.added.length ? 'Added ' + res.added.map(labelOf).join(', ') + '. ' : '') +
    (res.replaced.length ? 'Replaced the login for ' + res.replaced.map(labelOf).join(', ') + '. ' : '') +
    (skipped ? 'Skipped ' + skipped + '. ' : '') +
    'Delete ' + used + ' now: it holds these logins until you do.',
    'Delete file', 'Show file')
    .then((pick) => {
      if (pick === 'Delete file') { try { fs.rmSync(used, { force: true }) } catch (e) { log('delete move file: ' + e.message) } }
      else if (pick === 'Show file') revealFile(used)
    }, () => {})
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
      notify('info', 'No window logins yet.')
      return
    }
    const pick = await ui.pick(names.map((n) => {
      const id = windowsLib.identity(root(), n)
      return { label: labelOf(n), description: id && id.email ? id.email : undefined, name: n }
    }), { placeHolder: 'Forget which window login?' })
    if (!pick) return
    name = pick.name
  }
  if (pinState && pinState.source === 'launch' && pinState.name === name) {
    notify('warn', 'This window was started with that window login. Forget it from another window.')
    return
  }
  const confirm = await ui.confirm({ title: 'Forget the old window login for ' + labelOf(name) + '?',
    message: 'Pins no longer use it: they use this account’s pinning login. Your chats, your pins and the account saved in the switcher are not affected.',
    confirmLabel: 'Forget' })
  if (!confirm) return
  const kept = windowsLib.remove(root(), name)
  refreshAll()
  const keptNote = typeof kept === 'string' && kept.includes(path.join(root(), 'backups'))
    ? ' Its own files (like a CLAUDE.md or settings made in that window) are kept in ' + kept + '.' : ''
  notify('info', 'Forgot the old window login for "' + labelOf(name) + '".' + keptNote)
}

function privateFiles() {
  const p = profilesLib.paths()
  return [p.claudeJson, path.join(p.claudeDir, 'settings.json')]
}

function looseFiles() { return privateFiles().filter((f) => fsx.othersCanRead(f)) }

function makePrivate(files) {
  const done = []
  for (const f of files) {
    try { fs.chmodSync(fsx.writeTarget(f), 0o600); done.push(f) } catch (e) { log('chmod ' + f + ': ' + (e && e.message)) }
  }
  return done
}

async function offerPrivateFiles(context, always) {
  const loose = looseFiles()
  if (!loose.length) return
  const key = 'claudeswitcher.dontAskPrivateFiles'
  if (!always && context && context.globalState && context.globalState.get(key)) return
  const names = loose.map((f) => f.replace(os.homedir(), '~')).join(' and ')
  const choice = await notify('warn', 
    names + ' can be read by other users on this computer. They can hold ' +
    'MCP server tokens and API keys. Make ' + (loose.length > 1 ? 'them' : 'it') + ' private (only you can read it)?',
    'Make Private', ...(always ? [] : ["Don't Ask Again"]))
  if (choice === 'Make Private') {
    const done = makePrivate(loose)
    notify('info', done.length === loose.length ? 'Done: only you can read them now.'
      : "Some couldn't be changed; Show Status has the details.")
  } else if (choice === "Don't Ask Again" && context && context.globalState) {
    await context.globalState.update(key, true)
  }
}

function removeStaleTemps() {
  const p = profilesLib.paths()
  let n = 0
  n += fsx.removeStaleTemps(path.dirname(p.claudeJson), ['.claude.json'])
  n += fsx.removeStaleTemps(p.claudeDir, ['settings.json', '.credentials.json'])
  for (const sub of ['', 'profiles', 'usage', 'recovery']) n += fsx.removeStaleTemps(path.join(root(), sub))
  const old = path.join(root(), 'registry.json.tmp')
  try { if (Date.now() - fs.statSync(old).mtimeMs > 60000) { fs.rmSync(old, { force: true }); n++ } } catch {  }
  if (n) log('removed ' + n + ' temp file(s) left by interrupted writes')
  return n
}

async function showStatus() {
  output.show(true)
  output.appendLine('')
  output.appendLine('=== Claude accounts ===')
  output.appendLine('edition: ' + edition + (version ? '  v' + version : ''))
  output.appendLine('platform: ' + process.platform + '  ·  saved-account encryption: ' + secretsLib.describe())
  output.appendLine('live login read from: ' + credstore.describe(null))
  output.appendLine('root: ' + root())
  const regErr = store.registryError(root())
  if (regErr) output.appendLine('REGISTRY ERROR: ' + regErr)
  for (const g of profilesLib.duplicates(root())) {
    output.appendLine('SAVED TWICE (one account, several names; forget all but one): ' + g.join(', '))
  }
  const loose = looseFiles()
  if (loose.length) {
    output.appendLine('READABLE BY OTHER USERS: ' + loose.join(', '))
    offerPrivateFiles(null, true).catch(() => {})
  }

  const active = profilesLib.activeProfile(root())
  const st = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking Claude accounts...' },
    () => Promise.resolve(claude.authStatus(profilesLib.paths().claudeDir)))
  output.appendLine('live login: ' + (st.ok
    ? (st.loggedIn ? 'signed in' : 'SIGNED OUT') + '  ' +
      [st.email, st.orgName ? '(' + st.orgName + ')' : null].filter(Boolean).join(' ')
    : 'ERROR: ' + st.error))
  const liveUsage = usageLib.readBest(root(), null, { skipClaude: claudeCacheMixed() })
  output.appendLine('usage: ' + (usageLib.compactText(liveUsage) || 'n/a') +
    (liveUsage && liveUsage.stale && liveUsage.fetchedAtMs ? '  (old: as of ' + new Date(liveUsage.fetchedAtMs).toISOString() + ')' : ''))
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
    ? 'pinned to ' + pinState.name + ' (' + (pinState.source === 'pin' ? 'pinning login' : pinState.source) + ')'
    : pinState && pinState.problem === 'no-pinning' ? 'folder pinned to ' + pinState.name + ', which has no pinning login: active account' : 'active account'))
  const pinning = loginsLib.names(root()).filter((n) => pinningOf(n))
  output.appendLine('pinning logins: ' + (pinning.length ? pinning.map((n) => n + ' (until ' + new Date(pinningOf(n).expiresAt).toISOString().slice(0, 10) + ')').join(', ') : '(none)'))
  output.appendLine('chat pins: ' + chatPins.read(root()).length + '; wrapper: ' + (vscode.workspace.getConfiguration('claudeCode').get('claudeProcessWrapper') || 'off'))
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
  if (!fs.existsSync(p)) fsx.writeJsonAtomic(p, store.readRegistry(root()), { mode: 0o600, forceMode: true })
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
    notify('info', 'Anthropic is rate-limiting usage checks for this ' +
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
      usageLib.writeLiveCache(root(), cur.dir, res.utilization, res.loginExpiresAt)
      updateUsageBar()
      postState()
      log('live usage fetched for ' + (cur.name || 'default'))
    } else if (res.rateLimited) {
      const wait = res.retryAfterMs || DEFAULT_USAGE_PAUSE_MS
      usagePausedUntil.set(pauseKey, Date.now() + wait)
      usageBar.text = previousText
      updateUsageBar()
      log('usage rate-limited for ' + (cur.name || 'default') + '; pausing ' + Math.round(wait / 1000) + 's')
      notify('warn', 'Anthropic is rate-limiting usage checks for this account ' +
        'right now, which is common just after switching. The meter is showing cached figures; ' +
        'try again in about ' + minutesFrom(wait) + ' min.')
    } else {
      usageBar.text = previousText
      updateUsageBar()
      notify('warn', 
        'Couldn\'t fetch live usage: ' + res.reason + '. Showing the last figures we have for now.')
    }
  } catch (e) {
    usageBar.text = previousText
    updateUsageBar()
    notify('error', 'Usage refresh failed: ' + (e && e.message))
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
    logoUri: String(webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir(), 'icon.png')))),
    layout,
  })
}

function pageState() {
  const contextOf = contextByAccount()
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
    registryError: store.registryError(root()),
    duplicates: profilesLib.duplicates(root()).map((g) => g.map(labelOf)),
    edition,
    version,
    tracking: trackingEnabled(),
    updating: updatingAll || (trackerRunning && trackerManual),
    features: {
      artifacts: editionLib.hasFeature(edition, 'artifacts'),
      spareLogin: editionLib.hasFeature(edition, 'spareLogin'),
      startSession: editionLib.hasFeature(edition, 'startSession'),
      context: editionLib.hasFeature(edition, 'context'),
      transfer: editionLib.hasFeature(edition, 'transfer'),
      autoContinue: editionLib.hasFeature(edition, 'autoContinue'),
      keepAlive: editionLib.hasFeature(edition, 'keepAlive'),
    },
    live: { email: (id && id.email) || null, saved: !!active, label: active ? labelOf(active) : null },
    window: {
      folder: here,
      pinnedTo: pinnedHere() ? pinState.name : null,
      pinnedLabel: pinnedHere() ? labelOf(pinState.name) : null,
      needsPinning: !!(pinState && pinState.source === 'pin' && !pinState.ready) ? labelOf(pinState.name) : null,
    },
    accounts: inOrder(profilesLib.list(root())).map((p) => {
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
        starting: startingSessions.has(p.name),
        keepAlive: store.getKeepAlive(root(), p.name),
        context: contextOf[p.name] || null,
        plan: profilesLib.planName(p.plan),
        orgId: orgOf(p.name),
        loginExpiresAt: loginExpiryOf(p.name, null, p.name === active),
        session: r.session || null,
        weekly: r.weekly || null,
        scoped: r.scoped || null,
        noSession: !!r.noSession,
        fetchedAtMs: r.fetchedAtMs || null,
        extra: cardsLib.extraOf(r.extra),
        windowLogin: hasWindowDir ? (() => {
          const st = windowsLib.loginState(root(), p.name)
          return { signedIn: st === 'yes', expired: st === 'expired', email: (wid && wid.email) || null }
        })() : null,
        pinCount: pinCount(p.name),
        pinning: pinningOf(p.name),
      }
    }),
    pins: Object.entries(pins).map(([folder, name]) => ({
      folder, name, label: labelOf(name), here: !!(here && store.pinKey(here) === folder), ready: pinningReady(name),
    })),
    chatPins: chatPins.read(root()).filter((p) => profilesLib.exists(root(), p.name))
      .map((p) => ({ id: p.id, name: p.name, label: labelOf(p.name), title: p.title, ready: pinningReady(p.name),
        waiting: waitingChats.has(p.id) && chatBusy(p.id) })),
    autoContinue: autoContinueOn() ? autoContinueState() : null,
    prefs: allPrefs(),
    welcome: welcomeState(),
    checklist: checklistState(),
  }
}

function autoContinueState() {
  const waiting = Object.entries(autoLib.readState(root()).stops)
    .filter(([, e]) => e.state === 'waiting' && e.resetAt)
    .map(([id, e]) => ({ id, title: String(e.title || 'A chat').slice(0, 60), at: clockText(e.resetAt), on: e.to ? labelOf(e.to) : null }))
  return { ...store.getAutoContinue(root()), waiting }
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

const SEEN_KEY = 'claudeswitcher.seenVersion'
const CHECKLIST_KEY = 'claudeswitcher.checklist'

function checklistState() {
  return !!(extContext && extContext.globalState && extContext.globalState.get(CHECKLIST_KEY) === 'show')
}

function welcomeState() {
  if (!extContext || !extContext.globalState || !version) return null
  return welcomeLib.welcomeFor(extContext.globalState.get(SEEN_KEY), version, profilesLib.list(root()).length > 0)
}

async function offerWelcome() {
  const w = welcomeState()
  if (!w || !extContext.globalState || extContext.globalState.get('claudeswitcher.welcomeOffered') === version) return
  await extContext.globalState.update('claudeswitcher.welcomeOffered', version)
  if (w.kind === 'install') { openAccountsTab(); return }
  const pick = await notify('info', 'Switcher for Claude Code was updated to ' + version + '.', 'See What’s New')
  if (pick === 'See What’s New') openAccountsTab()
}

const asks = new Map()
let askSeq = 0

const PAGE_ICON = {
  save: 'check', 'sign-in': 'signin', 'cloud-download': 'upload', folder: 'folder', 'folder-opened': 'folder',
  close: 'x', pin: 'pin', 'comment-discussion': 'chat', 'settings-gear': 'gear', window: 'window', trash: 'trash',
}

function pageItems(list) {
  return list.map((it, i) => {
    const label = String(it.label || '')
    const m = /^\$\(([\w-]+)\)\s*/.exec(label)
    return {
      i,
      label: label.replace(/^\$\([\w-]+\)\s*/, ''),
      description: it.description ? String(it.description) : '',
      icon: m ? PAGE_ICON[m[1]] || null : null,
      account: typeof it.name === 'string' && profilesLib.exists(root(), it.name) ? it.name : null,
      current: !!(m && m[1] === 'pin'),
    }
  })
}

function pageWebviews() { return [panel && panel.webview, view && view.webview].filter(Boolean) }

function postAsks() {
  for (const w of pageWebviews()) {
    for (const [id, a] of asks) w.postMessage({ type: 'ask', id, spec: a.spec }).then(() => {}, () => {})
  }
}

function endAsk(id, value) {
  const a = asks.get(id)
  if (!a) return
  asks.delete(id)
  for (const w of pageWebviews()) w.postMessage({ type: 'askDone', id }).then(() => {}, () => {})
  a.resolve(value)
}

function cancelAsksIfNoPage() {
  if (panel || view) return
  for (const id of [...asks.keys()]) endAsk(id, undefined)
  for (const id of [...notes.keys()]) endNote(id, undefined)
}

async function askViaPage(spec, list) {
  const id = ++askSeq
  const answer = new Promise((resolve) => asks.set(id, { spec, resolve }))
  await openAccounts()
  postAsks()
  const v = await answer
  if (spec.kind === 'pick') return v === undefined ? undefined : list[v]
  return v
}

let asker = askViaPage

function openAsk(spec) {
  const id = ++askSeq
  const answer = new Promise((resolve) => asks.set(id, { spec, resolve }))
  if (asker === askViaPage) openAccounts().then(postAsks, (e) => log('page: ' + (e && e.message)))
  return { id, answer }
}

function updateAsk(id, spec) {
  const a = asks.get(id)
  if (!a) return
  a.spec = spec
  for (const w of pageWebviews()) w.postMessage({ type: 'ask', id, spec }).then(() => {}, () => {})
}

const ui = {
  async pick(items, opts) {
    const list = (await items || []).filter(Boolean)
    if (!list.length) return undefined
    const o = opts || {}
    return asker({ kind: 'pick', title: o.title || null, placeholder: o.placeHolder || '', items: pageItems(list) }, list)
  },
  async confirm(opts) {
    const o = opts || {}
    const v = await asker({ kind: 'confirm', title: o.title || '', message: o.message || '', confirmLabel: o.confirmLabel || 'OK' }, null)
    return v === true ? true : undefined
  },
  async input(opts) {
    const o = opts || {}
    let value = o.value || ''
    let error = null
    for (;;) {
      const v = await asker({ kind: 'input', title: o.title || null, prompt: o.prompt || '', placeholder: o.placeHolder || '',
        value, password: !!o.password, error }, null)
      if (v === undefined || v === null) return undefined
      const err = o.validateInput ? o.validateInput(String(v)) : null
      if (!err) return String(v)
      value = o.password ? '' : String(v)
      error = err
    }
  },
  async ask(spec) {
    const v = await asker(Object.assign({ rich: true }, spec), null)
    if (v === undefined || v === null) return undefined
    const o = typeof v === 'object' ? v : { value: v }
    if (spec.kind === 'account') {
      return { label: typeof o.value === 'string' ? o.value.trim().slice(0, 40) : '', color: o.color, icon: o.icon }
    }
    if (Array.isArray(spec.buttons) && spec.buttons.includes(o.value)) return { value: o.value, checked: o.checked, text: o.text }
    if (o.closed === true && spec.cancel === false && (spec.check || spec.field)) return { value: null, closed: true, checked: o.checked, text: o.text }
    return undefined
  },
  account(spec) { return ui.ask(Object.assign({ kind: 'account' }, spec)) },
  async choose(opts) {
    const o = opts || {}
    const buttons = (o.buttons || []).filter((b) => typeof b === 'string' && b)
    if (!buttons.length) return undefined
    const v = await asker({ kind: 'confirm', tone: o.tone || 'info', title: o.title || '', message: o.message || '', buttons }, null)
    return typeof v === 'string' && buttons.includes(v) ? v : undefined
  },
}

let noticesInPage = true
const notes = new Map()
let noteSeq = 0
const VSCODE_SHOW = { info: 'showInformationMessage', warn: 'showWarningMessage', error: 'showErrorMessage' }

function notify(tone, text, ...rest) {
  const opts = rest.length && rest[0] && typeof rest[0] === 'object' ? rest.shift() : null
  const buttons = rest.filter((b) => typeof b === 'string' && b)
  if (opts && opts.modal) {
    if (!buttons.length) return ui.choose({ tone, title: String(text), message: opts.detail || '', buttons: ['OK'] }).then(() => undefined)
    return ui.choose({ tone, title: String(text), message: opts.detail || '', buttons })
  }
  const pages = noticesInPage ? [panel && panel.visible && panel.webview, view && view.visible && view.webview].filter(Boolean) : []
  if (!pages.length) return Promise.resolve(vscode.window[VSCODE_SHOW[tone] || VSCODE_SHOW.info](text, ...(opts ? [opts] : []), ...buttons))
  const id = ++noteSeq
  return new Promise((resolve) => {
    notes.set(id, { resolve, buttons })
    for (const w of pages) w.postMessage({ type: 'note', id, tone, text: String(text), buttons }).then(() => {}, () => {})
  })
}

function endNote(id, label) {
  const n = notes.get(id)
  if (!n) return
  notes.delete(id)
  for (const w of pageWebviews()) w.postMessage({ type: 'noteDone', id }).then(() => {}, () => {})
  n.resolve(typeof label === 'string' && n.buttons.includes(label) ? label : undefined)
}

const PAGE_ACTIONS = {
  ready: () => { postState(); postAsks() },
  note: (m) => endNote(m.id, m.label),
  answer: (m) => {
    const a = asks.get(m.id)
    if (!a) return
    let v
    if (!m.cancel) {
      if (m.closed === true) {
        v = a.spec.kind === 'confirm' && a.spec.rich && a.spec.cancel === false && (a.spec.check || a.spec.field)
          ? { value: null, closed: true, checked: typeof m.checked === 'boolean' ? m.checked : undefined, text: typeof m.text === 'string' ? m.text.slice(0, 200) : undefined }
          : undefined
      } else if (a.spec.kind === 'pick') v = Number.isInteger(m.index) && m.index >= 0 && m.index < a.spec.items.length ? m.index : undefined
      else if (a.spec.kind === 'confirm' && a.spec.buttons && a.spec.rich) {
        v = a.spec.buttons.includes(m.value)
          ? { value: m.value, checked: typeof m.checked === 'boolean' ? m.checked : undefined, text: typeof m.text === 'string' ? m.text.slice(0, 200) : undefined }
          : undefined
      } else if (a.spec.kind === 'confirm' && a.spec.buttons) v = a.spec.buttons.includes(m.value) ? m.value : undefined
      else if (a.spec.kind === 'account') {
        v = typeof m.value === 'string' ? { value: m.value.slice(0, 200), color: typeof m.color === 'string' ? m.color : undefined, icon: typeof m.icon === 'string' ? m.icon : undefined } : undefined
      } else if (a.spec.kind === 'checks') v = m.value === 'fix' && Number.isInteger(m.index) ? { value: 'fix', index: m.index } : m.value === 'again' ? { value: 'again' } : undefined
      else if (a.spec.kind === 'signin') v = undefined
      else if (a.spec.kind === 'confirm') v = m.value === 'yes' ? true : undefined
      else v = typeof m.value === 'string' ? m.value.slice(0, 1000) : undefined
    }
    endAsk(m.id, v)
  },
  switch: async (m) => {
    if (m.confirmed === true) {
      if (m.dontAsk === true) await setConfirmOrgSwitch(false)
      await switchTo(m.name)
    } else if (await confirmOrgSwitch(m.name)) await switchTo(m.name)
    else postState()
  },
  learnMore: () => { vscode.env.openExternal(vscode.Uri.parse(PRESERVED_THINKING_URL)) },
  welcomeDone: () => {
    if (extContext && extContext.globalState && version) extContext.globalState.update(SEEN_KEY, version).then(() => postState(), () => {})
  },
  setting: (m) => { setPref(m.key, m.value).then(() => postState(), () => {}) },
  add: () => addAccount(),
  saveCurrent: () => saveCurrentLogin(),
  update: () => refreshAllAccounts(),
  edit: (m) => {
    if (profilesLib.exists(root(), m.name) && !editAccount(m.name, m.label, m.icon, m.color)) {
      notify('warn', 'Use a display name of 1–40 characters.')
    }
  },
  remote: (m) => setRemoteFor(m.name, m.on === true),
  artifacts: (m) => { if (editionLib.hasFeature(edition, 'artifacts')) setArtifactsFor(m.name, m.on === true) },
  relogin: (m) => relogin(m.name, m.which === 'pinning' ? 'pinning' : 'main'),
  addPinning: (m) => addPinning(m.name),
  signinCode: (m) => {
    const take = signinCodes.get(m.id)
    if (take && typeof m.code === 'string' && m.code.trim() && m.code.length < 2000) take(m.code.trim())
  },
  copy: (m) => { if (typeof m.text === 'string' && m.text.length < 4000) return vscode.env.clipboard.writeText(m.text) },
  movePin: (m) => movePin(m),
  reopenNow: (m) => { if (chatPins.validId(m.id)) return reopenNow(m.id) },
  checkAll: () => checkAll(),
  checklistDone: () => {
    if (extContext && extContext.globalState) return extContext.globalState.update(CHECKLIST_KEY, true).then(() => postState(), () => {})
  },
  forget: (m) => forgetAccount(m.name),
  forgetWindowLogin: (m) => forgetWindowLogin(m.name),
  spareLogin: (m) => (editionLib.hasFeature(edition, 'spareLogin') ? makeSpareLogin(m.name) : null),
  moveOut: (m) => (editionLib.hasFeature(edition, 'transfer') ? moveToAnotherPC(m.name) : null),
  import: () => (editionLib.hasFeature(edition, 'transfer') ? importFromFile() : null),
  startSession: (m) => startSessionFor(m.name),
  keepAlive: (m) => {
    if (editionLib.hasFeature(edition, 'keepAlive') && profilesLib.exists(root(), m.name)) store.setKeepAlive(root(), m.name, m.on === true)
  },
  autoContinue: (m) => {
    if (!autoContinueOn()) return
    const patch = {}
    if (autoLib.MODES.includes(m.mode)) patch.mode = m.mode
    if (autoLib.PICKS.includes(m.pick)) patch.pick = m.pick
    if (Array.isArray(m.order)) patch.order = m.order.filter((n) => store.validName(n) && profilesLib.exists(root(), n))
    if (m.early === null) patch.early = null
    else if (Number.isInteger(m.early) && m.early >= autoLib.EARLY_MIN && m.early <= autoLib.EARLY_MAX) patch.early = m.early
    store.setAutoContinue(root(), patch)
  },
  cancelContinue: (m) => {
    if (typeof m.id !== 'string' || m.id.length > 200) return
    autoLib.updateState(root(), (s) => { if (s.stops[m.id] && s.stops[m.id].state === 'waiting') s.stops[m.id].state = 'cancelled' })
  },
  pin: (m) => pinFolder(m.name),
  unpin: (m) => unpinFolder(m.folder),
  pinChat: (m) => pinChat(m.name),
  unpinChat: (m) => { if (chatPins.validId(m.id)) return confirmUnpinChat(m.id) },
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
    notify('error', 'Claude Accounts: ' + (e && e.message))
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
  setUpAccountsTab(vscode.window.createWebviewPanel(PANEL_TYPE, 'Claude Accounts',
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, webviewOptions()))
}

function setUpAccountsTab(p) {
  panel = p
  panel.webview.options = webviewOptions()
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
  p.onDidDispose(() => { if (panel === p) panel = null; cancelAsksIfNoPage() })
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
    webviewView.onDidDispose(() => { if (view === webviewView) view = null; cancelAsksIfNoPage() })
  },
}

const OLD_IDS = ['local.claude-account-switcher']

function oldCopyInstalled(context) {
  const own = context && context.extension && context.extension.id
  try {
    return OLD_IDS.find((id) => id !== own && vscode.extensions && vscode.extensions.getExtension(id)) || null
  } catch { return null }
}

function deferToOldCopy(old) {
  notify('warn', 'Switcher for Claude Code is installed twice: an older copy (' + old + ') is still there, ' +
    'and runs instead of this one. Uninstall it and reload to finish the update. Your saved accounts stay as they are.',
  'Uninstall Old Copy')
    .then(async (pick) => {
      if (pick !== 'Uninstall Old Copy') return
      await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', old)
      const next = await notify('info', 'Uninstalled the old copy. Reload to start the new one.', 'Reload Window')
      if (next === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow')
    })
    .then(() => {}, () => {})
}

function activate(context) {
  const old = oldCopyInstalled(context)
  if (old) { deferToOldCopy(old); return }

  edition = editionLib.from(context)
  version = (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || null
  extensionPath = (context.extensionPath) || __dirname
  try { editorsLib.record(root(), editorsLib.userDirOf(context.globalStorageUri && context.globalStorageUri.fsPath), extensionPath) } catch {  }

  pinState = null
  applyPin()

  process.env[chatPins.ENV] = chatPins.wrapperFile(root())

  const claudeExt = vscode.extensions && vscode.extensions.getExtension('anthropic.claude-code')
  if (claudeExt) { claude.addBundledHint(claudeExt.extensionPath); claudeExtPath = claudeExt.extensionPath }

  output = vscode.window.createOutputChannel('Switcher for Claude Code')
  context.subscriptions.push(output)
  if (pinState) {
    log('folder pin: ' + JSON.stringify({ source: pinState.source, name: pinState.name, ready: pinState.ready,
      problem: pinState.problem, error: pinState.error }))
  }
  if (pinState && pinState.problem === 'no-pinning') {
    const n = pinState.name
    notify('warn', 'This folder is pinned to "' + labelOf(n) + '", which has no pinning login, ' +
      'so chats here use the active account.', 'Add account for pinning').then((c) => {
      if (c === 'Add account for pinning') addPinning(n).catch((e) => log('pinning: ' + (e && e.message)))
    }, () => {})
  }

  store.ensureRoot(root())
  secretsLib.addGuardRoot(root())

  try {
    if (store.getMode(root()) !== 'login') {
      store.setMode(root(), 'login')
      log('switched to global mode (the older per-window modes were removed)')
    }
  } catch (e) { log('mode: ' + (e && e.message)) }
  extContext = context
  resolveMachineConfigDir(false).catch((e) => log('could not clear config dir override: ' + (e && e.message)))

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.command = pinnedHere() ? 'claudeswitcher.pinFolder' : 'claudeswitcher.globalSwitch'
  statusBar.name = 'Claude Account'
  context.subscriptions.push(statusBar)

  usageBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
  usageBar.command = 'claudeswitcher.refreshAllAccounts'
  usageBar.name = 'Claude Usage'
  context.subscriptions.push(usageBar)
  daysBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98)
  daysBar.name = 'Claude Login Days'
  daysBar.command = 'claudeswitcher.openAccounts'
  pinDaysBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97)
  pinDaysBar.name = 'Claude Pinning Login Days'
  pinDaysBar.command = 'claudeswitcher.openAccounts'
  context.subscriptions.push(daysBar, pinDaysBar)
  if (vscode.window.tabGroups && vscode.window.tabGroups.onDidChangeTabs) {
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => { updateUsageBar(); updateStatusBar() }))
  }

  contextBar = null
  if (editionLib.hasFeature(edition, 'context')) {
    contextBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99.5)
    contextBar.name = 'Claude Context'
    context.subscriptions.push(contextBar)
  }

  const cmds = {
    openAccounts, globalSwitch, globalAdd: addAccount, pinFolder, pinChat, refreshAllAccounts, showStatus,
    switchTo, refreshUsage, relogin, openAccountsTab, startSession: startSessionFor,
  }
  for (const id of Object.keys(cmds)) {
    if (!editionLib.includes(edition, id)) continue
    context.subscriptions.push(vscode.commands.registerCommand('claudeswitcher.' + id, (...args) =>
      Promise.resolve(cmds[id](...args)).catch((e) => {
        log(id + ' failed: ' + (e && e.stack))
        notify('error', 'Claude Accounts: ' + (e && e.message))
      })))
  }

  if (vscode.window.registerWebviewViewProvider) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, viewProvider))
  }
  if (vscode.window.registerWebviewPanelSerializer) {
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
      deserializeWebviewPanel: async (p) => {
        if (panel && panel !== p) { p.dispose(); return }
        setUpAccountsTab(p)
        postState()
      },
    }))
  }

  try { applyPreferences(profilesLib.activeProfile(root())) } catch (e) { log('remote and artifacts prefs: ' + e.message) }

  try { cleanupSpares() } catch (e) { log('spare cleanup: ' + (e && e.message)) }
  try { kickoffLib.cleanup(root()) } catch (e) { log('session cleanup: ' + (e && e.message)) }
  try { removeStaleTemps() } catch (e) { log('temp cleanup: ' + (e && e.message)) }
  const privacyTimer = setTimeout(() => { offerPrivateFiles(context, false).catch(() => {}) }, 5000)
  if (privacyTimer.unref) privacyTimer.unref()
  context.subscriptions.push({ dispose: () => clearTimeout(privacyTimer) })
  try {
    const filled = profilesLib.fillLoginExpiry(root())
    if (filled.length) log('login end dates read from the saved logins of: ' + filled.join(', '))
  } catch (e) { log('login end dates: ' + (e && e.message)) }
  const recovered = syncStagedLogins()
  if (recovered.length) {
    notify('info', 'Added to the account switcher: ' + recovered.join(', ') + '.')
  }

  try {
    const watcher = fs.watch(root(), (_ev, file) => {
      if (file === 'registry.json') refreshAll()
    })
    context.subscriptions.push({ dispose: () => watcher.close() })
  } catch (e) { log('registry watch unavailable: ' + (e && e.message)) }

  usageTimer = setInterval(() => updateUsageBar(), 60000)
  const contextTimer = setInterval(refreshContext, 30000)
  const compactTimer = contextBar ? setInterval(checkCompacting, 1000) : null
  const limitTimer = setInterval(() => { checkLimits(); keepAliveTick(); roomBackCheck() }, 15000)
  const liveTick = () => { pollLiveUsage().then(earlySwitchCheck, earlySwitchCheck) }
  const liveTimer = setInterval(liveTick, LIVE_EVERY_MS)
  const liveFirst = setTimeout(liveTick, 8000)
  context.subscriptions.push({ dispose: () => {
    clearInterval(contextTimer)
    clearInterval(limitTimer)
    clearInterval(liveTimer)
    clearTimeout(liveFirst)
    if (compactTimer) clearInterval(compactTimer)
    if (compactAnim) { clearInterval(compactAnim); compactAnim = null }
  } })
  refreshContext()
  context.subscriptions.push({ dispose: () => clearInterval(usageTimer) })
  context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => {
    if (s.focused) { updateUsageBar(); refreshContext() }
  }))
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('claudeswitcher.trackAllAccounts')) { refreshAll(); trackerTick() }
    if (e.affectsConfiguration('claudeswitcher')) { updateStatusBar(); updateUsageBar(); postState() }
  }))

  try {
    wrapperPath = chatPins.installWrapper(root(), extensionPath)
    syncPins().catch((e) => log('pins: ' + (e && e.message)))
  } catch (e) { log('chat pins: installing the wrapper: ' + (e && e.message)) }

  try { cleanupSigninDirs() } catch (e) { log('sign-in cleanup: ' + (e && e.message)) }
  startupLogins().then(() => { afterLoginChange(); writePinnedSettingsAll() }, (e) => log('logins: ' + (e && e.message)))
  const loginTimer = loginAuto ? setInterval(() => { loginWatch().catch((e) => log('login watch: ' + (e && e.message))) }, LOGIN_WATCH_MS) : null
  if (loginAuto) requestsLib.beat(root(), { version })
  const loginChangeTimer = loginAuto ? setInterval(() => { fastTick().catch((e) => log('/login watch: ' + (e && e.message))) }, WAITING_CHECK_MS) : null
  context.subscriptions.push({ dispose: () => {
    clearInterval(loginChangeTimer)
    clearInterval(loginTimer)
    if (loginWatchSoon) { clearTimeout(loginWatchSoon); loginWatchSoon = null }
  } })
  if (context.globalState && context.globalState.get(SEEN_KEY) === undefined && context.globalState.get(CHECKLIST_KEY) === undefined &&
    !profilesLib.list(root()).length) {
    Promise.resolve(context.globalState.update(CHECKLIST_KEY, 'show')).then(() => postState(), () => {})
  }

  const welcomeTimer = setTimeout(() => { offerWelcome().catch((e) => log('welcome: ' + (e && e.message))) }, 4000)
  context.subscriptions.push({ dispose: () => clearTimeout(welcomeTimer) })
  const firstTick = trackerAuto ? setTimeout(trackerTick, 20000) : null
  const trackerTimer = trackerAuto ? setInterval(trackerTick, 5 * 60 * 1000) : null
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
  try { requestsLib.unbeat(root()) } catch {  }
  stopLoginWatchers()
  try { signinLib.cancelAll() } catch {  }
}

module.exports = {
  activate,
  deactivate,
  _test: {
    setAsker: (fn) => { asker = fn || askViaPage },
    setSigninStart: (fn) => { signinStart = fn || ((o) => signinLib.start(o)) },
    uiAsk: (spec) => ui.ask(spec),
    setTrackerAuto: (on) => { trackerAuto = !!on },
    setLoginAuto: (on) => { loginAuto = !!on },
    dropSigninDir,
    setSigninDropRetryMs: (list) => { signinDropRetryMs = list || [6000, 30000] },
    openAsks: () => [...asks].map(([id, a]) => ({ id, spec: a.spec })),
    loginWatch, checkAll, startupLogins, writePinnedSettings, loginChangeTick, fastTick, requestsTick, phoneReopenable, fallbackAccount,
    loginChangeMs: () => LOGIN_CHANGE_MS,
    setIdentityDelayMs: (ms) => { identityWaitMs = ms },
    takeoutsPending: () => [...takeouts.keys()], syncPins,
    setNoticesInPage: (on) => { noticesInPage = !!on },
    notify,
    stopLoginWatchers,
    syncStagedLogins,
    cleanupSpares,
    offerPrivateFiles,
    removeStaleTemps,
    setKickoffRun: (fn) => { kickoffRun = fn },
    setHandoffRun: (fn) => { handoffRun = fn },
    setKeepAliveRun: (fn) => { keepAliveRun = fn },
    checkLimits, keepAliveTick, refreshContext, roomBackCheck, prefOf, setPref,
    roomReset: () => { for (const k of Object.keys(roomWaiting)) delete roomWaiting[k]; roomPolled.clear(); roomTold.clear() },
    setLiveUsageRun: (fn) => { liveUsageRun = fn },
    pollLiveUsage, earlySwitchCheck,
    settle: () => Promise.all([...pendingLogins]),
    setLoginPollMs: (ms) => { loginPollMs = ms },
    trackerTick,
    refreshAll,
    pageState,
    onPageMessage,
    viewProvider,
  },
}
