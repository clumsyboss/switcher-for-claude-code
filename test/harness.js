require('./fake-security')
const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TEST_ROOT = path.join(os.tmpdir(), 'cs-test-' + Date.now())

const FAKE_HOME = TEST_ROOT + '-home'
fs.mkdirSync(FAKE_HOME, { recursive: true })
process.env.USERPROFILE = FAKE_HOME
process.env.HOME = FAKE_HOME
delete process.env.CLAUDE_CONFIG_DIR

const q = { input: [], quick: [], info: [], warn: [], open: [], save: [] }
const shift = (a, name) => {
  if (!a.length) throw new Error('harness: no queued response for ' + name)
  return a.shift()
}

let settings = { claudeCode: {}, claudeswitcher: { root: TEST_ROOT } }
const terminals = []
const executed = []
const registered = {}
const messages = []
const bars = []
const panels = []
let viewProvider = null
let panelSerializer = null

function mockWebview() {
  const w = {
    html: '', options: null, cspSource: 'vscode-resource://test', posted: [], handler: null,
    asWebviewUri: (u) => 'vscode-resource://test' + u.fsPath.replace(/\\/g, '/'),
    postMessage: async (m) => { w.posted.push(m); return true },
    onDidReceiveMessage: (fn) => { w.handler = fn; return { dispose() {} } },
  }
  return w
}

const clipboard = { text: null }
const FAKE_APPROOT = path.join(TEST_ROOT + '-vscode', 'resources', 'app')

const vscode = {
  env: { appRoot: FAKE_APPROOT, clipboard: { writeText: async (t) => { clipboard.text = t } } },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { Active: -1 },
  ThemeColor: class { constructor(id) { this.id = id } },
  ThemeIcon: class { constructor(id) { this.id = id } },
  MarkdownString: class { constructor(v) { this.value = v } },
  Uri: { file: (p) => ({ fsPath: p, toString() { return 'file://' + p } }) },
  window: {
    createOutputChannel: () => ({
      appendLine: (l) => messages.push('OUT: ' + l), show() {}, dispose() {},
    }),
    createStatusBarItem: () => {
      const s = {}
      bars.push(s)
      return {
        show() { s.shown = true },
        hide() { s.shown = false }, dispose() {},
        set text(v) { s.text = v },
        get text() { return s.text },
        set tooltip(v) { s.tooltip = v && v.value ? v.value : v; s.trusted = v && v.isTrusted },
        get tooltip() { return s.tooltip },
        set color(v) { s.color = v },
        get color() { return s.color },
        set backgroundColor(v) { s.bg = v },
        get backgroundColor() { return s.bg },
        set command(v) { s.command = v },
        get command() { return s.command },
        set name(v) { s.name = v },
      }
    },
    createWebviewPanel: (id, title, column, options) => {
      const p = {
        id, title, options, visible: true, webview: mockWebview(), revealed: 0, disposeFns: [],
        reveal() { p.revealed++ },
        onDidChangeViewState: () => ({ dispose() {} }),
        onDidDispose: (fn) => { p.disposeFns.push(fn); return { dispose() {} } },
        dispose() { p.visible = false; p.disposeFns.forEach((f) => f()) },
      }
      panels.push(p)
      return p
    },
    registerWebviewViewProvider: (id, provider) => { viewProvider = { id, provider }; return { dispose() {} } },
    registerWebviewPanelSerializer: (id, serializer) => { panelSerializer = { id, serializer }; return { dispose() {} } },
    showOpenDialog: async () => shift(q.open, 'showOpenDialog'),
    showSaveDialog: async () => shift(q.save, 'showSaveDialog'),
    onDidChangeWindowState: () => ({ dispose() {} }),
    showTextDocument: async () => ({}),
    createTerminal: (opts) => {
      const t = { opts, sent: [], show() {}, sendText(s) { t.sent.push(s) }, dispose() { t.disposed = true } }
      terminals.push(t)
      return t
    },
    showInputBox: async () => shift(q.input, 'showInputBox'),
    showQuickPick: async (items) => {
      const want = shift(q.quick, 'showQuickPick')
      if (want === null) return undefined
      const list = await items
      return list.find((i) => (i.name || i) === want || (i.label || '').includes(want)) || want
    },
    showInformationMessage: async (m) => { messages.push('INFO: ' + m); return q.info.length ? q.info.shift() : undefined },
    showWarningMessage: async (m) => { messages.push('WARN: ' + m); return q.warn.length ? q.warn.shift() : undefined },
    showErrorMessage: async (m) => { messages.push('ERROR: ' + m) },
    withProgress: async (_o, fn) => fn({ report() {} }, { isCancellationRequested: false }),
  },
  commands: {
    registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} } },
    executeCommand: async (id, ...args) => { executed.push({ id, args }) },
  },
  workspace: {
    getConfiguration: (section) => ({
      get: (key) => (settings[section] || {})[key],
      update: async (key, val) => { settings[section] = { ...(settings[section] || {}), [key]: val } },
      inspect: () => undefined,
    }),
    workspaceFolders: [],
    onDidChangeConfiguration: () => ({ dispose() {} }),
    openTextDocument: async (uri) => ({ uri }),
  },
}

const origLoad = Module._load
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscode
  return origLoad.call(this, req, parent, isMain)
}

const ext = require('../extension.js')
const store = require('../lib/store.js')
const liveLib = require('../lib/live.js')
const profiles = require('../lib/profiles.js')
const usageLib = require('../lib/usage.js')
const windowsLib = require('../lib/windows.js')
const trackerLib = require('../lib/tracker.js')
const editionLib = require('../lib/edition.js')
const moveLib = require('../lib/movefile.js')

const claudeLib = require('../lib/claude.js')
let authMock = { ok: false, error: 'mocked' }
claudeLib.authStatus = () => authMock
claudeLib.resolveBin = () => 'C:\\fake\\claude.exe'
ext._test.setLoginPollMs(20)
const queueAsker = async (spec, list) => spec.kind === 'pick'
  ? vscode.window.showQuickPick(list, { placeHolder: spec.placeholder })
  : spec.kind === 'confirm' && spec.buttons
    ? vscode.window[spec.tone === 'info' ? 'showInformationMessage' : 'showWarningMessage'](
      spec.title + (spec.message ? ' | ' + spec.message : ''), { modal: true }, ...spec.buttons)
    : spec.kind === 'confirm'
      ? ((await vscode.window.showInformationMessage(spec.title + (spec.message ? ' | ' + spec.message : ''), spec.confirmLabel)) === spec.confirmLabel || undefined)
      : vscode.window.showInputBox({ prompt: spec.prompt, value: spec.value, password: spec.password })
ext._test.setAsker(queueAsker)
ext._test.setNoticesInPage(false)

const chatPinsLib = require('../lib/chatpins.js')
const loginsLib = require('../lib/logins.js')
const DAY = 86400000

const signinQ = []
const signins = []
function writeSignin(dir, who) {
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: who.email, organizationName: 'Acme', accountUuid: who.uuid } }))
  credstore.write(dir, { claudeAiOauth: { accessToken: 'AT-' + who.rt, refreshToken: who.rt,
    expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: Date.now() + who.days * DAY } })
}
ext._test.setSigninStart((o) => {
  let finish
  const done = new Promise((r) => { finish = r })
  const h = { o, codes: [], cancelled: false, done, url: Promise.resolve('https://example.invalid/x'),
    sendCode(c) { h.codes.push(c) },
    cancel() { h.cancelled = true; finish({ ok: false, reason: 'cancelled' }) } }
  h.as = (who) => { writeSignin(o.configDir, who); finish({ ok: true, email: who.email, accountUuid: who.uuid }) }
  h.fail = (reason) => finish({ ok: false, reason })
  signins.push(h)
  const next = signinQ.shift()
  if (next && next.fail) setTimeout(() => h.fail(next.fail), 5)
  else if (next && !next.hold) setTimeout(() => h.as(next), 5)
  return h
})

function givePinning(name, email, uuid, rt, days) {
  const dir = loginsLib.dirFor(TEST_ROOT, name)
  fs.mkdirSync(dir, { recursive: true })
  const expiresAt = Date.now() + days * DAY
  credstore.write(dir, { claudeAiOauth: { accessToken: 'AT-' + rt, refreshToken: rt, expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: expiresAt } })
  fs.writeFileSync(loginsLib.metaFile(TEST_ROOT, name), JSON.stringify({ v: 1, expiresAt, email, accountUuid: uuid }))
  return expiresAt
}
const daysOf = (t) => Math.round((t - Date.now()) / DAY * 10) / 10

let nextFetch = { ok: false, reason: 'mocked offline' }
let fetchCount = 0
liveLib.fetchUsage = async () => {
  fetchCount++
  return nextFetch.raw ? liveLib.interpret(nextFetch.raw) : nextFetch
}
const trackerCalls = []
trackerLib._test.transport.refresh = async (rt) => {
  trackerCalls.push('refresh:' + rt)
  return { status: 200, body: JSON.stringify({ access_token: 'AT-' + rt + '-new', refresh_token: rt + '-new', expires_in: 28800 }) }
}
trackerLib._test.transport.fetchUsage = async (token) => {
  trackerCalls.push('usage:' + token)
  return { ok: true, utilization: { limits: [
    { kind: 'session', percent: 12, resets_at: new Date(Date.now() + 3600e3).toISOString() },
    { kind: 'weekly_all', percent: 34, resets_at: new Date(Date.now() + 86400e3).toISOString() },
  ] } }
}

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  <- ' + extra : '')) }
}
const tick = () => new Promise((r) => setTimeout(r, 30))
const nextKeychainSecond = () => { require('../lib/fsx').sleepSync(process.platform === 'darwin' ? 1005 - (Date.now() % 1000) : 20) }
const cmdOf = (t) => (t && t.opts && Array.isArray(t.opts.shellArgs) ? t.opts.shellArgs.join(' ') : '')
const iso = (ms) => new Date(Date.now() + ms).toISOString()

const CLAUDE_DIR = path.join(FAKE_HOME, '.claude')
const credstore = require('../lib/credstore.js')
const readLive = () => credstore.read(null)
const LIVE_CFG = path.join(FAKE_HOME, '.claude.json')
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

function signInLive(email, uuid, rt, expiresInMs) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true })
  credstore.write(null, {
    claudeAiOauth: { accessToken: 'AT-' + rt, refreshToken: rt, expiresAt: Date.now() + expiresInMs },
  })
  const prev = fs.existsSync(LIVE_CFG) ? readJson(LIVE_CFG) : {}
  fs.writeFileSync(LIVE_CFG, JSON.stringify({ ...prev,
    oauthAccount: { emailAddress: email, organizationName: 'Acme', accountUuid: uuid } }))
}

function finishStagedLogin(name, email, uuid, rt) {
  const dir = path.join(TEST_ROOT, 'accounts', name)
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: email, organizationName: 'Acme', accountUuid: uuid } }))
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'AT-' + rt, refreshToken: rt, expiresAt: Date.now() + 3600e3 } }))
  return dir
}

async function main() {
  console.log('test root:', TEST_ROOT)

  console.log('\n-- activate: older per-window / machine-wide setups are migrated --')
  store.ensureRoot(TEST_ROOT)
  store.setMode(TEST_ROOT, 'window')
  settings.claudeCode.environmentVariables = [
    { name: 'CLAUDE_CONFIG_DIR', value: 'C:\\old\\per-window' }, { name: 'KEEP_ME', value: 'yes' }]
  signInLive('work@example.com', 'uuid-w', 'RT-WORK', 30 * 60e3)
  const mainState = new Map()
  const ctx = { subscriptions: [], globalState: { get: (k) => mainState.get(k), update: async (k, v) => { mainState.set(k, v) } },
    extensionPath: path.join(__dirname, '..'), globalStorageUri: { fsPath: path.join(TEST_ROOT, 'SomeEditor', 'User', 'globalStorage', 'publisher.switcher') } }
  q.warn.push('Clear It')
  ext._test.setTrackerAuto(false)
  ext._test.setLoginAuto(false)
  ext.activate(ctx)
  await tick()
  check('root directory created', fs.existsSync(TEST_ROOT))
  {
    const ed = require('../lib/editors.js').read(TEST_ROOT)
    check('activation records this editor\'s User folder and the switcher\'s folder, for the uninstall script',
      ed.length === 1 && ed[0].user === path.join(TEST_ROOT, 'SomeEditor', 'User') && ed[0].ext === path.join(__dirname, '..'), JSON.stringify(ed))
  }
  check('a machine-wide CLAUDE_CONFIG_DIR is only cleared after asking (M7)',
    messages.some((m) => m.startsWith('WARN: Claude Code is set to use CLAUDE_CONFIG_DIR=')))
  const manifestIds = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
    .contributes.commands.map((c) => c.command.replace('claudeswitcher.', ''))
  check('the experimental build registers every command in the manifest',
    Object.keys(registered).map((i) => i.replace('claudeswitcher.', '')).sort().join(',') ===
      manifestIds.slice().sort().join(','), Object.keys(registered).join(','))
  check('none of the removed commands exist',
    ['switchAccount', 'newChatAs', 'newTerminalAs', 'usePerWindowAccounts', 'useMachineWideAccount',
      'backup', 'restore', 'renameAccount', 'setAccountIcon', 'globalImport', 'removeAccount']
      .every((c) => !registered['claudeswitcher.' + c]))
  check('an old per-window mode is put back on the global switcher', store.getMode(TEST_ROOT) === 'login')
  check('a machine-wide CLAUDE_CONFIG_DIR is cleared (it would override pins)',
    !settings.claudeCode.environmentVariables.some((e) => e.name === 'CLAUDE_CONFIG_DIR'))
  check('other Claude Code variables are kept', settings.claudeCode.environmentVariables.some((e) => e.name === 'KEEP_ME'))
  check('the sidebar view is registered', viewProvider && viewProvider.id === 'claudeswitcher.accountsView')

  console.log('\n-- status bar before the live login is saved --')
  check('names the live login', (bars[0].text || '').includes('work@example.com'), bars[0].text)
  check('warns it is not saved', !!bars[0].bg && /warning/i.test(bars[0].bg.id))
  check('clicking it opens the switcher', bars[0].command === 'claudeswitcher.globalSwitch')
  check('its hover says the switch is for every unpinned window, with no page link',
    /every window that isn't pinned/.test(String(bars[0].tooltip)) && !String(bars[0].tooltip).includes('command:'))
  check('five items: account, usage, main days, pinning days and, in experimental, context', bars.length === 5, bars.length)
  check('a new install gets the first-run checklist', ext._test.pageState().checklist === true)

  console.log('\n-- Add Account: save the login you are signed in to --')
  q.quick.push('Save the account'); q.input.push('work'); q.info.push(undefined)
  await registered['claudeswitcher.globalAdd']()
  check('saved as a profile', profiles.exists(TEST_ROOT, 'work'))
  check('it is now the live account', profiles.activeProfile(TEST_ROOT) === 'work')
  check('status bar shows it, no warning', (bars[0].text || '').includes('work') && !bars[0].bg, bars[0].text)
  usageLib.writeLiveCache(TEST_ROOT, null, { limits: [] }, Date.now() + 29.5 * 86400000)
  ext._test.refreshAll()
  check('the account item is just its name: the days have their own item', /work$/.test(bars[0].text || ''), bars[0].text)
  check('the days item reads 29d', bars[2].text === '29d' && bars[2].shown && !bars[2].color, bars[2].text)
  check('its hover: Main login: 29 days left.', String(bars[2].tooltip) === 'Main login: 29 days left.', bars[2].tooltip)
  check('no pinning login, no pin days', !bars[3].shown)
  check('the account hover still has the date', /Login: sign in again by .+ \(29 days left\)\./.test(String(bars[0].tooltip)))
  usageLib.writeLiveCache(TEST_ROOT, null, { limits: [] }, Date.now() + 3.5 * 86400000)
  ext._test.refreshAll()
  check('under 5 days the days are amber', bars[2].text === '3d' && bars[2].color && /warning/i.test(bars[2].color.id), bars[2].text)
  usageLib.writeLiveCache(TEST_ROOT, null, { limits: [] }, Date.now() - 60e3)
  ext._test.refreshAll()
  check('an ended login says so, in red', bars[2].text === 'ended' && bars[2].color && /error/i.test(bars[2].color.id) &&
    /Login expired on/.test(String(bars[0].tooltip)), bars[2].text)
  fs.rmSync(usageLib.cachePathForKey(TEST_ROOT, usageLib.accountKey(null)), { force: true })
  ext._test.refreshAll()

  console.log('\n-- Add Account: sign a new account in, in the page --')
  signinQ.push({ email: 'dana@example.com', uuid: 'uuid-d', rt: 'RT-D', days: 20.5 })
  q.quick.push('Sign in to another account'); q.input.push('dana')
  q.warn.push({ value: 'No thank you', checked: true })
  await registered['claudeswitcher.globalAdd']()
  let si = signins[signins.length - 1]
  check('the sign-in ran in a throwaway folder inside the switcher',
    si && path.dirname(si.o.configDir) === path.join(TEST_ROOT, 'accounts') && path.basename(si.o.configDir).startsWith('.signin-'), si && si.o.configDir)
  check('with Claude Code\'s .exe', si && si.o.bin === 'C:\\fake\\claude.exe')
  check('a new account has no email to fill in', si && !si.o.email)
  check('the live login is untouched while signing in', readLive().claudeAiOauth.refreshToken === 'RT-WORK')
  check('completed login added under the name typed', profiles.exists(TEST_ROOT, 'dana'))
  check('the throwaway folder is gone', !fs.existsSync(si.o.configDir))
  check('the pop-up says it was added, and offers a second login',
    messages.some((m) => m.startsWith('WARN: Your account has been successfully added')))
  check('the sign-in pop-up is closed', !ext._test.openAsks().some((a) => a.spec.kind === 'signin'))
  check('Don\'t ask again turns the offer off', ext._test.pageState().prefs.askSecondLogin === false)
  check('its login end date is known', Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'dana').loginExpiresAt) - 20.5) < 0.1)

  console.log('\n-- the sign-in pop-up: link, Copy, code, Cancel --')
  signinQ.push({ hold: true })
  q.quick.push('Sign in to another account'); q.input.push('')
  const held = registered['claudeswitcher.globalAdd']()
  await tick(); await tick()
  si = signins[signins.length - 1]
  let ask = ext._test.openAsks().find((a) => a.spec.kind === 'signin')
  check('a signin pop-up is open, with the link', ask && ask.spec.url === 'https://example.invalid/x' && ask.spec.stage === 'waiting', ask && JSON.stringify(ask.spec))
  await ext._test.onPageMessage({ type: 'copy', text: ask.spec.url })
  check('Copy puts the link on the clipboard', clipboard.text === 'https://example.invalid/x')
  await ext._test.onPageMessage({ type: 'signinCode', id: ask.id, code: '  pasted-code  ' })
  check('a pasted code goes to the sign-in, trimmed', si.codes.length === 1 && si.codes[0] === 'pasted-code')
  ask = ext._test.openAsks().find((a) => a.spec.kind === 'signin')
  check('and the pop-up shows it is checking', ask && ask.spec.stage === 'checking')
  si.fail('exited')
  await tick(); await tick()
  ask = ext._test.openAsks().find((a) => a.spec.kind === 'signin')
  check('a wrong code starts again, with a message', signins[signins.length - 1] !== si && ask && /didn't work/.test(ask.spec.error || ''))
  si = signins[signins.length - 1]
  await ext._test.onPageMessage({ type: 'answer', id: ask.id, cancel: true })
  await held
  check('Cancel stops the sign-in', si.cancelled)
  check('and leaves no throwaway folder', !fs.existsSync(si.o.configDir))
  check('no account was added', profiles.list(TEST_ROOT).length === 2)
  signinQ.push({ fail: 'timed out' })
  q.quick.push('Sign in to another account'); q.input.push('')
  await registered['claudeswitcher.globalAdd']()
  check('a sign-in that times out says so', messages.some((m) => /took too long/.test(m)))

  console.log('\n-- signing in to an account you already have renews it --')
  signinQ.push({ email: 'dana@example.com', uuid: 'uuid-d', rt: 'RT-D2', days: 30.5 })
  q.quick.push('Sign in to another account'); q.input.push('second-dev')
  await registered['claudeswitcher.globalAdd']()
  check('not saved twice under a new name', !profiles.exists(TEST_ROOT, 'second-dev') && profiles.list(TEST_ROOT).length === 2)
  check('the new login is dana\'s main one', Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'dana').loginExpiresAt) - 30.5) < 0.1)
  let pin = loginsLib.readMeta(TEST_ROOT, 'dana')
  check('the previous one is kept for pinning', pin && Math.abs(daysOf(pin.expiresAt) - 20.5) < 0.1, JSON.stringify(pin))
  check('"Account added for pinning!", with the real days',
    messages.some((m) => m.startsWith('WARN: Account added for pinning! | ') && /from 20 days to ~30 days/.test(m)))
  check('the wrapper list knows the pinning login', !!loginsLib.wrapperLogin(TEST_ROOT, 'dana'))

  console.log('\n-- Add account for pinning --')
  signinQ.push({ email: 'dana@example.com', uuid: 'uuid-d', rt: 'RT-D3', days: 40.5 })
  q.warn.push({ value: 'Done', checked: true })
  await ext._test.onPageMessage({ type: 'addPinning', name: 'dana' })
  await tick()
  si = signins[signins.length - 1]
  check('no name pop-up; the sign-in has dana\'s email filled in', si.o.email === 'dana@example.com')
  check('congratulations', messages.some((m) => m.startsWith('WARN: Account added for pinning! | Congratulations! dana can now pin')))
  check('ticked: the new login becomes main', Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'dana').loginExpiresAt) - 40.5) < 0.1)
  pin = loginsLib.readMeta(TEST_ROOT, 'dana')
  check('and the old main keeps pinning going', pin && Math.abs(daysOf(pin.expiresAt) - 30.5) < 0.1, JSON.stringify(pin))
  signinQ.push({ email: 'dana@example.com', uuid: 'uuid-d', rt: 'RT-D4', days: 50.5 })
  q.warn.push({ value: 'Done', checked: false })
  await ext._test.onPageMessage({ type: 'addPinning', name: 'dana' })
  await tick()
  check('unticked: main stays', Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'dana').loginExpiresAt) - 40.5) < 0.1)
  pin = loginsLib.readMeta(TEST_ROOT, 'dana')
  check('and the new login is for pinning', pin && Math.abs(daysOf(pin.expiresAt) - 50.5) < 0.1, JSON.stringify(pin))
  signinQ.push({ email: 'dana@example.com', uuid: 'uuid-d', rt: 'RT-D5', days: 60.5 })
  q.warn.push({ value: null, closed: true, checked: false })
  await ext._test.onPageMessage({ type: 'addPinning', name: 'dana' })
  await tick()
  check('unticked and closed with ✕: main stays', Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'dana').loginExpiresAt) - 40.5) < 0.1)
  pin = loginsLib.readMeta(TEST_ROOT, 'dana')
  check('and the new login is for pinning', pin && Math.abs(daysOf(pin.expiresAt) - 60.5) < 0.1, JSON.stringify(pin))
  signinQ.push({ email: 'finn@example.com', uuid: 'uuid-f', rt: 'RT-F', days: 30.5 })
  q.warn.push({ value: 'Done', text: 'Finn' })
  await ext._test.onPageMessage({ type: 'addPinning', name: 'dana' })
  check('a different account becomes a card of its own', profiles.exists(TEST_ROOT, 'finn') &&
    ext._test.pageState().accounts.some((a) => a.name === 'finn' && a.label === 'Finn'))
  check('dana\'s pinning login is unchanged', Math.abs(daysOf(loginsLib.readMeta(TEST_ROOT, 'dana').expiresAt) - 60.5) < 0.1)
  check('finn got no pinning login', !loginsLib.readMeta(TEST_ROOT, 'finn'))
  check('the pop-up says what happened', messages.some((m) => m.startsWith('WARN: A second account was added | You signed in as finn@example.com')))
  await ext._test.onPageMessage({ type: 'setting', key: 'askSecondLogin', value: true })
  check('the offer can be turned on again from the settings', ext._test.pageState().prefs.askSecondLogin === true)
  q.warn.push('Forget')
  await ext._test.onPageMessage({ type: 'forget', name: 'finn' })
  check('Forget removes an account', !profiles.exists(TEST_ROOT, 'finn'))

  console.log('\n-- a login interrupted by a reload is rescued on startup --')
  store.addAccount(TEST_ROOT, 'late')
  finishStagedLogin('late', 'late@example.com', null, 'RT-L')
  const rescued = ext._test.syncStagedLogins()
  check('startup sync adds it', rescued.includes('late') && profiles.exists(TEST_ROOT, 'late'), JSON.stringify(rescued))
  check('running it again changes nothing', ext._test.syncStagedLogins().length === 0)
  store.addAccount(TEST_ROOT, 'halfway')
  fs.writeFileSync(path.join(TEST_ROOT, 'accounts', 'halfway', '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: 'RT-H' } }))
  ext._test.syncStagedLogins()
  check('a half-written login waits for its identity', !profiles.exists(TEST_ROOT, 'halfway'))

  console.log('\n-- switching keeps every chat where it was --')
  fs.mkdirSync(path.join(CLAUDE_DIR, 'projects', 'C--repo'), { recursive: true })
  fs.writeFileSync(path.join(CLAUDE_DIR, 'projects', 'C--repo', 'chat.jsonl'), 'precious\n')
  q.info.push('Not Now')
  await ext._test.onPageMessage({ type: 'switch', name: 'dana' })
  check('the live login is now dana', readLive().claudeAiOauth.refreshToken === 'RT-D3')
  check('identity swapped', readJson(LIVE_CFG).oauthAccount.emailAddress === 'dana@example.com')
  check('the chat is exactly where it was', fs.readFileSync(path.join(CLAUDE_DIR, 'projects', 'C--repo', 'chat.jsonl'), 'utf8') === 'precious\n')
  check('the account switched away from was re-saved first',
    profiles.readPayload(TEST_ROOT, 'work').credentials.claudeAiOauth.refreshToken === 'RT-WORK')
  await registered['claudeswitcher.globalSwitch']()
  check('clicking the account in the status bar opens the Accounts page (no list at the top)', panels.length === 1)
  await registered['claudeswitcher.globalSwitch']()
  check('and clicking it again brings the same page to the front', panels.length === 1 && panels[0].revealed >= 1)
  panels[0].dispose()

  console.log('\n-- usage meter --')
  const cfg = readJson(LIVE_CFG)
  cfg.cachedUsageUtilization = {
    fetchedAtMs: Date.now() - 120000,
    utilization: {
      limits: [
        { kind: 'session', percent: 36, resets_at: iso(3600e3) },
        { kind: 'weekly_all', percent: 57, resets_at: iso(2 * 86400e3) },
        { kind: 'weekly_scoped', percent: 53, resets_at: iso(2 * 86400e3), scope: { model: { display_name: 'Fable' } } },
      ],
      extra_usage: { is_enabled: true, used_credits: 3670, monthly_limit: 12500, utilization: 29.36, decimal_places: 2 },
    },
  }
  fs.writeFileSync(LIVE_CFG, JSON.stringify(cfg))
  ext._test.refreshAll()
  check('reads session · F fable · W weekly', bars[1].text === '$(pulse) 36% · F 53% · W 57%', bars[1].text)
  check('tooltip names the scoped model', String(bars[1].tooltip).includes('| Fable |'))
  check('tooltip includes extra usage in dollars', String(bars[1].tooltip).includes('$36.70 of $125.00'))
  check('no warning colour below 80%', !bars[1].bg)
  cfg.cachedUsageUtilization.utilization.limits[0].percent = 97
  fs.writeFileSync(LIVE_CFG, JSON.stringify(cfg))
  q.warn.push(undefined)
  await registered['claudeswitcher.refreshUsage']()
  check('turns red at 97%', !!bars[1].bg && /error/i.test(bars[1].bg.id))

  console.log('\n-- live usage refresh --')
  nextFetch = { ok: true, utilization: { limits: [
    { kind: 'session', percent: 11, resets_at: iso(3600e3) },
    { kind: 'weekly_all', percent: 22, resets_at: iso(86400e3) },
    { kind: 'weekly_scoped', percent: 33, resets_at: iso(86400e3), scope: { model: { display_name: 'Fable' } } },
  ] } }
  await registered['claudeswitcher.refreshUsage']()
  check('bar shows the LIVE numbers', bars[1].text === '$(pulse) 11% · F 33% · W 22%', bars[1].text)
  check('cached under our own dir, not in .claude.json', fs.existsSync(usageLib.cachePath(TEST_ROOT, null)) &&
    readJson(LIVE_CFG).cachedUsageUtilization.utilization.limits[0].percent === 97)
  nextFetch = { ok: false, reason: 'mocked 401' }
  q.warn.push(undefined)
  await registered['claudeswitcher.refreshUsage']()
  check('a failed refresh keeps the figures', bars[1].text === '$(pulse) 11% · F 33% · W 22%', bars[1].text)
  nextFetch = { raw: { status: 200, body: '{}', headers: {} } }
  q.warn.push(undefined)
  await registered['claudeswitcher.refreshUsage']()
  check('a 200 with no usage in it keeps them too', bars[1].text === '$(pulse) 11% · F 33% · W 22%')
  nextFetch = { raw: { status: 429, body: '', headers: { 'retry-after': '120' } } }
  q.warn.push(undefined)
  const sent = fetchCount
  await registered['claudeswitcher.refreshUsage']()
  check('a 429 is reported with the wait', messages.some((m) => m.includes('rate-limiting') && m.includes('2 min')))
  q.info.push(undefined)
  await registered['claudeswitcher.refreshUsage']()
  check('and clicking again during the pause sends nothing', fetchCount === sent + 1, String(fetchCount - sent))
  nextFetch = { ok: false, reason: 'mocked offline' }

  console.log('\n-- all-accounts tracker, in the usage meter\'s hover --')
  await ext._test.trackerTick()
  const acctBar = bars[1]
  check('the meter still shows this window\'s account', /^\$\(pulse\) \d+% · F \d+% · W \d+%$/.test(acctBar.text || ''), acctBar.text)
  check('a saved login that is due was renewed in the background', trackerCalls.includes('refresh:RT-WORK'), trackerCalls.join(','))
  check('and its usage read with the renewed token', trackerCalls.includes('usage:AT-RT-WORK-new'), trackerCalls.join(','))
  check('the live account was never renewed', !trackerCalls.some((c) => c.startsWith('refresh:RT-D')))
  const rawTip = String(acctBar.tooltip || '')
  const GAP = '  ​'
  check('a gap of about 10px after the 5-hour and Weekly columns, kept from Markdown\'s trimming',
    rawTip.includes('| 5-hour' + GAP + ' | Weekly' + GAP + ' | Fable |') &&
    rawTip.split('\n').slice(2).every((row) => row.split(' | ').slice(2, 4).every((c) => c.endsWith(GAP))))
  const tip = rawTip.split(GAP).join('')
  check('the hover lists every saved account', ['work', 'dana', 'late'].every((n) => tip.includes(n)), tip)
  check('with exactly: 5-hour, weekly and Fable', tip.includes('| | Account | 5-hour | Weekly | Fable |'))
  check('5-hour and weekly show the time left in brackets', /\| 12% \((1h|59m|60m)\) \| 34% \((1d|23h 5\dm)\) \|/.test(tip), tip)
  check('Fable is just a percentage', /\*\*dana\*\* \| 11% \(\d+[hm]\) \| 22% \(\d+[dh]\) \| 33% \|/.test(tip), tip)
  check('the account this window uses is ticked', /\| \$\(check\) \| \*\*dana\*\*/.test(tip), tip)
  check('names are switch links that say the switch is for every unpinned window',
    tip.includes('command:claudeswitcher.switchTo?') &&
    tip.includes('Click to update every account.  \nClick a name to switch to that account globally.  \n_(pinned folders are unaffected)_'))
  check('no page link and no legend', !tip.includes('openAccounts') && !/most room|=/.test(tip.replace(/\(command:[^)]*\)/g, '')))
  check('no em dashes', !/\u2014/.test(tip))
  check('clicking the meter updates every account', acctBar.command === 'claudeswitcher.refreshAllAccounts')
  const startLink = (n) => 'command:claudeswitcher.startSession?' + encodeURIComponent(JSON.stringify([n]))
  check('a ▶ to start a 5-hour session sits next to an account with no session running', rawTip.includes(startLink('late')), rawTip)
  check('but not next to the live account, nor one whose session is already running',
    !rawTip.includes(startLink('dana')) && !rawTip.includes(startLink('work')))
  check('and the hover allows that command', bars[1].trusted && bars[1].trusted.enabledCommands.includes('claudeswitcher.startSession'))
  const renewsBefore = trackerCalls.filter((c) => c.startsWith('refresh:')).length
  const before = trackerCalls.length
  await registered['claudeswitcher.refreshAllAccounts']()
  check('an update re-reads accounts whose figures were fresh', trackerCalls.slice(before).some((c) => c.startsWith('usage:')))
  check('but never renews a login that is not due', trackerCalls.filter((c) => c.startsWith('refresh:')).length === renewsBefore)
  await registered['claudeswitcher.switchTo']('no-such-account')
  await registered['claudeswitcher.switchTo']({ not: 'a name' })
  check('links to unknown or malformed names do nothing', readLive().claudeAiOauth.refreshToken === 'RT-D3')
  settings.claudeswitcher.trackAllAccounts = false
  ext._test.refreshAll()
  const offTip = String(acctBar.tooltip || '')
  check('with tracking off, the hover shows just this window\'s account', offTip.includes('dana') && !offTip.includes('work'), offTip)
  settings.claudeswitcher.trackAllAccounts = true
  ext._test.refreshAll()

  console.log('\n-- the Accounts page: a tab --')
  await registered['claudeswitcher.openAccounts']()
  const panel = panels[panels.length - 1]
  const html = panel.webview.html
  check('opens as an editor tab', panels.length === 2 && panel.title === 'Claude Accounts')
  check('scripts are enabled only for the extension\'s own files',
    panel.options.enableScripts === true && panel.options.localResourceRoots.every((r) => r.fsPath.startsWith(path.resolve(__dirname, '..')) || r.fsPath.includes('out')))
  check('its security policy allows nothing from the network', /default-src 'none'/.test(html) && !/https?:\/\//.test(html))
  check('scripts run only with this page\'s nonce', /script-src 'nonce-[A-Za-z0-9]+'/.test(html) &&
    (html.match(/<script nonce=/g) || []).length === 2)
  check('the page is the tab layout', html.includes('layout-tab'))
  check('the tab has an icon for light themes and one for dark', panel.iconPath && panel.iconPath.light && panel.iconPath.dark &&
    fs.existsSync(panel.iconPath.light.fsPath) && fs.existsSync(panel.iconPath.dark.fsPath) &&
    panel.iconPath.light.fsPath !== panel.iconPath.dark.fsPath)
  check('no codicon font when VS Code has none to offer', !html.includes('@font-face'))
  await panel.webview.handler({ type: 'ready' })
  let st = panel.webview.posted[panel.webview.posted.length - 1]
  check('ready -> the page gets its state', st && st.type === 'state' && Array.isArray(st.state.accounts))
  const names = st.state.accounts.map((a) => a.name).sort().join(',')
  check('one card per saved account', names === 'dana,late,work', names)
  check('the live account is marked', st.state.accounts.find((a) => a.name === 'dana').active === true)
  check('a saved account carries its 5h and weekly figures', st.state.accounts.find((a) => a.name === 'work').session.percent === 12)
  check('the state never carries a token', !/RT-|AT-|accessToken|refreshToken/.test(JSON.stringify(st.state)))

  console.log('\n-- the Accounts page: every action is checked first --')
  const postedBefore = panel.webview.posted.length
  await ext._test.onPageMessage({ type: 'edit', name: 'work', label: 'Work / Acme', icon: 'briefcase' })
  check('edit renames', store.displayOf(TEST_ROOT, 'work').label === 'Work / Acme')
  check('and sets the icon', store.displayOf(TEST_ROOT, 'work').icon === 'briefcase')
  check('and the page gets the new state', panel.webview.posted.length > postedBefore &&
    panel.webview.posted[panel.webview.posted.length - 1].state.accounts.find((a) => a.name === 'work').label === 'Work / Acme')
  check('no colour chosen: the page picks one from the name', ext._test.pageState().accounts.find((a) => a.name === 'work').color === null)
  const order = () => ext._test.pageState().accounts.map((a) => a.label).join(',')
  check('cards are in the order of the names shown', order() === 'dana,late,Work / Acme', order())
  await ext._test.onPageMessage({ type: 'edit', name: 'work', label: 'alpha', icon: 'briefcase' })
  check('and a rename moves the card to its new place, ignoring case', order() === 'alpha,dana,late', order())
  await ext._test.onPageMessage({ type: 'edit', name: 'work', label: 'Work / Acme', icon: 'briefcase' })
  await ext._test.onPageMessage({ type: 'edit', name: 'work', label: 'Work / Acme', icon: 'briefcase', color: 'teal' })
  check('a colour can be chosen', store.displayOf(TEST_ROOT, 'work').color === 'teal' &&
    ext._test.pageState().accounts.find((a) => a.name === 'work').color === 'teal')
  check('and the name and icon are kept', store.displayOf(TEST_ROOT, 'work').label === 'Work / Acme' &&
    store.displayOf(TEST_ROOT, 'work').icon === 'briefcase')
  await ext._test.onPageMessage({ type: 'edit', name: 'work', label: 'Work / Acme', icon: 'briefcase', color: 'neon' })
  check('a colour that is not on the list is ignored', store.displayOf(TEST_ROOT, 'work').color === 'teal')
  await ext._test.onPageMessage({ type: 'edit', name: 'work', label: 'Work / Acme', color: { teal: 1 } })
  check('so is one that is not even text', store.displayOf(TEST_ROOT, 'work').color === 'teal')
  await ext._test.onPageMessage({ type: 'edit', name: 'work', label: 'Work / Acme', icon: 'briefcase', color: 'auto' })
  check('"Automatic" goes back to the colour from the name', store.displayOf(TEST_ROOT, 'work').color === null &&
    !/"color"/.test(fs.readFileSync(path.join(TEST_ROOT, 'registry.json'), 'utf8')))
  q.warn.push(undefined)
  await ext._test.onPageMessage({ type: 'edit', name: 'work', label: '   ', icon: 'not valid!' })
  check('a blank name and a bad icon are refused', store.displayOf(TEST_ROOT, 'work').label === 'Work / Acme' &&
    store.displayOf(TEST_ROOT, 'work').icon === 'briefcase')
  await ext._test.onPageMessage({ type: 'edit', name: '../../evil', label: 'x' })
  await ext._test.onPageMessage({ type: 'edit', name: { evil: true }, label: 'x' })
  await ext._test.onPageMessage({ type: 'deleteEverything', name: 'work' })
  await ext._test.onPageMessage(null)
  check('unknown accounts, non-string names and unknown actions are ignored', profiles.exists(TEST_ROOT, 'work') &&
    store.displayOf(TEST_ROOT, 'work').label === 'Work / Acme')
  q.info.push(undefined)
  await ext._test.onPageMessage({ type: 'remote', name: 'dana', on: false })
  check('Remote Control off for the live account reaches Claude Code at once',
    readJson(path.join(CLAUDE_DIR, 'settings.json')).disableRemoteControl === true)
  q.info.push(undefined)
  await ext._test.onPageMessage({ type: 'remote', name: 'dana', on: true })
  check('and back on', !('disableRemoteControl' in readJson(path.join(CLAUDE_DIR, 'settings.json'))))

  console.log('\n-- the Accounts page: Artifacts per account --')
  const SETTINGS = path.join(CLAUDE_DIR, 'settings.json')
  fs.writeFileSync(SETTINGS, JSON.stringify({ ...readJson(SETTINGS), theme: 'kept' }, null, 2))
  check('the experimental page shows the Artifacts switch', ext._test.pageState().features.artifacts === true)
  check('until an account is set to off, Claude Code\'s own choice is left alone',
    !store.artifactsManaged(TEST_ROOT) && !('enableArtifact' in readJson(SETTINGS)))
  await ext._test.onPageMessage({ type: 'artifacts', name: 'dana', on: false })
  check('off for the live account writes enableArtifact: false', readJson(SETTINGS).enableArtifact === false)
  check('and keeps every other setting', readJson(SETTINGS).theme === 'kept')
  check('and denies the tools that publish to claude.ai', require('../lib/artifacts').DENY.every((e) => readJson(SETTINGS).permissions.deny.includes(e)))
  check('the page shows it off', ext._test.pageState().accounts.find((a) => a.name === 'dana').artifactsOff === true)
  check('Show Status lists it', (await ext._test.onPageMessage({ type: 'status' }), messages.some((m) => /dana.*artifacts:off/.test(m))))
  q.info.push('Not Now')
  await ext._test.onPageMessage({ type: 'switch', name: 'work' })
  check('Switch on a card switches', readLive().claudeAiOauth.refreshToken.startsWith('RT-WORK'))
  check('switching to an account with Artifacts on removes the setting', !('enableArtifact' in readJson(SETTINGS)) &&
    readJson(SETTINGS).theme === 'kept')
  check('and the deny rules it added', !('permissions' in readJson(SETTINGS)) && store.getArtifactsAdded(TEST_ROOT) === null)
  await ext._test.onPageMessage({ type: 'artifacts', name: 'work', on: false })
  check('off for the new live account', readJson(SETTINGS).enableArtifact === false)
  await ext._test.onPageMessage({ type: 'artifacts', name: 'work', on: true })
  check('and on again', !('enableArtifact' in readJson(SETTINGS)))
  const goodSettings = fs.readFileSync(SETTINGS, 'utf8')
  fs.writeFileSync(SETTINGS, '{ "hooks": { oops ')
  await ext._test.onPageMessage({ type: 'artifacts', name: 'work', on: false })
  check('a settings.json that is not valid JSON is never overwritten', fs.readFileSync(SETTINGS, 'utf8') === '{ "hooks": { oops ')
  check('and the user is told why', messages.some((m) => m.startsWith('WARN: Artifacts:') && m.includes('not valid JSON')))
  fs.writeFileSync(SETTINGS, goodSettings)
  store.setArtifacts(TEST_ROOT, 'work', 'on')

  console.log('\n-- a login for another PC --')
  const waitFor = async (fn, ms) => {
    const end = Date.now() + (ms || 3000)
    for (;;) {
      const v = fn()
      if (v) return v
      if (Date.now() > end) return null
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  const SPARES = path.join(TEST_ROOT, 'spares')
  const spareDirNow = () => { try { const d = fs.readdirSync(SPARES); return d.length ? path.join(SPARES, d[0]) : null } catch { return null } }
  const signSpare = (dir, email, rt) => {
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, organizationName: 'Acme', accountUuid: 'uuid-d' } }))
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'AT-' + rt, refreshToken: rt, expiresAt: Date.now() + 3600e3 } }))
  }
  check('the experimental menu offers it', ext._test.pageState().features.spareLogin === true)
  const SPARE_OUT = path.join(TEST_ROOT, 'dana-login.move')
  const PASS = 'long enough pass'
  const danaBefore = JSON.stringify(profiles.readPayload(TEST_ROOT, 'dana'))
  const liveBefore = JSON.stringify(readLive())
  const savedBefore = profiles.list(TEST_ROOT).map((p) => p.name).join(',')

  q.info.push(undefined)
  await ext._test.onPageMessage({ type: 'spareLogin', name: 'dana' })
  check('it asks first, and a "no" does nothing', !fs.existsSync(SPARE_OUT) && !spareDirNow())
  q.info.push('Continue'); q.input.push(PASS, 'not the same pass')
  await ext._test.onPageMessage({ type: 'spareLogin', name: 'dana' })
  check('mismatched passphrases stop it before any sign-in', !fs.existsSync(SPARE_OUT) && !spareDirNow() &&
    messages.some((m) => m.includes("didn't match")))

  authMock = { ok: true, loggedIn: true, email: 'dana@example.com', orgName: 'Acme' }
  q.info.push('Continue'); q.input.push(PASS, PASS); q.save.push({ fsPath: SPARE_OUT }); q.info.push(undefined)
  const termsBefore = terminals.length
  const spare = ext._test.onPageMessage({ type: 'spareLogin', name: 'dana' })
  const spareDir = await waitFor(spareDirNow)
  const spareTerm = terminals[termsBefore]
  check('it signs in in a folder of its own, outside the accounts folder', !!spareDir && spareTerm &&
    spareTerm.opts.env.CLAUDE_CONFIG_DIR === spareDir && !spareDir.startsWith(path.join(TEST_ROOT, 'accounts')))
  check('with the account\'s email filled in', spareTerm && cmdOf(spareTerm).includes('--email dana@example.com'))
  signSpare(spareDir, 'dana@example.com', 'RT-SPARE')
  await spare
  const spareFile = fs.existsSync(SPARE_OUT) ? fs.readFileSync(SPARE_OUT, 'utf8') : ''
  const opened = spareFile ? moveLib.open(spareFile, PASS) : { accounts: [] }
  check('the new login is sealed into the file', opened.accounts.length === 1 && opened.accounts[0].name === 'dana' &&
    opened.accounts[0].payload.credentials.claudeAiOauth.refreshToken === 'RT-SPARE')
  check('with its identity, so the other PC knows whose it is', opened.accounts[0] &&
    opened.accounts[0].payload.identity.oauthAccount.emailAddress === 'dana@example.com')
  check('and nothing readable in the file', spareFile && !spareFile.includes('RT-SPARE') && !spareFile.includes('dana@example.com'))
  const danaNow = profiles.readPayload(TEST_ROOT, 'dana')
  check('nothing changes on this PC: the new login is not saved here, and the live login is untouched',
    danaNow.credentials.claudeAiOauth.refreshToken !== 'RT-SPARE' &&
    JSON.stringify(danaNow.identity) === JSON.stringify(JSON.parse(danaBefore).identity) &&
    JSON.stringify(readLive()) === liveBefore &&
    profiles.list(TEST_ROOT).map((p) => p.name).join(',') === savedBefore)
  check('its sign-in folder and terminal are gone', !fs.existsSync(spareDir) && spareTerm.disposed === true)
  check('the startup login rescue has nothing to pick up', ext._test.syncStagedLogins().length === 0)

  const WRONG_OUT = path.join(TEST_ROOT, 'wrong-login.move')
  authMock = { ok: true, loggedIn: true, email: 'someone@else.example', orgName: 'Other' }
  q.info.push('Continue'); q.input.push(PASS, PASS); q.save.push({ fsPath: WRONG_OUT }); q.warn.push(undefined)
  const wrong = ext._test.onPageMessage({ type: 'spareLogin', name: 'dana' })
  const wrongDir = await waitFor(spareDirNow)
  signSpare(wrongDir, 'someone@else.example', 'RT-WRONG')
  await wrong
  check('a sign-in as the wrong account saves nothing, and is destroyed', !fs.existsSync(WRONG_OUT) && !fs.existsSync(wrongDir) &&
    messages.some((m) => m.includes('not dana@example.com')))

  fs.mkdirSync(path.join(SPARES, 'dana-left'), { recursive: true })
  fs.writeFileSync(path.join(SPARES, 'dana-left', '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"RT-LEFT"}}')
  check('a sign-in a reload interrupted is wiped at the next start', ext._test.cleanupSpares() === 1 && !fs.existsSync(path.join(SPARES, 'dana-left')))
  authMock = { ok: false, error: 'mocked' }

  console.log('\n-- move an account to another PC, and import it on the page --')
  check('the experimental page offers both', ext._test.pageState().features.transfer === true)
  const moverPayload = { credentials: { claudeAiOauth: { accessToken: 'AT-MOVER', refreshToken: 'RT-MOVER', expiresAt: Date.now() + 6 * 3600e3 } },
    identity: { oauthAccount: { emailAddress: 'mover@example.com', organizationName: 'Acme', accountUuid: 'uuid-mover' } }, capturedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(profiles.profilesDir(TEST_ROOT), 'mover.enc'), require('../lib/secrets.js').protect(Buffer.from(JSON.stringify(moverPayload))))
  profiles.writeMeta(TEST_ROOT, 'mover', { email: 'mover@example.com', org: 'Acme', accountUuid: 'uuid-mover', capturedAt: moverPayload.capturedAt })
  const livePc = profiles.activeProfile(TEST_ROOT)
  if (livePc) {
    q.warn.push(undefined)
    await ext._test.onPageMessage({ type: 'moveOut', name: livePc })
    check('the account Claude Code is using can\'t be moved', profiles.exists(TEST_ROOT, livePc) && messages.some((m) => m.includes("can't leave this PC")))
  }
  const MOVE_OUT = path.join(TEST_ROOT, 'mover.move')
  q.warn.push(undefined)
  await ext._test.onPageMessage({ type: 'moveOut', name: 'mover' })
  check('it says first that the account will leave this PC, and a "no" does nothing',
    profiles.exists(TEST_ROOT, 'mover') && !fs.existsSync(MOVE_OUT) && messages.some((m) => m.includes('Move "mover" to another PC?')))
  q.warn.push('Move it'); q.input.push(PASS, PASS); q.save.push({ fsPath: MOVE_OUT }); q.info.push(undefined)
  await ext._test.onPageMessage({ type: 'moveOut', name: 'mover' })
  const moved = fs.existsSync(MOVE_OUT) ? moveLib.open(fs.readFileSync(MOVE_OUT, 'utf8'), PASS) : { accounts: [] }
  check('moved: sealed into the file, and gone from this PC', !profiles.exists(TEST_ROOT, 'mover') &&
    moved.accounts.length === 1 && moved.accounts[0].payload.credentials.claudeAiOauth.refreshToken === 'RT-MOVER')
  check('and it says how the other PC imports it', messages.some((m) => m.includes('Moved "mover" out of this PC') && m.includes('Import from a move file')))

  q.quick.push('Import from a move file'); q.open.push([{ fsPath: MOVE_OUT }])
  q.input.push('not the passphrase'); q.warn.push('Try again'); q.input.push(PASS); q.info.push(undefined)
  await ext._test.onPageMessage({ type: 'add' })
  check('Add account imports it, and a wrong passphrase can be typed again', messages.some((m) => m.includes('Wrong passphrase')) &&
    profiles.exists(TEST_ROOT, 'mover') && profiles.readPayload(TEST_ROOT, 'mover').credentials.claudeAiOauth.refreshToken === 'RT-MOVER')
  const usedMove = fs.readdirSync(TEST_ROOT).find((x) => x.startsWith('mover.move.imported-'))
  check('the file is renamed so it can\'t be used twice, and the message says to delete it',
    !!usedMove && !fs.existsSync(MOVE_OUT) && messages.some((m) => m.includes('Added mover') && m.includes('Delete ')))
  q.open.push([{ fsPath: path.join(TEST_ROOT, usedMove || 'missing') }])
  await ext._test.onPageMessage({ type: 'import' })
  check('a used file is turned away before any passphrase', messages.some((m) => m.includes('was imported once already')))
  fs.rmSync(path.join(TEST_ROOT, usedMove || 'missing'), { force: true })

  console.log('\n-- start a 5-hour session --')
  const secretsLib = require('../lib/secrets.js')
  const evePayload = { credentials: { claudeAiOauth: { accessToken: 'AT-EVE', refreshToken: 'RT-EVE', expiresAt: Date.now() + 6 * 3600e3 } },
    identity: { oauthAccount: { emailAddress: 'eve@example.com', organizationName: 'Acme', accountUuid: 'uuid-eve' } }, capturedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(profiles.profilesDir(TEST_ROOT), 'eve.enc'), secretsLib.protect(Buffer.from(JSON.stringify(evePayload))))
  profiles.writeMeta(TEST_ROOT, 'eve', { email: 'eve@example.com', org: 'Acme', accountUuid: 'uuid-eve', capturedAt: evePayload.capturedAt })
  check('the experimental page offers it', ext._test.pageState().features.startSession === true)
  const kicked = []
  ext._test.setKickoffRun(async (dir) => {
    kicked.push({ dir, rt: credstore.read(dir).claudeAiOauth.refreshToken })
    return { ok: true }
  })
  const liveCredsBefore = JSON.stringify(readLive())
  await ext._test.onPageMessage({ type: 'startSession', name: 'eve' })
  check('▶ says "hi" as that account, from its saved login', kicked.length === 1 && kicked[0].rt === 'RT-EVE')
  check('in a throwaway folder that is gone afterwards', kicked[0] && !fs.existsSync(kicked[0].dir))
  check('without touching the live login', JSON.stringify(readLive()) === liveCredsBefore)
  check('and says so', messages.some((m) => m.startsWith('INFO: Started a 5-hour session for "eve"')))
  check('the page stops showing it as starting', ext._test.pageState().accounts.find((a) => a.name === 'eve').starting === false)

  usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [
    { kind: 'session', percent: 1, resets_at: new Date(Date.now() + 2 * 3600e3).toISOString() },
    { kind: 'weekly_all', percent: 1, resets_at: new Date(Date.now() + 5 * 86400e3).toISOString() },
  ] }, Date.now())
  await ext._test.onPageMessage({ type: 'startSession', name: 'eve' })
  check('with a session already running, nothing is sent and it says when it resets',
    kicked.length === 1 && messages.some((m) => m.includes('"eve" already has a 5-hour session running. It resets in')))
  await ext._test.onPageMessage({ type: 'startSession', name: profiles.activeProfile(TEST_ROOT) })
  check('the live account is never sent a "hi" (its session starts with your next message)',
    kicked.length === 1 && messages.some((m) => m.includes('so its session starts with your next message')))
  usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [] }, Date.now())
  ext._test.setKickoffRun(async () => ({ ok: false, reason: 'mocked failure' }))
  await ext._test.onPageMessage({ type: 'startSession', name: 'eve' })
  check('a failed run says why', messages.some((m) => m === 'WARN: Couldn\'t start a session for "eve": mocked failure.'))
  ext._test.setKickoffRun(null)

  console.log('\n-- auto-continue: a chat stopped at a usage limit --')
  const autoLib = require('../lib/autocontinue.js')
  const settleNotes = () => new Promise((r) => setTimeout(r, 20))
  check('on by default, asking first', (ext._test.pageState().autoContinue || {}).mode === 'ask' &&
    ext._test.pageState().features.autoContinue === true && ext._test.pageState().features.keepAlive === true)
  const LPROJ = path.join(CLAUDE_DIR, 'projects', 'C--fake-limits')
  fs.mkdirSync(LPROJ, { recursive: true })
  const LSID = 'limit-chat-1'
  const LCHAT = path.join(LPROJ, LSID + '.jsonl')
  const SESSIONS = path.join(CLAUDE_DIR, 'sessions')
  fs.mkdirSync(SESSIONS, { recursive: true })
  const LREC = path.join(SESSIONS, '4242.json')
  const liveSession = (status) => fs.writeFileSync(LREC, JSON.stringify({ pid: 4242, sessionId: LSID, status, name: 'fake-limits-1',
    messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-0123456789abcdef0123456789abcdef', statusUpdatedAt: Date.now() }))
  const ago = (sec) => new Date(Date.now() - sec * 1000).toISOString()
  const stopRec = (uuid, resetMs) => ({ type: 'assistant', uuid, sessionId: LSID, timestamp: ago(300), isApiErrorMessage: true, error: 'rate_limit',
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'Claude AI usage limit reached|' + Math.floor((resetMs || Date.now() - 120e3) / 1000) }] } })
  const startOf = (mode) => [{ type: 'custom-title', customTitle: 'Fix the tests' },
    { type: 'user', timestamp: ago(600), permissionMode: mode || 'auto', message: { role: 'user', content: 'fix the tests' } },
    { type: 'assistant', sessionId: LSID, timestamp: ago(590), message: { model: 'claude-opus-5-5',
      usage: { input_tokens: 10, cache_read_input_tokens: 50000 }, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] } }]
  const writeChat = (recs) => {
    autoLib.updateState(TEST_ROOT, (st) => { for (const e of Object.values(st.stops)) if (e.chat === LSID) e.state = 'done' })
    fs.writeFileSync(LCHAT, recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  const addToChat = (recs) => fs.appendFileSync(LCHAT, recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const peerNotice = () => ({ type: 'user', isMeta: true, timestamp: new Date().toISOString(),
    origin: { kind: 'peer', name: autoLib.SENDER_NAME, body: autoLib.noticeFor({ kind: 'session' }, 'reset') }, message: { content: 'Another Claude session sent a message' } })
  const stateOf = (id) => (autoLib.readState(TEST_ROOT).stops[id] || {}).state
  const sentNotices = []
  ext._test.setHandoffRun(async (name, msg) => { sentNotices.push({ name, msg }); return { ok: true } })

  writeChat(startOf().concat([stopRec('stop-a')]))
  liveSession('idle')
  ext._test.refreshContext()
  q.info.push(undefined)
  await ext._test.checkLimits()
  await settleNotes()
  check('Ask me: one notification says which chat stopped, and offers to continue it',
    messages.some((m) => m.startsWith('INFO: "Fix the tests" stopped at its 5-hour limit') && m.includes('can continue it for you')))
  check('dismissed, nothing is sent and the stop is set aside', sentNotices.length === 0 && stateOf('stop-a') === 'skipped')

  store.setAutoContinue(TEST_ROOT, { mode: 'wait' })
  writeChat(startOf().concat([stopRec('stop-b')]))
  ext._test.refreshContext()
  q.info.push(undefined)
  await ext._test.checkLimits()
  check('Wait for the reset: it says when it will continue', stateOf('stop-b') === 'waiting' &&
    messages.some((m) => m.startsWith('INFO: It will continue "Fix the tests" at')))
  check('and the page lists it, with a way to cancel', (ext._test.pageState().autoContinue.waiting || []).some((w) => w.id === 'stop-b'))
  await ext._test.checkLimits()
  check('once the limit has reset, the chat is sent its notice, by name',
    sentNotices.length === 1 && sentNotices[0].name === 'fake-limits-1' && sentNotices[0].msg.startsWith(autoLib.NOTICE_MARK) &&
    /has now reset/.test(sentNotices[0].msg) && stateOf('stop-b') === 'sent')
  autoLib.mark(TEST_ROOT, 'stop-b', { sentAt: Date.now() - 60e3 })
  addToChat([peerNotice(), { type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: {} }] } }])
  q.info.push(undefined)
  await ext._test.checkLimits()
  check('when the chat goes back to work, it says so', stateOf('stop-b') === 'continued' && messages.some((m) => m === 'INFO: Continued "Fix the tests" after its usage limit.'))

  writeChat(startOf().concat([stopRec('stop-c')]))
  ext._test.refreshContext()
  q.info.push(undefined)
  await ext._test.checkLimits()
  await ext._test.checkLimits()
  autoLib.mark(TEST_ROOT, 'stop-c', { sentAt: Date.now() - 60e3 })
  addToChat([peerNotice(), { type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'That came from another session, so I will wait for you.' }] } }])
  q.warn.push('Let It Trust Switcher'); q.info.push(undefined)
  const execBefore = executed.length
  await ext._test.checkLimits()
  await settleNotes()
  check('a chat that only answers gets the fallbacks', stateOf('stop-c') === 'trust' &&
    messages.some((m) => m.startsWith('WARN: "Fix the tests" answered the notice instead of continuing.')))
  check('"Let It Trust Switcher" opens the chat with the trust prompt typed in', executed.slice(execBefore).some((x) =>
    x.id === 'claude-vscode.primaryEditor.open' && x.args[0] === LSID && x.args[1] === autoLib.TRUST_PROMPT))
  addToChat([{ type: 'user', timestamp: new Date(Date.now() + 1000).toISOString(), permissionMode: 'auto', message: { role: 'user', content: autoLib.TRUST_PROMPT } },
    { type: 'assistant', timestamp: new Date(Date.now() + 2000).toISOString(), message: { content: [{ type: 'text', text: 'Understood.' }] } }])
  await ext._test.checkLimits()
  check('once the user has sent it, the notice goes again', sentNotices.length === 3 && stateOf('stop-c') === 'sent')

  writeChat(startOf('bypassPermissions').concat([stopRec('stop-d')]))
  ext._test.refreshContext()
  q.info.push(undefined); q.info.push(undefined)
  await ext._test.checkLimits()
  await ext._test.checkLimits()
  check('a chat that skips permission prompts is never sent the notice: the user is asked instead', sentNotices.length === 3 &&
    stateOf('stop-d') === 'manual' && messages.some((m) => m.includes('skips permission prompts, so it only takes "continue" from you')))

  fs.rmSync(LREC)
  writeChat(startOf().concat([stopRec('stop-e')]))
  ext._test.refreshContext()
  await ext._test.checkLimits()
  check('a chat no longer open is left alone (it can\'t be messaged)', stateOf('stop-e') === undefined)
  liveSession('idle')
  store.setAutoContinue(TEST_ROOT, { mode: 'off' })
  await ext._test.checkLimits()
  check('and with auto-continue off, nothing happens', stateOf('stop-e') === undefined)

  await ext._test.onPageMessage({ type: 'autoContinue', mode: 'switch', pick: 'order', order: ['eve', 'nobody', '../x'] })
  const acNow = store.getAutoContinue(TEST_ROOT)
  check('the page sets the mode and the switch order, keeping only saved accounts', acNow.mode === 'switch' && acNow.pick === 'order' &&
    JSON.stringify(acNow.order) === '["eve"]', JSON.stringify(acNow))
  autoLib.updateState(TEST_ROOT, (st) => { st.stops['stop-w'] = { id: 'stop-w', title: 'Waiting', state: 'waiting', resetAt: Date.now() + 3600e3, at: Date.now() } })
  await ext._test.onPageMessage({ type: 'cancelContinue', id: 'stop-w' })
  check('and cancels a wait', stateOf('stop-w') === 'cancelled')
  const prevLive = profiles.activeProfile(TEST_ROOT)
  usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [
    { kind: 'session', percent: 5, resets_at: new Date(Date.now() + 4 * 3600e3).toISOString() },
    { kind: 'weekly_all', percent: 10, resets_at: new Date(Date.now() + 5 * 86400e3).toISOString() },
  ] }, Date.now())
  store.setAutoContinue(TEST_ROOT, { mode: 'switch', pick: 'room', order: [] })
  liveSession('idle')
  writeChat(startOf().concat([stopRec('stop-s')]))
  ext._test.refreshContext()
  const expectTo = autoLib.pickAccount(require('../lib/tracker.js').snapshot(TEST_ROOT), { exclude: prevLive, kind: 'session' })
  await ext._test.checkLimits()
  await waitFor(() => stateOf('stop-s') !== 'switching', 60000)
  check('Switch accounts: it switches to the account with the most room, then the notice says so',
    !!expectTo && profiles.activeProfile(TEST_ROOT) === expectTo && sentNotices.length === 4 &&
    /switched Claude Code to another/.test(sentNotices[3].msg) && stateOf('stop-s') === 'sent', expectTo + ' / ' + profiles.activeProfile(TEST_ROOT) + ' / sent ' + sentNotices.length + ' / state ' + stateOf('stop-s'))
  await ext._test.onPageMessage({ type: 'switch', name: prevLive })

  usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [
    { kind: 'session', percent: 100, resets_at: new Date(Date.now() + 30 * 60e3).toISOString() },
    { kind: 'weekly_all', percent: 10, resets_at: new Date(Date.now() + 5 * 86400e3).toISOString() },
  ] }, Date.now())
  store.setAutoContinue(TEST_ROOT, { mode: 'switch', pick: 'order', order: ['eve'] })
  writeChat(startOf().concat([stopRec('stop-n', Date.now() + 3 * 3600e3)]))
  ext._test.refreshContext()
  q.info.push(undefined)
  await ext._test.checkLimits()
  const waitN = autoLib.readState(TEST_ROOT).stops['stop-n'] || {}
  check('with no account free, it waits for the first to reset, even another account', waitN.state === 'waiting' && waitN.to === 'eve' &&
    messages.some((m) => m.includes('No account has room now, so it will continue "Fix the tests"') && m.includes('on eve, the first account with room again')),
    JSON.stringify(waitN))
  autoLib.mark(TEST_ROOT, 'stop-n', { resetAt: Date.now() - 61e3 })
  usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [
    { kind: 'session', percent: 100, resets_at: new Date(Date.now() - 61e3).toISOString() },
    { kind: 'weekly_all', percent: 10, resets_at: new Date(Date.now() + 5 * 86400e3).toISOString() },
  ] }, Date.now())
  await ext._test.checkLimits()
  await waitFor(() => stateOf('stop-n') === 'sent', 60000)
  check('and when it does, it switches to that account and continues the chat there', profiles.activeProfile(TEST_ROOT) === 'eve' &&
    stateOf('stop-n') === 'sent' && /switched Claude Code to another/.test(sentNotices[sentNotices.length - 1].msg))
  await ext._test.onPageMessage({ type: 'switch', name: prevLive })

  usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [
    { kind: 'session', percent: 5, resets_at: new Date(Date.now() + 4 * 3600e3).toISOString() },
    { kind: 'weekly_all', percent: 10, resets_at: new Date(Date.now() + 5 * 86400e3).toISOString() },
  ] }, Date.now())
  store.setAutoContinue(TEST_ROOT, { mode: 'switch', pick: 'order', order: ['eve'] })
  const taskNote = (sec) => ({ type: 'user', timestamp: ago(sec), message: { role: 'user',
    content: '<task-notification>\n<task-id>ad5e9db18511dc76d</task-id>\n</task-notification>' } })
  writeChat(startOf().concat([stopRec('stop-t'), taskNote(299), taskNote(285), taskNote(284)]))
  liveSession('idle')
  ext._test.refreshContext()
  await ext._test.checkLimits()
  await waitFor(() => stateOf('stop-t') === 'sent', 60000)
  check('a stop followed by background agents reporting back still switches and continues the chat',
    stateOf('stop-t') === 'sent' && profiles.activeProfile(TEST_ROOT) === 'eve', stateOf('stop-t') + ' / ' + profiles.activeProfile(TEST_ROOT) +
      ' | ' + messages.slice(-8).join(' || '))
  addToChat([stopRec('stop-t2')])
  ext._test.refreshContext()
  await ext._test.checkLimits()
  check('and a second stop record in the same chat is the same episode, not a new one', stateOf('stop-t2') === undefined)
  await ext._test.onPageMessage({ type: 'switch', name: prevLive })

  store.setAutoContinue(TEST_ROOT, { mode: 'wait' })
  {
    let tap = null
    writeChat(startOf().concat([stopRec('stop-l')]))
    liveSession('idle')
    ext._test.refreshContext()
    q.info.push(new Promise((r) => { tap = r }))
    await ext._test.checkLimits()
    check('(a wait, its notice still showing)', stateOf('stop-l') === 'waiting')
    await ext._test.checkLimits()
    check('(the limit had reset: continued)', stateOf('stop-l') === 'sent')
    tap('Cancel')
    await tick()
    check('a late tap on the waiting notice\'s Cancel doesn\'t cancel a chat already continued', stateOf('stop-l') === 'sent', stateOf('stop-l'))
    writeChat(startOf().concat([stopRec('stop-m', Date.now() + 2 * 3600e3)]))
    ext._test.refreshContext()
    q.info.push(new Promise((r) => { tap = r }))
    await ext._test.checkLimits()
    const held = require('../lib/locks').acquireSync(TEST_ROOT, 'autocontinue', { staleMs: 60000, waitMs: 0 })
    let retry = null
    q.warn.push(new Promise((r) => { retry = r }))
    const nb = messages.length
    tap('Cancel')
    await tick()
    if (held) held()
    const busy = messages.slice(nb).join(' / ')
    check('a Cancel that can\'t get the lock says it couldn\'t cancel, not that it came late',
      !!held && stateOf('stop-m') === 'waiting' && /^WARN: Switcher couldn't cancel continuing/m.test(messages.slice(nb).join('\n')) && !/came after its wait/.test(busy), busy)
    retry('Try again')
    await tick()
    check('Cancel tapped while it waits cancels the wait (here by its Try again)', stateOf('stop-m') === 'cancelled', stateOf('stop-m'))
  }

  chatPinsLib.set(TEST_ROOT, LSID, 'dana', 'Fix the tests')
  store.setAutoContinue(TEST_ROOT, { mode: 'switch', pick: 'room', order: [] })
  liveSession('idle')
  writeChat(startOf().concat([stopRec('stop-p', Date.now() + 2 * 3600e3)]))
  ext._test.refreshContext()
  q.info.push(undefined)
  const liveBeforeP = profiles.activeProfile(TEST_ROOT)
  await ext._test.checkLimits()
  const stopP = autoLib.readState(TEST_ROOT).stops['stop-p'] || {}
  check('a pinned chat at its limit never switches the active account: it waits for its own account\'s reset',
    profiles.activeProfile(TEST_ROOT) === liveBeforeP && stopP.state === 'waiting' && stopP.pinned === true && stopP.account === 'dana' && !stopP.to,
    JSON.stringify(stopP))
  store.setAutoContinue(TEST_ROOT, { mode: 'ask', pick: 'room', order: [] })
  writeChat(startOf().concat([stopRec('stop-q', Date.now() + 2 * 3600e3)]))
  ext._test.refreshContext()
  const askedP = messages.length
  q.info.push(undefined)
  await ext._test.checkLimits()
  await settleNotes()
  check('asked, it says the chat is pinned to its account and stays there', messages.slice(askedP).some((m) =>
    m.includes('"Fix the tests" stopped at its 5-hour limit on ') && /It's pinned to .+, so it stays on that account\./.test(m)), messages.slice(askedP).join(' || '))
  chatPinsLib.remove(TEST_ROOT, LSID)
  store.setAutoContinue(TEST_ROOT, { mode: 'switch', pick: 'order', order: ['eve'] })

  console.log('\n-- 1.5: the page\'s own order, its settings, extra usage, "has room again" --')
  {
    const ps = () => ext._test.pageState()
    const names15 = () => ps().accounts.map((a) => a.name)
    const az = names15()
    const last = az[az.length - 1]
    await ext._test.onPageMessage({ type: 'setting', key: 'accountOrder', value: [last, 'nobody', last, 42] })
    check('the saved order keeps only saved accounts, each once', JSON.stringify(ext._test.prefOf('accountOrder')) === JSON.stringify([last]),
      JSON.stringify(ext._test.prefOf('accountOrder')))
    check('cards follow it; the rest go last, by name', JSON.stringify(names15()) === JSON.stringify([last].concat(az.slice(0, -1))), names15().join(','))
    await ext._test.onPageMessage({ type: 'setting', key: 'accountOrder', value: 'eve' })
    check('an order that is not a list is ignored', JSON.stringify(ext._test.prefOf('accountOrder')) === JSON.stringify([last]))
    profiles.writeMeta(TEST_ROOT, 'zz15', { email: 'zz15@example.com', capturedAt: new Date().toISOString() })
    fs.writeFileSync(path.join(profiles.profilesDir(TEST_ROOT), 'zz15.enc'), 'x')
    check('a new account goes last', names15().at(-1) === 'zz15' && names15()[0] === last, names15().join(','))
    await ext._test.onPageMessage({ type: 'setting', key: 'accountOrder', value: ['zz15', last] })
    check('and can be moved first', names15()[0] === 'zz15')
    profiles.remove(TEST_ROOT, 'zz15')
    check('a forgotten account drops out of the order', JSON.stringify(ext._test.prefOf('accountOrder')) === JSON.stringify([last]) &&
      !names15().includes('zz15'), names15().join(','))
    const extSrc = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8')
    check('the switch list and the pin list follow the order too', (extSrc.match(/inOrder\(profilesLib\.list\(root\(\)\)\)/g) || []).length === 3 &&
      !/\.sort\(byLabel\)/.test(extSrc))

    for (const k of ['listView', 'groupByOrg']) {
      check(k + ' is off at first', ps().prefs[k] === false)
      await ext._test.onPageMessage({ type: 'setting', key: k, value: true })
      check(k + ' is saved', ps().prefs[k] === true)
      await ext._test.onPageMessage({ type: 'setting', key: k, value: 'yes' })
      check(k + ': only true or false', ps().prefs[k] === true)
      await ext._test.onPageMessage({ type: 'setting', key: k, value: false })
    }
    check('the plan setting is gone', !('plan' in ps().prefs))
    check('dismissed notes are empty at first', JSON.stringify(ps().prefs.dismissedNotes) === '{}')
    await ext._test.onPageMessage({ type: 'setting', key: 'dismissedNotes', value: { 'eve:hint': 'wk:2026-11-30T10:00:00Z', 'eve:extra': 'mo:2026-11', 'nobody:hint': 'x',
      'eve:other': 'y', 'eve:fake': 5, [last + ':extra']: 'z'.repeat(500) } })
    check('dismissed notes keep saved accounts\' hint and extra only', JSON.stringify(ps().prefs.dismissedNotes) ===
      JSON.stringify({ 'eve:hint': 'wk:2026-11-30T10:00:00Z', 'eve:extra': 'mo:2026-11' }), JSON.stringify(ps().prefs.dismissedNotes))
    await ext._test.onPageMessage({ type: 'setting', key: 'dismissedNotes', value: ['eve:hint'] })
    check('and a list is not a map', Object.keys(ps().prefs.dismissedNotes).length === 2)
    {
      const dir = profiles.profilesDir(TEST_ROOT), away = dir + '-away'
      const orderBefore = JSON.stringify(ext._test.prefOf('accountOrder')), notesBefore = JSON.stringify(ps().prefs.dismissedNotes)
      fs.renameSync(dir, away)
      try {
        await ext._test.onPageMessage({ type: 'setting', key: 'accountOrder', value: [] })
        await ext._test.onPageMessage({ type: 'setting', key: 'dismissedNotes', value: {} })
      } finally { fs.renameSync(away, dir) }
      check('an empty account list does not wipe the saved order or notes',
        JSON.stringify(ext._test.prefOf('accountOrder')) === orderBefore && JSON.stringify(ps().prefs.dismissedNotes) === notesBefore && orderBefore !== '[]' && notesBefore !== '{}',
        orderBefore + ' ' + notesBefore)
    }
    await ext._test.onPageMessage({ type: 'setting', key: 'dismissedNotes', value: {} })
    await ext._test.onPageMessage({ type: 'setting', key: 'accountOrder', value: [] })
    check('no "This chat" row in 1.5.0', !('thisChat' in ps()))
    check('dialogs carry no Beta tags', !/betaButtons|\bbeta: /.test(extSrc))

    const soon = (ms) => new Date(Date.now() + ms).toISOString()
    usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [{ kind: 'session', percent: 20, resets_at: soon(3600e3) }],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, currency: 'USD', decimal_places: 2 } }, Date.now())
    const eveExtra = () => ps().accounts.find((a) => a.name === 'eve').extra
    check('extra usage reaches the card in whole money', JSON.stringify(eveExtra()) === JSON.stringify({ used: 12.34, limit: 50, currency: '$' }), JSON.stringify(eveExtra()))
    usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [], extra_usage: { is_enabled: false, monthly_limit: 4000, used_credits: 0 } }, Date.now())
    check('and none when it is off', eveExtra() === null)
    usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [], extra_usage: { is_enabled: true, monthly_limit: 12500, used_credits: 3670, currency: 'EUR', decimal_places: 2 } }, Date.now())
    check('the currency the API gives, on the card and in the hover', eveExtra().currency === '€' &&
      usageLib.extraText(usageLib.shape({ utilization: { limits: [], extra_usage: { is_enabled: true, monthly_limit: 12500, used_credits: 3670, currency: 'EUR', decimal_places: 2 } } })) === '€36.70 of €125.00')
    usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [], extra_usage: { is_enabled: true, monthly_limit: 50000, used_credits: 1234, currency: 'JPY' } }, Date.now())
    check('a currency without minor units counts whole units', JSON.stringify(eveExtra()) === JSON.stringify({ used: 1234, limit: 50000, currency: '¥' }), JSON.stringify(eveExtra()))
    const eveAt = Date.now() - 10 * 60e3
    usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [{ kind: 'session', percent: 20, resets_at: soon(3600e3) }] }, eveAt)
    check('each card has its own reading time', ps().accounts.find((a) => a.name === 'eve').fetchedAtMs === eveAt)

    const eveLabel = ps().accounts.find((a) => a.name === 'eve').label
    const roomMsgs = (from) => messages.slice(from).filter((m) => m.includes(eveLabel + ' has room again'))
    const t0 = Math.floor(Date.now() / 1000) * 1000
    const usedUp = (resetAgoMs) => usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [
      { kind: 'session', percent: 100, resets_at: new Date(t0 - resetAgoMs).toISOString() }, { kind: 'weekly_all', percent: 40, resets_at: soon(86400e3) }] },
      t0 - Math.max(resetAgoMs, 0) - 30 * 60e3)
    ext._test.roomReset()
    const activeNow = profiles.activeProfile(TEST_ROOT)
    check('(eve is not the active account here)', activeNow !== 'eve', activeNow)
    usedUp(-30 * 60e3)
    const mk = messages.length
    const calls = trackerCalls.length
    await ext._test.roomBackCheck()
    check('used up, before its reset: no notice and no reading', roomMsgs(mk).length === 0 && trackerCalls.length === calls)
    usedUp(5 * 60e3)
    settings.claudeswitcher = { ...(settings.claudeswitcher || {}), trackAllAccounts: false }
    await ext._test.roomBackCheck()
    check('tracking off: no notice', roomMsgs(mk).length === 0 && trackerCalls.length === calls)
    settings.claudeswitcher.trackAllAccounts = true
    ext._test.roomReset()
    usedUp(5 * 60e3)
    await ext._test.roomBackCheck()
    check('past its reset, it reads the account once and says it has room again', roomMsgs(mk).length === 1 &&
      trackerCalls.slice(calls).filter((c) => c === 'usage:AT-EVE').length === 1, messages.slice(mk).join(' || '))
    await ext._test.roomBackCheck()
    await ext._test.roomBackCheck()
    check('once per reset', roomMsgs(mk).length === 1)
    ext._test.roomReset()
    usedUp(5 * 60e3)
    await ext._test.roomBackCheck()
    check('not again for the same reset, even from a fresh window', roomMsgs(mk).length === 1)
    usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [] }, Date.now())
  }

  console.log('\n-- switching early, before the limit stops anything --')
  const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString()
  const liveUsage = (session, weekly) => usageLib.writeLiveCache(TEST_ROOT, null, { limits: [
    { kind: 'session', percent: session, resets_at: inHours(2) }, { kind: 'weekly_all', percent: weekly, resets_at: inHours(90) }] })
  const eveUsage = (session, weekly) => usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [
    { kind: 'session', percent: session, resets_at: inHours(4) }, { kind: 'weekly_all', percent: weekly, resets_at: inHours(100) }] }, Date.now())
  const freshEarly = () => autoLib.updateState(TEST_ROOT, (st) => { st.early = {} })
  const msgsFrom = (n) => messages.slice(n)
  await ext._test.onPageMessage({ type: 'autoContinue', mode: 'switch', pick: 'order', order: ['eve'], early: 80 })
  check('the page sets the share to switch at', store.getAutoContinue(TEST_ROOT).early === 80)
  await ext._test.onPageMessage({ type: 'autoContinue', early: 95 })
  check('and only between 50% and 90%', store.getAutoContinue(TEST_ROOT).early === 80)

  liveUsage(85, 20); eveUsage(10, 20); freshEarly()
  let mark = messages.length
  ext._test.earlySwitchCheck()
  await waitFor(() => profiles.activeProfile(TEST_ROOT) === 'eve', 60000)
  check('at 85% of its 5-hour limit (the share is 80%), it switches to the next account',
    profiles.activeProfile(TEST_ROOT) === 'eve', profiles.activeProfile(TEST_ROOT))
  await waitFor(() => msgsFrom(mark).some((m) => m.includes('Switched to eve')), 3000)
  check('and says so, with a way back, without the usual "Now signed in" message',
    msgsFrom(mark).some((m) => m.startsWith('INFO: Switched to eve: ') && m.includes('reached 85% of its 5-hour limit') && m.includes('Work carries on')) &&
    !msgsFrom(mark).some((m) => m.includes('Now signed in as')), msgsFrom(mark).join(' | '))
  await ext._test.onPageMessage({ type: 'switch', name: prevLive })
  liveUsage(86, 20)
  mark = messages.length
  ext._test.earlySwitchCheck()
  await new Promise((r) => setTimeout(r, 300))
  check('switched back by hand, it doesn\'t switch again in that same 5-hour window', profiles.activeProfile(TEST_ROOT) === prevLive &&
    !msgsFrom(mark).some((m) => m.includes('Switched to')), profiles.activeProfile(TEST_ROOT) + ' / ' + prevLive + ' / ' + msgsFrom(mark).join(' | '))

  await ext._test.onPageMessage({ type: 'autoContinue', mode: 'ask' })
  freshEarly(); q.info.push('Not Now')
  mark = messages.length
  ext._test.earlySwitchCheck()
  await new Promise((r) => setTimeout(r, 300))
  check('"Ask me" asks first, and "Not Now" leaves the account as it is', profiles.activeProfile(TEST_ROOT) === prevLive &&
    msgsFrom(mark).some((m) => m.includes('Switch to eve now, so work doesn\'t stop?')), profiles.activeProfile(TEST_ROOT) + ' / ' + msgsFrom(mark).join(' | '))
  mark = messages.length
  ext._test.earlySwitchCheck()
  check('and it isn\'t asked again in that window', !msgsFrom(mark).some((m) => m.includes('Switch to eve now')))

  await ext._test.onPageMessage({ type: 'autoContinue', mode: 'switch' })
  liveUsage(20, 96); freshEarly()
  mark = messages.length
  ext._test.earlySwitchCheck()
  await waitFor(() => profiles.activeProfile(TEST_ROOT) === 'eve', 60000)
  check('95% of the weekly limit switches too, however low the 5-hour use', profiles.activeProfile(TEST_ROOT) === 'eve' &&
    msgsFrom(mark).some((m) => m.includes('reached 96% of its weekly limit')), profiles.activeProfile(TEST_ROOT) + ' / ' + msgsFrom(mark).join(' | '))
  await ext._test.onPageMessage({ type: 'switch', name: prevLive })

  liveUsage(85, 20); eveUsage(75, 20); freshEarly()
  ext._test.earlySwitchCheck()
  await new Promise((r) => setTimeout(r, 300))
  check('no switch to an account that isn\'t well under the share (75% against 80%)', profiles.activeProfile(TEST_ROOT) === prevLive)
  eveUsage(10, 92); freshEarly()
  ext._test.earlySwitchCheck()
  await new Promise((r) => setTimeout(r, 300))
  check('nor to one at 90% of its week or more', profiles.activeProfile(TEST_ROOT) === prevLive)
  await ext._test.onPageMessage({ type: 'autoContinue', early: null })
  eveUsage(10, 20); freshEarly()
  ext._test.earlySwitchCheck()
  await new Promise((r) => setTimeout(r, 300))
  check('and with the share off ("hits its limit"), it never switches early', profiles.activeProfile(TEST_ROOT) === prevLive &&
    store.getAutoContinue(TEST_ROOT).early === null)

  console.log('\n-- the live account\'s usage, every 2 minutes --')
  const liveCacheFile = usageLib.cachePath(TEST_ROOT, null)
  const liveKey = usageLib.accountKey(null)
  let reads = 0
  ext._test.setLiveUsageRun(async () => { reads++; return { ok: true, utilization: { limits: [{ kind: 'session', percent: 12, resets_at: inHours(3) }] } } })
  fs.rmSync(liveCacheFile, { force: true })
  await ext._test.pollLiveUsage()
  check('read when 2 minutes old (or never read)', reads === 1 && (usageLib.readLiveCache(TEST_ROOT, null) || {}).session.percent === 12)
  await ext._test.pollLiveUsage()
  check('and not again while it is fresh: one read per interval for every window together', reads === 1)
  fs.rmSync(liveCacheFile, { force: true })
  const liveCfgBefore = fs.readFileSync(LIVE_CFG, 'utf8')
  const liveCfgNow = JSON.parse(liveCfgBefore)
  liveCfgNow.cachedUsageUtilization = { fetchedAtMs: Date.now(), accountUuid: (liveCfgNow.oauthAccount || {}).accountUuid,
    utilization: { limits: [{ kind: 'session', percent: 30, resets_at: inHours(3) }] } }
  fs.writeFileSync(LIVE_CFG, JSON.stringify(liveCfgNow))
  await ext._test.pollLiveUsage()
  check('nor when Claude Code has just read it itself', reads === 1)
  fs.writeFileSync(LIVE_CFG, liveCfgBefore)
  ext._test.setLiveUsageRun(async () => { reads++; return { ok: false, rateLimited: true, retryAfterMs: 60000 } })
  await ext._test.pollLiveUsage()
  await ext._test.pollLiveUsage()
  check('a "too many requests" pauses it, for every window', reads === 2 && usageLib.pausedUntil(TEST_ROOT, liveKey) > Date.now())
  usageLib.pauseUntil(TEST_ROOT, liveKey, 0)
  ext._test.setLiveUsageRun(null)
  fs.rmSync(liveCacheFile, { force: true })
  usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [] }, Date.now())
  store.setAutoContinue(TEST_ROOT, { mode: 'ask', pick: 'room', order: [] })
  ext._test.setHandoffRun(null)
  fs.rmSync(LPROJ, { recursive: true, force: true })
  fs.rmSync(LREC, { force: true })
  ext._test.refreshContext()

  console.log('\n-- keep alive --')
  check('off for every account at first', ext._test.pageState().accounts.every((a) => a.keepAlive === false))
  await ext._test.onPageMessage({ type: 'keepAlive', name: 'eve', on: true })
  check('the menu turns it on for one account', store.getKeepAlive(TEST_ROOT, 'eve') &&
    ext._test.pageState().accounts.find((a) => a.name === 'eve').keepAlive === true)
  const kept = []
  ext._test.setKickoffRun(async (dir) => { kept.push(dir); return { ok: true } })
  usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [
    { kind: 'session', percent: 64, resets_at: new Date(Date.now() - 60e3).toISOString() },
    { kind: 'weekly_all', percent: 30, resets_at: new Date(Date.now() + 5 * 86400e3).toISOString() },
  ] }, Date.now())
  await ext._test.keepAliveTick()
  check('when its 5-hour window has ended, it gets a "hi" to start the next one', kept.length === 1)
  await ext._test.keepAliveTick()
  check('only once, however often it checks', kept.length === 1)
  autoLib.updateState(TEST_ROOT, (st) => { st.keepAlive.eve = 0 })
  usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [
    { kind: 'session', percent: 3, resets_at: new Date(Date.now() + 4 * 3600e3).toISOString() },
    { kind: 'weekly_all', percent: 30, resets_at: new Date(Date.now() + 5 * 86400e3).toISOString() },
  ] }, Date.now())
  await ext._test.keepAliveTick()
  check('never while a session is running', kept.length === 1)
  await ext._test.onPageMessage({ type: 'keepAlive', name: 'eve', on: false })
  check('and it turns off again', !store.getKeepAlive(TEST_ROOT, 'eve'))
  usageLib.writeCacheForKey(TEST_ROOT, 'uuid-eve', { limits: [] }, Date.now())
  ext._test.setKickoffRun(null)
  profiles.remove(TEST_ROOT, 'eve')
  q.warn.push(undefined)
  await ext._test.onPageMessage({ type: 'forget', name: 'late' })
  check('Forget asks first (dismissed: nothing forgotten)', profiles.exists(TEST_ROOT, 'late'))
  q.warn.push('Forget'); q.info.push(undefined)
  await ext._test.onPageMessage({ type: 'forget', name: 'late' })
  check('and forgets once confirmed', !profiles.exists(TEST_ROOT, 'late'))
  await ext._test.onPageMessage({ type: 'status' })
  check('Show status writes the report', messages.some((m) => m.includes('=== Claude accounts ===')))

  console.log('\n-- the Accounts page: the sidebar version --')
  const view = { visible: true, webview: mockWebview(), onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }) }
  viewProvider.provider.resolveWebviewView(view)
  check('the sidebar gets the same page in its compact layout', view.webview.html.includes('layout-sidebar') &&
    /default-src 'none'/.test(view.webview.html))
  await view.webview.handler({ type: 'ready' })
  check('and its own copy of the state', view.webview.posted.some((m) => m.type === 'state'))
  const tabPostsBefore = panel.webview.posted.length
  ext._test.refreshAll()
  check('both versions update together', view.webview.posted.length > 1 && panel.webview.posted.length > tabPostsBefore)
  await view.webview.handler({ type: 'openTab' })
  check('"Open as a tab" from the sidebar reveals the tab', panel.revealed > 0)
  settings.claudeswitcher.accountsView = 'sidebar'
  executed.length = 0
  await registered['claudeswitcher.openAccounts']()
  check('with the setting on "sidebar", Open Accounts shows the sidebar', executed.some((e) => e.id === 'workbench.view.extension.claudeAccounts'))
  settings.claudeswitcher.accountsView = 'tab'
  panel.dispose()
  await registered['claudeswitcher.openAccounts']()
  check('a closed tab is recreated on the next open', panels.length === 3 && panels[2].visible)
  fs.mkdirSync(path.join(FAKE_APPROOT, 'out', 'media'), { recursive: true })
  fs.writeFileSync(path.join(FAKE_APPROOT, 'out', 'media', 'codicon.ttf'), 'fake font')
  panels[2].dispose()
  await registered['claudeswitcher.openAccounts']()
  check('VS Code\'s own codicon font is used when present, from its own folder',
    panels[3].webview.html.includes('@font-face') && panels[3].webview.html.includes('codicon.ttf') &&
    panels[3].options.localResourceRoots.some((r) => r.fsPath.endsWith(path.join('out', 'media'))))
  panels[3].dispose()

  check('the Accounts tab is registered to come back after a reload', panelSerializer && panelSerializer.id === 'claudeswitcher.accounts')
  const restored = vscode.window.createWebviewPanel('claudeswitcher.accounts', 'Claude Accounts', -1, {})
  await panelSerializer.serializer.deserializeWebviewPanel(restored, undefined)
  check('a restored tab is filled in again, with its icon and the current state',
    restored.webview.html.includes('<html') && !!restored.iconPath && restored.webview.posted.some((m) => m.type === 'state'))
  const tabsBefore = panels.length
  await registered['claudeswitcher.openAccounts']()
  check('and Open Accounts then shows that tab rather than opening a second one', panels.length === tabsBefore && restored.revealed > 0)
  const extra = vscode.window.createWebviewPanel('claudeswitcher.accounts', 'Claude Accounts', -1, {})
  await panelSerializer.serializer.deserializeWebviewPanel(extra, undefined)
  check('a second restored copy is closed: one Accounts tab at a time', !extra.visible && restored.visible)
  restored.dispose()
  await registered['claudeswitcher.openAccounts']()
  check('once the restored tab is closed, Open Accounts makes a new one', panels.length === tabsBefore + 2 && panels.at(-1).visible)
  panels.at(-1).dispose()

  console.log('\n-- folder pins --')
  const PIN_FOLDER = path.join(TEST_ROOT, 'work-repo')
  const OTHER = path.join(TEST_ROOT, 'other-repo')
  fs.mkdirSync(PIN_FOLDER, { recursive: true })
  fs.mkdirSync(OTHER, { recursive: true })
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: PIN_FOLDER } }]
  const activateFresh = (pkg) => {
    for (const id of Object.keys(registered)) delete registered[id]
    const c = { subscriptions: [], extension: pkg ? { packageJSON: pkg } : undefined }
    const barAt = bars.length
    ext.activate(c)
    return { c, accountBar: bars[barAt] }
  }
  const disposeAll = (c) => { for (const d of c.subscriptions) { try { d.dispose() } catch {  } } }

  const wrapperList = () => { try { return fs.readFileSync(chatPinsLib.wrapperFile(TEST_ROOT), 'utf8') } catch { return '' } }
  const pinnedFolderLine = (folder, name) => wrapperList().split('\n').some((l) => {
    const [kind, f, n] = l.split('\t')
    return kind === 'folder' && n === name && chatPinsLib.samePath(f, store.pinKey(folder))
  })

  store.setPin(TEST_ROOT, PIN_FOLDER, 'dana')
  await loginsLib.remove(TEST_ROOT, 'dana')
  q.warn.push(undefined)
  let run = activateFresh()
  check('a pin whose account has no pinning login leaves the window on the global account',
    !ext._test.pageState().window.pinnedTo && !pinnedFolderLine(PIN_FOLDER, 'dana'))
  check('the page says it needs a pinning login', ext._test.pageState().window.needsPinning === ext._test.pageState().accounts.find((a) => a.name === 'dana').label)
  check('and the window offers to add one', messages.some((m) => m.includes('which has no pinning login')))
  check('the window\'s own environment is never changed by a pin', !process.env.CLAUDE_CONFIG_DIR)
  check('the page no longer knows about pin keys', !JSON.stringify(ext._test.pageState()).includes('pinKey') &&
    !('needsKey' in ext._test.pageState().window))
  disposeAll(run.c)

  terminals.length = 0
  signinQ.push({ email: 'dana@example.com', uuid: 'uuid-d', rt: 'RT-D5', days: 35.5 })
  q.warn.push({ value: 'Done' })
  await ext._test.onPageMessage({ type: 'addPinning', name: 'dana' })
  await tick()
  check('a pinning login is added without a terminal', terminals.length === 0 && loginsLib.hasLogin(TEST_ROOT, 'dana'))
  check('it shorter than main: no "keep main login active?" box, main unchanged',
    Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'dana').loginExpiresAt) - 40.5) < 0.1)
  const dpin = (ext._test.pageState().accounts.find((a) => a.name === 'dana') || {}).pinning
  check('the page shows it on the account, with its end date', dpin && Math.abs(daysOf(dpin.expiresAt) - 35.5) < 0.1, JSON.stringify(dpin))
  check('no token reaches the page', !JSON.stringify(ext._test.pageState()).includes('RT-D'))

  run = activateFresh()
  check('with a pinning login, the folder is pinned', ext._test.pageState().window.pinnedTo === 'dana')
  check('the wrapper\'s list has it, so its chats start on the pinning login', pinnedFolderLine(PIN_FOLDER, 'dana'))
  check('and Claude Code\'s wrapper setting is on', chatPinsLib.samePath(settings.claudeCode.claudeProcessWrapper, path.join(TEST_ROOT, 'bin', chatPinsLib.wrapperName())))
  check('still without touching this window\'s environment', !process.env.CLAUDE_CONFIG_DIR)
  check('the status bar shows the pin', /\$\(pin\)/.test(run.accountBar.text || ''), run.accountBar.text)
  check('clicking it manages the pin', run.accountBar.command === 'claudeswitcher.pinFolder')
  q.quick.push('Unpin this folder')
  await registered['claudeswitcher.pinFolder']()
  check('Pin Folder offers "Unpin this folder", which works at once', !store.getPin(TEST_ROOT, PIN_FOLDER) && !pinnedFolderLine(PIN_FOLDER, 'dana'))
  check('and says so', messages.some((m) => m.includes('is unpinned')))
  check('with nothing pinned, the wrapper setting is off again', !settings.claudeCode.claudeProcessWrapper)
  disposeAll(run.c)

  run = activateFresh()
  check('unpinned, the window is on the global account', !ext._test.pageState().window.pinnedTo)
  executed.length = 0
  q.quick.push('Another folder'); q.open.push([{ fsPath: OTHER }]); q.quick.push('dana')
  await registered['claudeswitcher.pinFolder']()
  check('"Another folder…" pins it', store.getPin(TEST_ROOT, OTHER) === 'dana' && pinnedFolderLine(OTHER, 'dana'))
  check('with no new window: any window on it follows the pin', !executed.some((e) => e.id === 'vscode.openFolder'))
  await ext._test.onPageMessage({ type: 'unpin', folder: store.pinKey(OTHER) })
  check('Unpin on the page removes it, from the wrapper\'s list too', !store.getPin(TEST_ROOT, OTHER) && !pinnedFolderLine(OTHER, 'dana'))

  const wdir = windowsLib.prepare(TEST_ROOT, 'dana')
  fs.writeFileSync(path.join(wdir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'AT-W', refreshToken: 'RT-W' } }))
  store.setPin(TEST_ROOT, OTHER, 'dana')
  q.info.push('Forget')
  await ext._test.onPageMessage({ type: 'forgetWindowLogin', name: 'dana' })
  check('an old window login can be forgotten', !fs.existsSync(wdir))
  check('and pins stay, since they use the pinning login', store.getPin(TEST_ROOT, OTHER) === 'dana')
  check('the shared history it linked to is untouched',
    fs.readFileSync(path.join(CLAUDE_DIR, 'projects', 'C--repo', 'chat.jsonl'), 'utf8') === 'precious\n')
  store.setPin(TEST_ROOT, OTHER, null)
  disposeAll(run.c)

  console.log('\n-- the release (main) build --')
  store.setPin(TEST_ROOT, PIN_FOLDER, 'dana')
  fs.rmSync(chatPinsLib.wrapperFile(TEST_ROOT), { force: true })
  run = activateFresh({ claudeswitcher: { edition: 'main' } })
  const ids = Object.keys(registered).map((i) => i.replace('claudeswitcher.', '')).sort()
  check('registers exactly the release set', ids.join(',') === [...editionLib.MAIN_COMMANDS].sort().join(','), ids.join(','))
  check('and folder pins work in the release too', ext._test.pageState().window.pinnedTo === 'dana' && pinnedFolderLine(PIN_FOLDER, 'dana'))
  store.setPin(TEST_ROOT, PIN_FOLDER, null)
  check('the release page has the Artifacts switch too', ext._test.pageState().features.artifacts === true)
  await ext._test.onPageMessage({ type: 'artifacts', name: 'work', on: false })
  check('and it works there', store.getArtifacts(TEST_ROOT, 'work') === 'off')
  const relFeatures = ext._test.pageState().features
  check('since 1.2.0 the release has "login for another PC", ▶ "start a 5-hour session" and chat context',
    relFeatures.spareLogin === true && relFeatures.startSession === true && relFeatures.context === true)
  check('and since 1.3.0, moving accounts between PCs', relFeatures.transfer === true)
  check('and ▶\'s command, for the usage hover\'s links', !!registered['claudeswitcher.startSession'])
  await ext._test.onPageMessage({ type: 'artifacts', name: 'work', on: true })
  disposeAll(run.c)
  delete process.env.CLAUDE_CONFIG_DIR
  vscode.workspace.workspaceFolders = []
  ext._test.stopLoginWatchers()

  console.log('\n-- an older copy, from before the Marketplace id, still installed --')
  const warnsBefore = messages.length
  vscode.extensions = { getExtension: (id) => (id === 'local.claude-account-switcher' ? { id } : undefined) }
  run = activateFresh({ claudeswitcher: { edition: 'main' } })
  check('this one registers nothing and sets no pin, so the two never clash', Object.keys(registered).length === 0)
  check('and offers to uninstall the old one', messages.slice(warnsBefore).some((m) => m.includes('installed twice') && m.includes('local.claude-account-switcher')))
  delete vscode.extensions
  disposeAll(run.c)

  console.log('\n-- name validation --')
  check('rejects path traversal', !store.validName('../evil'))
  check('rejects spaces', !store.validName('my account'))
  check('accepts normal name', store.validName('work-2'))
  check('refuses a name ending in ".settings" (that is another account\'s pinned-chat settings file)',
    !store.validName('jane.settings') && !store.validName('Jane.SETTINGS') && store.validName('jane.settings2') && store.validName('settings'))
  check('rejects a blank label', !store.validLabel('   '))
  check('rejects an icon with spaces', !store.validIcon('my icon'))

  console.log('\n-- a machine-wide CLAUDE_CONFIG_DIR is never cleared without asking (M7) --')
  settings.claudeCode.environmentVariables = [{ name: 'CLAUDE_CONFIG_DIR', value: '/deliberately/elsewhere' }]
  run = activateFresh()
  await tick()
  check('without an answer it stays', settings.claudeCode.environmentVariables.some((e) => e.name === 'CLAUDE_CONFIG_DIR'))
  disposeAll(run.c)
  const remembered = new Map()
  const withState = (answer) => {
    for (const id of Object.keys(registered)) delete registered[id]
    const c = { subscriptions: [], globalState: { get: (k) => remembered.get(k), update: async (k, v) => { remembered.set(k, v) } } }
    if (answer) q.warn.push(answer)
    ext.activate(c)
    return c
  }
  let c7 = withState('Keep It')
  await tick()
  disposeAll(c7)
  const asked = messages.filter((m) => m.includes('CLAUDE_CONFIG_DIR=/deliberately/elsewhere')).length
  c7 = withState(null)
  await tick()
  check('"Keep It" is remembered: not asked again, and still set',
    messages.filter((m) => m.includes('CLAUDE_CONFIG_DIR=/deliberately/elsewhere')).length === asked &&
    settings.claudeCode.environmentVariables.some((e) => e.name === 'CLAUDE_CONFIG_DIR'))
  disposeAll(c7)
  settings.claudeCode.environmentVariables = []

  console.log('\n-- files that can hold secrets stay private (audit #5) --')
  if (process.platform !== 'win32') {
    fs.chmodSync(LIVE_CFG, 0o644)
    q.warn.push('Make Private')
    await ext._test.offerPrivateFiles(null, true)
    check('a ~/.claude.json other users can read is reported, and made private when asked',
      (fs.statSync(LIVE_CFG).mode & 0o777) === 0o600, (fs.statSync(LIVE_CFG).mode & 0o777).toString(8))
    const deadPid = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
    const staleCopy = LIVE_CFG + '.tmp-' + deadPid + '-abcdef12'
    fs.writeFileSync(staleCopy, '{"mcpServers":{"secret":{}}}')
    ext._test.removeStaleTemps()
    check('a temp copy a crashed write left behind is removed at startup', !fs.existsSync(staleCopy))
  }

  console.log('\n-- Remote Control set by hand is left alone (audit #6) --')
  const userSettings = path.join(CLAUDE_DIR, 'settings.json')
  for (const p of profiles.list(TEST_ROOT)) store.setRemote(TEST_ROOT, p.name, 'on')
  fs.writeFileSync(userSettings, JSON.stringify({ disableRemoteControl: true, theme: 'dark' }, null, 2))
  run = activateFresh()
  await tick()
  check('a window starting up keeps it', JSON.parse(fs.readFileSync(userSettings, 'utf8')).disableRemoteControl === true)
  disposeAll(run.c)

  console.log('\n-- hovers show outside text as text (M8) --')
  const evil = 'Team\n\n![x](https://evil.example/b.png) [Re-auth](https://evil.example)'
  store.setDisplay(TEST_ROOT, profiles.activeProfile(TEST_ROOT) || 'work', { label: 'ok' })
  const cfgNow = JSON.parse(fs.readFileSync(LIVE_CFG, 'utf8'))
  fs.writeFileSync(LIVE_CFG, JSON.stringify({ ...cfgNow, oauthAccount: { ...cfgNow.oauthAccount, organizationName: evil } }))
  ext._test.refreshAll()
  const accountTip = String(run.accountBar.tooltip || '')
  check('an org name can\'t add an image or a link to the account hover',
    !/!\[x\]\(https/.test(accountTip) && !/\[Re-auth\]\(https/.test(accountTip) && accountTip.includes('Re-auth'), accountTip.slice(0, 200))
  fs.writeFileSync(LIVE_CFG, JSON.stringify(cfgNow))

  {
    const remembered = new Map()
    const activate14 = () => {
      for (const id of Object.keys(registered)) delete registered[id]
      const c = { subscriptions: [], extension: { packageJSON: { version: '1.4.0' } },
        globalState: { get: (k) => remembered.get(k), update: async (k, v) => { remembered.set(k, v) } } }
      const barAt = bars.length
      ext.activate(c)
      return { c, barAt, accountBar: bars[barAt], usageBar: bars[barAt + 1] }
    }
    const done14 = (c) => { for (const d of c.subscriptions) { try { d.dispose() } catch {  } } }
    delete process.env.CLAUDE_CONFIG_DIR
    vscode.workspace.workspaceFolders = []
    let run14 = activate14()
    const names = profiles.list(TEST_ROOT).map((p) => p.name)
    const live = profiles.activeProfile(TEST_ROOT)
    const other = names.find((n) => n !== live && n !== 'dana') || names.find((n) => n !== live)

    console.log('\n-- 1.4: the ⚙ settings --')
    const prefs = ext._test.pageState().prefs
    check('defaults: context off, the rest on, Accounts in a tab', prefs.context === false && prefs.tint === true &&
      prefs.cardToggles === true && prefs.statusUsage === true && prefs.statusLoginDays === true && prefs.confirmOrgSwitch === true &&
      prefs.trackAll === true && prefs.accountsView === 'tab', JSON.stringify(prefs))
    await ext._test.onPageMessage({ type: 'setting', key: 'tint', value: false })
    check('a switch on the page is saved as a VS Code setting', settings.claudeswitcher['cards.tint'] === false)
    check('and the page shows it', ext._test.pageState().prefs.tint === false)
    await ext._test.onPageMessage({ type: 'setting', key: 'accountsView', value: 'sidebar' })
    await ext._test.onPageMessage({ type: 'setting', key: 'accountsView', value: 'banana' })
    await ext._test.onPageMessage({ type: 'setting', key: 'root', value: 'C:\\evil' })
    await ext._test.onPageMessage({ type: 'setting', key: 'tint', value: 'yes' })
    check('only listed settings, with values of the right kind', settings.claudeswitcher.accountsView === 'sidebar' &&
      settings.claudeswitcher.root === TEST_ROOT && settings.claudeswitcher['cards.tint'] === false)
    check('the compact view is off by default', prefs.compact === false, JSON.stringify(prefs))
    await ext._test.onPageMessage({ type: 'setting', key: 'compact', value: true })
    check('the compact view is an accepted setting, kept for every window', remembered.get('claudeswitcher.compactView') === true &&
      ext._test.pageState().prefs.compact === true)
    await ext._test.onPageMessage({ type: 'setting', key: 'compact', value: 'no' })
    await ext._test.onPageMessage({ type: 'setting', key: 'compact', value: 0 })
    check('and anything but true or false is refused', remembered.get('claudeswitcher.compactView') === true && ext._test.pageState().prefs.compact === true)
    await ext._test.onPageMessage({ type: 'setting', key: 'compact', value: false })
    check('it can be turned off again', remembered.get('claudeswitcher.compactView') === false && ext._test.pageState().prefs.compact === false)
    check('the login validity lines are on by default', prefs.validity === true && !remembered.has('claudeswitcher.validityStroke'), JSON.stringify(prefs))
    await ext._test.onPageMessage({ type: 'setting', key: 'validity', value: false })
    check('turning them off is kept for every window and reaches the page', remembered.get('claudeswitcher.validityStroke') === false &&
      ext._test.pageState().prefs.validity === false)
    await ext._test.onPageMessage({ type: 'setting', key: 'validity', value: 'no' })
    await ext._test.onPageMessage({ type: 'setting', key: 'validity', value: 0 })
    check('anything but true or false is refused', remembered.get('claudeswitcher.validityStroke') === false && ext._test.pageState().prefs.validity === false)
    await ext._test.onPageMessage({ type: 'setting', key: 'validity', value: true })
    check('and they come back on', remembered.get('claudeswitcher.validityStroke') === true && ext._test.pageState().prefs.validity === true)
    await ext._test.onPageMessage({ type: 'setting', key: 'statusUsage', value: false })
    ext._test.refreshAll()
    check('Usage figures off hides the usage meter', run14.usageBar && run14.usageBar.shown === false)
    await ext._test.onPageMessage({ type: 'setting', key: 'statusUsage', value: true })
    ext._test.refreshAll()
    check('and on shows it again', run14.usageBar.shown === true)
    await ext._test.onPageMessage({ type: 'setting', key: 'statusLoginDays', value: false })
    ext._test.refreshAll()
    check('Days left on the login off: no "(29D)" after the name', !/\(\d+D\)|\(expired\)/.test(run14.accountBar.text || ''), run14.accountBar.text)
    for (const k of ['cards.tint', 'accountsView', 'statusBar.usage', 'statusBar.loginDays']) delete settings.claudeswitcher[k]

    console.log('\n-- 1.4: the welcome and what\'s new --')
    const w = ext._test.pageState().welcome
    check('someone updating (accounts saved, nothing seen yet) gets what\'s new for 1.4.0', w && w.kind === 'update' && w.version === '1.4.0' && w.items.length > 0)
    await ext._test.onPageMessage({ type: 'welcomeDone', kind: 'update' })
    await tick()
    check('once seen, it isn\'t shown again (in any window)', remembered.get('claudeswitcher.seenVersion') === '1.4.0' && ext._test.pageState().welcome === null)

    console.log('\n-- 1.4: switching to another organization --')
    const card = (n) => ext._test.pageState().accounts.find((a) => a.name === n)
    const setOrg = (n, org) => {
      const f = path.join(store.configDir(TEST_ROOT, n), '.claude.json')
      let j = {}
      try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {  }
      j.oauthAccount = { ...(j.oauthAccount || {}), organizationUuid: org }
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, JSON.stringify(j))
    }
    setOrg(live, 'org-one'); setOrg(other, 'org-two')
    check('the page knows each account\'s organization', card(live).orgId === 'org-one' && card(other).orgId === 'org-two')
    const warnsAt = messages.length
    q.warn.push(undefined)
    await ext._test.onPageMessage({ type: 'switch', name: other })
    check('a switch to another organization asks first, and Cancel keeps the account',
      messages.slice(warnsAt).some((m) => m.includes('is in another organization')) && profiles.activeProfile(TEST_ROOT) === live)
    await ext._test.onPageMessage({ type: 'switch', name: other, confirmed: true, dontAsk: true })
    await tick()
    check('confirmed in the page\'s own dialog, with Don\'t ask again: switched, and it won\'t ask again',
      profiles.activeProfile(TEST_ROOT) === other && settings.claudeswitcher.confirmOrganizationSwitch === false)
    await ext._test.onPageMessage({ type: 'switch', name: live, confirmed: true })
    await tick()
    delete settings.claudeswitcher.confirmOrganizationSwitch

    console.log('\n-- 1.4: folder pins without a reload --')
    const FOLDER14 = path.join(TEST_ROOT, 'site-14')
    fs.mkdirSync(FOLDER14, { recursive: true })
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: FOLDER14 } }]
    done14(run14.c)
    run14 = activate14()
    check('an unpinned window starts on the global account', !ext._test.pageState().window.pinnedTo)
    executed.length = 0
    await loginsLib.remove(TEST_ROOT, 'dana')
    signinQ.push({ email: 'dana@example.com', uuid: 'uuid-d', rt: 'RT-D6', days: 33.5 })
    q.quick.push('This folder'); q.quick.push('dana'); q.warn.push({ value: 'Continue' })
    await registered['claudeswitcher.pinFolder']()
    check('pinning to an account with no pinning login adds one first, with no name pop-up', loginsLib.hasLogin(TEST_ROOT, 'dana') &&
      signins[signins.length - 1].o.email === 'dana@example.com')
    check('then it takes effect at once: new chats here start on its pinning login', ext._test.pageState().window.pinnedTo === 'dana')
    check('the wrapper list has dana\'s login line with its end date', wrapperList().split('\n').some((l) => {
      const [k, n, at, dir] = l.split('\t')
      return k === 'login' && n === 'dana' && Math.abs(daysOf(Number(at)) - 33.5) < 0.1 && chatPinsLib.samePath(dir, loginsLib.dirFor(TEST_ROOT, 'dana'))
    }))
    check('with no reload', !executed.some((e) => e.id === 'workbench.action.reloadWindow'))
    check('and the status bar shows the pin', /\$\(pin\)/.test(run14.accountBar.text || ''), run14.accountBar.text)
    check('the pin days item shows the pinning login', bars[run14.barAt + 3].shown && bars[run14.barAt + 3].text === '· $(pin) 33d' &&
      /Pinning login: 33 days left\./.test(String(bars[run14.barAt + 3].tooltip)), bars[run14.barAt + 3].text)
    q.quick.push('Unpin this folder')
    await registered['claudeswitcher.pinFolder']()
    check('unpinning takes effect at once too', !ext._test.pageState().window.pinnedTo && !store.getPin(TEST_ROOT, FOLDER14))
    await loginsLib.remove(TEST_ROOT, 'dana')
    signinQ.push({ hold: true })
    q.quick.push('This folder'); q.quick.push('dana')
    const declined = registered['claudeswitcher.pinFolder']()
    await tick(); await tick()
    const sAsk = ext._test.openAsks().find((a) => a.spec.kind === 'signin')
    if (sAsk) await ext._test.onPageMessage({ type: 'answer', id: sAsk.id, cancel: true })
    await declined
    check('closing the sign-in pins nothing', sAsk && !store.getPin(TEST_ROOT, FOLDER14))
    check('the status bar is back on the global account', !/\$\(pin\)/.test(run14.accountBar.text || ''), run14.accountBar.text)
    givePinning('dana', 'dana@example.com', 'uuid-d', 'RT-D7', 33.5)

    console.log('\n-- 1.4: questions are asked in the Accounts page, never the top bar --')
    {
      ext._test.setAsker(null)
      const quickBefore = q.quick.length
      const inputBefore = q.input.length
      const opened = panels.length
      const adding = registered['claudeswitcher.globalAdd']()
      await tick()
      const page = panels[panels.length - 1]
      check('a question opens the Accounts page', panels.length === opened + 1 && page && page.visible)
      await page.webview.handler({ type: 'ready' })
      const ask1 = page.webview.posted.filter((m) => m.type === 'ask').pop()
      check('and asks there, as a list of choices', ask1 && ask1.spec.kind === 'pick' && ask1.spec.items.length >= 2 &&
        ask1.spec.items.some((i) => /Sign in to another account/.test(i.label)), JSON.stringify(ask1 && ask1.spec))
      check('with the icons as the page\'s own, not VS Code\'s $(…) codes', ask1 && ask1.spec.items.every((i) => !/\$\(/.test(i.label)))
      const signIn = ask1.spec.items.find((i) => /Sign in to another account/.test(i.label))
      await page.webview.handler({ type: 'answer', id: ask1.id, index: signIn.i })
      await tick()
      const ask2 = page.webview.posted.filter((m) => m.type === 'ask').pop()
      check('the next question follows in the page: the new account\'s look', ask2 && ask2.id !== ask1.id && ask2.spec.kind === 'account')
      check('and the answered one is closed', page.webview.posted.some((m) => m.type === 'askDone' && m.id === ask1.id))
      await page.webview.handler({ type: 'answer', id: ask2.id, value: 'bad name!' })
      await tick()
      const ask3 = page.webview.posted.filter((m) => m.type === 'ask').pop()
      check('then the sign-in pop-up, in the page', ask3 && ask3.spec.kind === 'signin', JSON.stringify(ask3 && ask3.spec))
      await page.webview.handler({ type: 'answer', id: ask3.id, cancel: true })
      await adding
      check('Cancel ends it, with nothing added', !profiles.exists(TEST_ROOT, 'bad name!'))
      await page.webview.handler({ type: 'answer', id: 9999, index: 0 })
      check('an answer to no question is ignored', true)
      ext._test.setNoticesInPage(true)
      const noting = ext._test.notify('warn', 'Something to know', 'Do It', 'Later')
      const note = page.webview.posted.filter((m) => m.type === 'note').pop()
      check('a notice shows in the open page, not in VS Code\'s corner', note && note.text === 'Something to know' && note.tone === 'warn' &&
        note.buttons.join() === 'Do It,Later' && !messages.some((m) => m.includes('Something to know')), JSON.stringify(note))
      await page.webview.handler({ type: 'note', id: note.id, label: 'Do It' })
      check('and its button answers it', (await noting) === 'Do It')
      const asking = ext._test.notify('warn', 'Really?', { modal: true, detail: 'It matters.' }, 'Yes')
      await tick()
      const askM = page.webview.posted.filter((m) => m.type === 'ask').pop()
      check('what was a VS Code dialog is asked in the page, with its buttons', askM && askM.spec.kind === 'confirm' &&
        askM.spec.buttons.join() === 'Yes' && askM.spec.message === 'It matters.', JSON.stringify(askM && askM.spec))
      await page.webview.handler({ type: 'answer', id: askM.id, value: 'Nope' })
      check('an answer that isn\'t one of its buttons is Cancel', (await asking) === undefined)
      const closing = ext._test.uiAsk({ kind: 'confirm', title: 'Added', check: { label: 'Box', checked: true }, buttons: ['Done'], cancel: false })
      await tick()
      const askC = page.webview.posted.filter((m) => m.type === 'ask').pop()
      await page.webview.handler({ type: 'answer', id: askC.id, closed: true, checked: false })
      const closedV = await closing
      check('closing a pop-up with no Cancel keeps its unticked box', closedV && closedV.closed === true && closedV.value === null && closedV.checked === false, JSON.stringify(closedV))
      const closing2 = ext._test.uiAsk({ kind: 'confirm', title: 'Sure?', check: { label: 'Box', checked: true }, buttons: ['Yes'] })
      await tick()
      const askC2 = page.webview.posted.filter((m) => m.type === 'ask').pop()
      await page.webview.handler({ type: 'answer', id: askC2.id, closed: true, checked: false })
      check('one with a Cancel: closing it is still Cancel', (await closing2) === undefined)
      ext._test.setNoticesInPage(false)
      const corner = ext._test.notify('info', 'Page or not')
      check('notices go to VS Code\'s corner when they can\'t show in the page', messages.some((m) => m === 'INFO: Page or not'))
      await corner
      const pinning = registered['claudeswitcher.pinFolder']()
      await tick()
      const askP = page.webview.posted.filter((m) => m.type === 'ask').pop()
      await page.webview.handler({ type: 'answer', id: askP.id, index: 999 })
      await pinning
      check('a choice that isn\'t on the list is Cancel', !store.getPin(TEST_ROOT, vscode.workspace.workspaceFolders.length ? vscode.workspace.workspaceFolders[0].uri.fsPath : 'none'))
      const pinning2 = registered['claudeswitcher.pinFolder']()
      await tick()
      page.dispose()
      await pinning2
      check('closing the page with a question open is Cancel too', true)
      check('the top bar was never used', q.quick.length === quickBefore && q.input.length === inputBefore)
      ext._test.setAsker(queueAsker)
    }

    console.log('\n-- 1.4: chat pins --')
    check('every chat Claude Code starts here can find the pins', process.env[chatPinsLib.ENV] === chatPinsLib.wrapperFile(TEST_ROOT))
    const wrapperFile = path.join(TEST_ROOT, 'bin', chatPinsLib.wrapperName())
    check('the wrapper is installed in the switcher\'s own folder', fs.existsSync(wrapperFile))
    check('and Claude Code\'s wrapper setting stays off while nothing is pinned', !settings.claudeCode.claudeProcessWrapper)
    const CHAT = '6b8cbf67-1111-4222-8333-944455556666'
    const projDir = path.join(CLAUDE_DIR, 'projects', chatPinsLib.projectSlug(FOLDER14))
    fs.mkdirSync(projDir, { recursive: true })
    fs.writeFileSync(path.join(projDir, CHAT + '.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the login tests', sessionId: CHAT }) + '\n')
    executed.length = 0
    const longTitle = 'CLAUDE_CONFIG_DIR environment variable'
    fs.writeFileSync(path.join(projDir, CHAT + '.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: longTitle, sessionId: CHAT }) + '\n')
    const closedTabs = []
    const chatTab = { label: 'CLAUDE_CONFIG_DIR enviro\u2026', input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } }
    const otherTab = { label: 'CLAUDE_CONFIG_DIR', input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } }
    vscode.window.tabGroups = { all: [{ tabs: [chatTab, otherTab] }], close: async (tabs) => { closedTabs.push(...tabs) } }
    const pinRecFile = (n) => path.join(CLAUDE_DIR, 'sessions', 'pins-' + (n || 1) + '.json')
    const liveRec = (id, status, n, extra) => { fs.mkdirSync(path.dirname(pinRecFile(n)), { recursive: true }); fs.writeFileSync(pinRecFile(n), JSON.stringify({ pid: process.pid, sessionId: id, status, statusUpdatedAt: Date.now(), ...(extra || {}) })) }
    const endRec = (n) => fs.rmSync(pinRecFile(n), { force: true })
    liveRec(CHAT, 'idle')
    await loginsLib.remove(TEST_ROOT, 'dana')
    signinQ.push({ email: 'dana@example.com', uuid: 'uuid-d', rt: 'RT-D8', days: 33.5 })
    q.quick.push(longTitle); q.quick.push('dana'); q.warn.push({ value: 'Continue' }); q.info.push('Cancel')
    await registered['claudeswitcher.pinChat']()
    check('a chat pinned to an account with no pinning login adds one first', loginsLib.hasLogin(TEST_ROOT, 'dana'))
    check('nothing is pinned until the user confirms (Cancel pins nothing)', chatPinsLib.read(TEST_ROOT).length === 0 && closedTabs.length === 0)
    const askedBefore = messages.length
    q.quick.push(longTitle); q.quick.push('dana'); q.info.push('Pin and reopen')
    await registered['claudeswitcher.pinChat']()
    check('an open chat is offered "Pin and reopen"', messages.slice(askedBefore).some((m) => m.includes('Pin "' + longTitle + '" to')))
    check('the question says it uses a separate login', messages.slice(askedBefore).some((m) =>
      m.includes('Pin "' + longTitle + '" to') && m.includes('pinning login, a separate login')))
    check('its tab is found by Claude Code\'s shortened title, and only that one is closed',
      closedTabs.length === 1 && closedTabs[0] === chatTab, JSON.stringify(closedTabs.map((t) => t.label)))
    delete vscode.window.tabGroups
    endRec()
    const pinned = chatPinsLib.read(TEST_ROOT)
    check('Pin Chat lists the folder\'s chats and pins the one picked', pinned.length === 1 && pinned[0].id === CHAT && pinned[0].name === 'dana')
    check('the wrapper\'s list has the chat, so it starts on dana\'s pinning login',
      wrapperList().split('\n').some((l) => l === 'chat\t' + CHAT + '\tdana' || l === 'chat\t' + CHAT + '\tdana\r'))
    check('Claude Code\'s wrapper setting is turned on, pointing at the installed wrapper', chatPinsLib.samePath(settings.claudeCode.claudeProcessWrapper, wrapperFile))
    check('then opens the chat again, so it starts on the pinned account', executed.some((e) => e.id === 'claude-vscode.editor.open' && e.args[0] === CHAT))
    const chatRows = ext._test.pageState().chatPins
    check('the page lists the pinned chat', chatRows.length === 1 && chatRows[0].title === longTitle && chatRows[0].name === 'dana')
    q.info.push('Unpin')
    await ext._test.onPageMessage({ type: 'unpinChat', id: CHAT })
    check('Unpin on the page removes it', chatPinsLib.read(TEST_ROOT).length === 0)
    check('and with nothing pinned the wrapper setting is turned off', !settings.claudeCode.claudeProcessWrapper)
    settings.claudeCode.claudeProcessWrapper = 'C:\\tools\\their-wrapper.exe'
    q.quick.push(longTitle); q.quick.push('dana'); q.info.push('Pin')
    await registered['claudeswitcher.pinChat']()
    check('someone else\'s wrapper is never replaced, and the pin isn\'t kept', settings.claudeCode.claudeProcessWrapper === 'C:\\tools\\their-wrapper.exe' &&
      chatPinsLib.read(TEST_ROOT).length === 0 && messages.some((m) => m.includes('already set to another program')))
    delete settings.claudeCode.claudeProcessWrapper
    await ext._test.onPageMessage({ type: 'unpinChat', id: '../../not-an-id' })
    check('the page can only unpin real chat ids', true)

    console.log('\n-- a short chat with no title yet: its first prompt is its title, as on its tab --')
    const HI = '7c9dd078-2222-4333-8444-a55566667777'
    const hiFile = path.join(projDir, HI + '.jsonl')
    fs.writeFileSync(hiFile, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, sessionId: HI }) + '\n')
    const newest = new Date(Date.now() + 60000)
    fs.utimesSync(hiFile, newest, newest)
    const hiTab = { label: 'hi', input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } }
    const closedHi = []
    vscode.window.tabGroups = { all: [{ tabs: [hiTab] }], close: async (tabs) => { closedHi.push(...tabs) } }
    liveRec(HI, 'idle', 2)
    executed.length = 0
    let askedHi = messages.length
    q.quick.push('hi'); q.quick.push('dana'); q.info.push('Pin and reopen')
    await registered['claudeswitcher.pinChat']()
    check('the question names it by its first prompt', messages.slice(askedHi).some((m) => m.includes('Pin "hi" to')), messages.slice(askedHi).join(' / '))
    check('its open tab is found and closed, and the chat reopened', closedHi.length === 1 && closedHi[0] === hiTab &&
      executed.some((e) => e.id === 'claude-vscode.editor.open' && e.args[0] === HI))
    q.info.push('Unpin and reopen')
    await ext._test.onPageMessage({ type: 'unpinChat', id: HI })
    check('unpinned from the page', !chatPinsLib.read(TEST_ROOT).some((p) => p.id === HI))
    vscode.window.tabGroups = { all: [{ tabs: [hiTab, { label: 'hi', input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } }] }], close: async (tabs) => { closedHi.push(...tabs) } }
    closedHi.length = 0
    executed.length = 0
    askedHi = messages.length
    q.quick.push('hi'); q.quick.push('dana'); q.info.push('Pin and reopen')
    await registered['claudeswitcher.pinChat']()
    check('two open chats with that title: "Pin and reopen" is not offered', !chatPinsLib.read(TEST_ROOT).some((p) => p.id === HI && p.name === 'dana') &&
      messages.slice(askedHi).some((m) => m.includes('Pin "hi" to') && m.includes('can\'t be sure which open tab is it')), messages.slice(askedHi).join(' / '))
    askedHi = messages.length
    q.quick.push('hi'); q.quick.push('dana'); q.info.push('Pin')
    await registered['claudeswitcher.pinChat']()
    check('two open chats with that title: no tab is closed, nothing reopened, and it says how to reopen it', closedHi.length === 0 &&
      !executed.some((e) => e.id === 'claude-vscode.editor.open') && messages.slice(askedHi).some((m) => m.includes('"hi" is pinned to') && m.includes('Reopen it by hand')),
      messages.slice(askedHi).join(' / '))
    check('and no "reopened" message', !messages.slice(askedHi).some((m) => m.includes('reopened on it')))
    check('the pin is kept', chatPinsLib.read(TEST_ROOT).some((p) => p.id === HI && p.name === 'dana'))
    fs.appendFileSync(hiFile, JSON.stringify({ type: 'last-prompt', lastPrompt: 'What account are you on?', sessionId: HI }) + '\n')
    const renamedTab = { label: 'What account are you on?', input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } }
    vscode.window.tabGroups = { all: [{ tabs: [hiTab, renamedTab] }], close: async (tabs) => { closedHi.push(...tabs) } }
    closedHi.length = 0
    executed.length = 0
    await ext._test.onPageMessage({ type: 'reopenNow', id: HI })
    check('a chat its latest prompt renamed is found by that name and reopened (not another chat called "hi")',
      closedHi.length === 1 && closedHi[0] === renamedTab && executed.some((e) => e.id === 'claude-vscode.editor.open' && e.args[0] === HI),
      JSON.stringify(closedHi.map((t) => t.label)))
    q.info.push('Unpin and reopen')
    await ext._test.onPageMessage({ type: 'unpinChat', id: HI })
    check('and unpinned again', !chatPinsLib.read(TEST_ROOT).some((p) => p.id === HI))
    delete vscode.window.tabGroups
    endRec(2)
    fs.rmSync(hiFile)

    console.log('\n-- 1.4: moving a pin, a chat that is replying, Reopen now --')
    const SESS = path.join(CLAUDE_DIR, 'sessions')
    fs.mkdirSync(SESS, { recursive: true })
    const busyFile = path.join(SESS, 'busy-1.json')
    const setBusy = (id, on) => { if (on) fs.writeFileSync(busyFile, JSON.stringify({ pid: process.pid, sessionId: id, status: 'busy', statusUpdatedAt: Date.now() })); else fs.rmSync(busyFile, { force: true }) }
    const setIdle = (id) => fs.writeFileSync(busyFile, JSON.stringify({ pid: process.pid, sessionId: id, status: 'idle', statusUpdatedAt: Date.now() }))
    signinQ.push({ email: 'finn@example.com', uuid: 'uuid-f', rt: 'RT-F', days: 30.5 })
    q.quick.push('Sign in to another account'); q.input.push({ value: 'Finn', color: 'green', icon: 'rocket' })
    q.warn.push({ value: 'No thank you', checked: false })
    await registered['claudeswitcher.globalAdd']()
    const finnCard = ext._test.pageState().accounts.find((a) => a.name === 'finn')
    check('a new account takes the look picked before the sign-in', finnCard && finnCard.label === 'Finn' && finnCard.color === 'green' && finnCard.icon === 'rocket',
      JSON.stringify(finnCard && [finnCard.label, finnCard.color, finnCard.icon]))
    check('and the offer is kept on', ext._test.pageState().prefs.askSecondLogin === true)
    givePinning('finn', 'finn@example.com', 'uuid-f', 'RT-FP', 25.5)
    chatPinsLib.set(TEST_ROOT, CHAT, 'dana', longTitle)
    await ext._test.onPageMessage({ type: 'movePin', id: CHAT, to: 'work' })
    check('a pin only moves to an account with a pinning login', chatPinsLib.read(TEST_ROOT)[0].name === 'dana')
    executed.length = 0
    await ext._test.onPageMessage({ type: 'movePin', id: CHAT, to: 'finn' })
    check('Move to finn moves the pin', chatPinsLib.read(TEST_ROOT)[0].name === 'finn')
    check('a chat not open in a tab is not reopened', !executed.some((e) => e.id === 'claude-vscode.editor.open'))
    vscode.window.tabGroups = { all: [{ tabs: [chatTab] }], close: async () => {} }
    setBusy(CHAT, true)
    await ext._test.onPageMessage({ type: 'movePin', id: CHAT, to: 'dana' })
    let row = ext._test.pageState().chatPins.find((p) => p.id === CHAT)
    check('a chat that is replying waits: "Moves to dana when this reply finishes"', row && row.waiting === true && row.name === 'dana')
    check('and is not reopened yet', !executed.some((e) => e.id === 'claude-vscode.editor.open'))
    await ext._test.loginWatch()
    check('the login watch leaves it while it is still replying', ext._test.pageState().chatPins.find((p) => p.id === CHAT).waiting === true)
    setIdle(CHAT)
    await ext._test.fastTick()
    check('once the reply finished, it reopens on its account at the next 5-second check', executed.some((e) => e.id === 'claude-vscode.editor.open' && e.args[0] === CHAT) &&
      ext._test.pageState().chatPins.find((p) => p.id === CHAT).waiting === false)
    executed.length = 0
    setBusy(CHAT, true)
    await ext._test.onPageMessage({ type: 'movePin', id: CHAT, to: 'finn' })
    await ext._test.onPageMessage({ type: 'reopenNow', id: CHAT })
    check('Reopen now reopens at once, mid-reply', executed.some((e) => e.id === 'claude-vscode.editor.open' && e.args[0] === CHAT) &&
      ext._test.pageState().chatPins.find((p) => p.id === CHAT).waiting === false)
    setIdle(CHAT)
    delete vscode.window.tabGroups

    console.log('\n-- 1.5.0: unpinning a chat asks first and reopens it, as pinning does --')
    {
      const pinOf = () => { const p = chatPinsLib.read(TEST_ROOT).find((x) => x.id === CHAT); return p ? p.name : null }
      const opened = () => executed.filter((e) => e.id === 'claude-vscode.editor.open' && e.args[0] === CHAT).length
      const repinFinn = async () => { chatPinsLib.set(TEST_ROOT, CHAT, 'finn', longTitle); await ext._test.syncPins() }
      const activeLabel = store.displayOf(TEST_ROOT, store.getActive(TEST_ROOT)).label
      const closedU = []
      vscode.window.tabGroups = { all: [{ tabs: [chatTab] }], close: async (t) => { closedU.push(...t) } }
      check('(set up: pinned to finn)', pinOf() === 'finn')
      executed.length = 0
      let before = messages.length
      q.info.push('Cancel')
      await ext._test.onPageMessage({ type: 'unpinChat', id: CHAT })
      const asked = messages.slice(before).find((m) => m.includes('Unpin "' + longTitle + '"?'))
      check('Unpin asks first, naming the chat and where it goes back to', !!asked && asked.includes('It goes back to ' + activeLabel), messages.slice(before).join(' / '))
      check('cancel leaves the pin, the tab and the chat alone', pinOf() === 'finn' && closedU.length === 0 && opened() === 0)

      before = messages.length
      q.info.push('Unpin and reopen')
      await ext._test.onPageMessage({ type: 'unpinChat', id: CHAT })
      check('its tab is open here: "Unpin and reopen", unpinned, its tab closed and the chat reopened',
        pinOf() === null && closedU.length === 1 && closedU[0] === chatTab && opened() === 1)
      check('and it says it reopened on the active account', messages.slice(before).some((m) => m.includes('is unpinned and reopened on ' + activeLabel)),
        messages.slice(before).join(' / '))
      check('the wrapper\'s list no longer has it', !wrapperList().split(/\r?\n/).includes('chat\t' + CHAT + '\tfinn'))

      await repinFinn()
      executed.length = 0; closedU.length = 0
      setBusy(CHAT, true)
      before = messages.length
      q.info.push('Unpin and reopen')
      await ext._test.onPageMessage({ type: 'unpinChat', id: CHAT })
      check('a chat that is replying is unpinned at once, but not reopened mid-reply', pinOf() === null && opened() === 0 && closedU.length === 0)
      check('it says it reopens when the reply finishes, and offers Reopen now', messages.slice(before).some((m) => m.includes('reopens on ' + activeLabel + ' when this reply finishes')),
        messages.slice(before).join(' / '))
      await ext._test.fastTick()
      check('still replying: still not reopened', opened() === 0)
      setIdle(CHAT)
      before = messages.length
      await ext._test.fastTick()
      check('once the reply finished, it reopens on the active account', opened() === 1 && closedU.length === 1 &&
        messages.slice(before).some((m) => m.includes('finished its reply and reopened on ' + activeLabel)), messages.slice(before).join(' / '))

      delete vscode.window.tabGroups
      setBusy(CHAT, false)
      await repinFinn()
      executed.length = 0
      before = messages.length
      q.info.push('Unpin')
      await ext._test.onPageMessage({ type: 'unpinChat', id: CHAT })
      check('its tab isn\'t open here: "Unpin", and nothing is reopened', pinOf() === null && opened() === 0 &&
        messages.slice(before).some((m) => m.includes('Unpin "' + longTitle + '"?') && m.includes('the next time you open it')))
      check('it says where it opens next time', messages.slice(before).some((m) => m.includes('is unpinned. It opens on ' + activeLabel + ' the next time')))

      await repinFinn()
      q.quick.push(longTitle); q.quick.push('Unpin this chat'); q.info.push('Cancel')
      await registered['claudeswitcher.pinChat']()
      check('the pin picker\'s Unpin this chat asks too, and cancel keeps the pin', pinOf() === 'finn')
      q.quick.push(longTitle); q.quick.push('Unpin this chat'); q.info.push('Unpin')
      await registered['claudeswitcher.pinChat']()
      check('confirmed, it unpins', pinOf() === null)

      const OTHER = '6b8cbf67-9999-4aaa-8bbb-dddddddddddd'
      const sameTab = { label: chatTab.label, input: chatTab.input }
      await repinFinn()
      vscode.window.tabGroups = { all: [{ tabs: [sameTab] }], close: async (t) => { closedU.push(...t) } }
      liveRec(OTHER, 'busy', 3, { name: longTitle + ' (branch)' })
      executed.length = 0; closedU.length = 0
      before = messages.length
      q.info.push('Unpin and reopen')
      await ext._test.onPageMessage({ type: 'unpinChat', id: CHAT })
      check('S1: the pinned chat isn\'t running and another chat\'s tab shows its name: "Unpin and reopen" is not offered',
        pinOf() === 'finn' && messages.slice(before).some((m) => m.includes('Unpin "' + longTitle + '"?') && m.includes('the next time you open it')),
        messages.slice(before).join(' / '))
      q.info.push('Unpin')
      await ext._test.onPageMessage({ type: 'unpinChat', id: CHAT })
      check('S1: unpinned, the other chat\'s tab never closed, nothing reopened', pinOf() === null && closedU.length === 0 &&
        !executed.some((e) => e.id === 'claude-vscode.editor.open'))
      await repinFinn()
      setIdle(CHAT)
      executed.length = 0; closedU.length = 0
      before = messages.length
      q.info.push('Unpin')
      await ext._test.onPageMessage({ type: 'unpinChat', id: CHAT })
      check('S1: a second running chat with the same name: asked with "Unpin", not sure which tab is it',
        messages.slice(before).some((m) => m.includes('Unpin "' + longTitle + '"?') && m.includes('can\'t be sure which open tab is it')), messages.slice(before).join(' / '))
      check('S1: unpinned, no tab closed, nothing reopened, and it says to reopen it by hand, in the phone\'s words', pinOf() === null && closedU.length === 0 &&
        opened() === 0 && messages.slice(before).some((m) => m.includes('is unpinned, but VS Code couldn\'t be sure which open tab is it') && m.includes('Reopen it by hand')),
        messages.slice(before).join(' / '))
      endRec(3)
      await repinFinn()
      vscode.window.tabGroups = { all: [{ tabs: [chatTab, sameTab] }], close: async (t) => { closedU.push(...t) } }
      executed.length = 0; closedU.length = 0
      before = messages.length
      q.info.push('Unpin')
      await ext._test.onPageMessage({ type: 'unpinChat', id: CHAT })
      check('S1: two open tabs with its name: unpinned, neither closed, nothing reopened', pinOf() === null && closedU.length === 0 && opened() === 0 &&
        messages.slice(before).some((m) => m.includes('Reopen it by hand')), messages.slice(before).join(' / '))
      delete vscode.window.tabGroups
      await repinFinn()
      before = messages.length
      q.info.push('Unpin')
      await ext._test.onPageMessage({ type: 'unpinChat', id: CHAT })
      check('S1: running in another window: the question says it keeps its login until it is reopened', pinOf() === null &&
        messages.slice(before).some((m) => m.includes('not in a tab here') && m.includes('until you reopen it')), messages.slice(before).join(' / '))
      setBusy(CHAT, false)
    }

    console.log('\n-- 1.5: pin and unpin a chat from the phone --')
    {
      const reqLib = require('../lib/requests.js')
      const reqDir = reqLib.dir(TEST_ROOT)
      const reqFiles = () => { try { return fs.readdirSync(reqDir).sort() } catch { return [] } }
      const pinOf = () => { const p = chatPinsLib.read(TEST_ROOT).find((x) => x.id === CHAT); return p ? p.name : null }
      const opened = () => executed.filter((e) => e.id === 'claude-vscode.editor.open' && e.args[0] === CHAT).length
      const backdate = (id, ms) => {
        const f = reqLib.requestFile(TEST_ROOT, id)
        const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.at = Date.now() - ms; fs.writeFileSync(f, JSON.stringify(j))
      }
      const closed = []
      const reqTabs = (tabs) => { vscode.window.tabGroups = { all: [{ tabs }], close: async (t) => { closed.push(...t) } } }
      const recFile = (n) => path.join(SESS, 'phone-' + n + '.json')
      const setRec = (id, status, extra, n) => fs.writeFileSync(recFile(n || 1), JSON.stringify({ pid: process.pid, sessionId: id, status, statusUpdatedAt: Date.now(), ...(extra || {}) }))
      const dropRec = (n) => fs.rmSync(recFile(n || 1), { force: true })
      const activeLabel = store.displayOf(TEST_ROOT, store.getActive(TEST_ROOT)).label
      chatPinsLib.remove(TEST_ROOT, CHAT)
      await ext._test.syncPins()

      reqTabs([chatTab])
      setRec(CHAT, 'idle')
      executed.length = 0
      let before = messages.length
      let rq = reqLib.submit(TEST_ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'dana', device: 'Phone' })
      check('the phone\'s request is accepted', rq.ok === true, JSON.stringify(rq))
      await ext._test.requestsTick()
      let res = reqLib.result(TEST_ROOT, rq.id)
      check('a request for a chat whose tab is open here is taken at once; idle, it is pinned and reopened',
        res && res.ok === true && res.state === 'reopened' && pinOf() === 'dana' && opened() === 1, JSON.stringify(res))
      check('the result says so in plain words', res && res.text.includes('"' + longTitle + '" is pinned to') && res.text.includes('reopened on it'), res && res.text)
      check('the wrapper\'s list has the pin', wrapperList().split(/\r?\n/).includes('chat\t' + CHAT + '\tdana'))
      check('the window tells the user it came from the phone', messages.slice(before).some((m) => m.includes('Pinned "' + longTitle + '" to') && m.includes('from your phone.')),
        messages.slice(before).join(' / '))
      check('the request and its claim are gone, only the result is left', reqFiles().filter((f) => !f.startsWith('.alive-')).join() === rq.id + '.result.json', reqFiles().join())

      executed.length = 0
      setRec(CHAT, 'busy')
      rq = reqLib.submit(TEST_ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'finn' })
      await ext._test.requestsTick()
      res = reqLib.result(TEST_ROOT, rq.id)
      check('a chat that is replying: "waiting", pin written, not reopened yet', res && res.state === 'waiting' && pinOf() === 'finn' && opened() === 0, JSON.stringify(res))
      check('the page shows it waiting', ext._test.pageState().chatPins.find((p) => p.id === CHAT).waiting === true)
      setRec(CHAT, 'idle')
      await ext._test.fastTick()
      check('once the reply finished, it reopens on its new account', opened() === 1 && ext._test.pageState().chatPins.find((p) => p.id === CHAT).waiting === false)
      check('the 5-second tick leaves this window\'s heartbeat for the hub', reqLib.alive(TEST_ROOT).some((w) => w.pid === process.pid))

      executed.length = 0
      closed.length = 0
      setRec(CHAT, 'waiting', { waitingFor: 'approve Edit' })
      rq = reqLib.submit(TEST_ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'dana' })
      await ext._test.requestsTick()
      res = reqLib.result(TEST_ROOT, rq.id)
      check('a chat waiting on an approval counts as busy: "waiting", its tab not closed', res && res.state === 'waiting' && pinOf() === 'dana' && opened() === 0 && closed.length === 0,
        JSON.stringify(res))
      await ext._test.fastTick()
      check('and it is still not reopened while the approval waits', opened() === 0 && closed.length === 0)
      setRec(CHAT, 'idle')
      await ext._test.fastTick()
      check('once answered and idle, it reopens', opened() === 1 && closed.length === 1)
      executed.length = 0
      closed.length = 0
      setRec(CHAT, 'waiting', { waitingFor: 'input needed' })
      rq = reqLib.submit(TEST_ROOT, { kind: 'unpinChat', sessionId: CHAT })
      await ext._test.requestsTick()
      res = reqLib.result(TEST_ROOT, rq.id)
      check('unpin of a chat waiting on a question: unpinned, reopened only when it finishes', res && res.state === 'unpinned' && pinOf() === null && opened() === 0 &&
        closed.length === 0 && res.text.includes('when its current reply finishes'), JSON.stringify(res))
      setRec(CHAT, 'idle')
      await ext._test.fastTick()
      check('and then it reopens', opened() === 1 && closed.length === 1)
      rq = reqLib.submit(TEST_ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'finn' })
      await ext._test.requestsTick()
      check('(pinned to finn again for what follows)', pinOf() === 'finn' && reqLib.result(TEST_ROOT, rq.id).state === 'reopened')

      executed.length = 0
      closed.length = 0
      setRec(CHAT, 'idle')
      setRec('6b8cbf67-9999-4aaa-8bbb-cccccccccccc', 'busy', { name: 'CLAUDE_CONFIG_DIR enviro and the made-up rest' }, 2)
      rq = reqLib.submit(TEST_ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'dana' })
      await ext._test.requestsTick()
      check('a tab another running chat\'s name also matches is not taken as this chat\'s', reqLib.result(TEST_ROOT, rq.id) === null && closed.length === 0)
      backdate(rq.id, reqLib.CLAIM_ANY_MS + 1000)
      await ext._test.requestsTick()
      res = reqLib.result(TEST_ROOT, rq.id)
      check('after 10 seconds it is pinned, not reopened: "needs-reopen", the other chat\'s tab never closed',
        res && res.state === 'needs-reopen' && pinOf() === 'dana' && opened() === 0 && closed.length === 0 && res.text.includes('Reopen it by hand'), JSON.stringify(res))
      setRec('6b8cbf67-9999-4aaa-8bbb-cccccccccccc', 'idle', { name: 'CLAUDE_CONFIG_DIR enviro and the made-up rest' }, 2)
      rq = reqLib.submit(TEST_ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'finn' })
      backdate(rq.id, reqLib.CLAIM_ANY_MS + 1000)
      await ext._test.requestsTick()
      res = reqLib.result(TEST_ROOT, rq.id)
      check('the same with the other chat idle: still not closed', res && res.state === 'needs-reopen' && opened() === 0 && closed.length === 0, JSON.stringify(res))
      dropRec(2)

      executed.length = 0
      reqTabs([chatTab, { label: chatTab.label, input: chatTab.input }])
      rq = reqLib.submit(TEST_ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'dana' })
      await ext._test.requestsTick()
      check('two open tabs share its title: not sure which is it, so not taken at once', reqLib.result(TEST_ROOT, rq.id) === null)
      backdate(rq.id, reqLib.CLAIM_ANY_MS + 1000)
      await ext._test.requestsTick()
      res = reqLib.result(TEST_ROOT, rq.id)
      check('after 10 seconds: "needs-reopen", pinned, reopened by hand', res && res.state === 'needs-reopen' && pinOf() === 'dana' && opened() === 0 &&
        res.text.includes('Reopen it by hand'), JSON.stringify(res))

      delete vscode.window.tabGroups
      executed.length = 0
      chatPinsLib.remove(TEST_ROOT, CHAT)
      rq = reqLib.submit(TEST_ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'dana' })
      backdate(rq.id, reqLib.CLAIM_ANY_MS + 1000)
      await ext._test.requestsTick()
      res = reqLib.result(TEST_ROOT, rq.id)
      check('running but shown in no tab here: after 10 seconds pinned, "needs-reopen"', res && res.state === 'needs-reopen' && pinOf() === 'dana' && opened() === 0, JSON.stringify(res))

      dropRec()
      rq = reqLib.submit(TEST_ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'finn' })
      await ext._test.requestsTick()
      check('a chat no tab here shows is left alone at first', reqLib.result(TEST_ROOT, rq.id) === null && fs.existsSync(reqLib.requestFile(TEST_ROOT, rq.id)) && pinOf() === 'dana')
      backdate(rq.id, reqLib.CLAIM_ANY_MS + 1000)
      await ext._test.requestsTick()
      res = reqLib.result(TEST_ROOT, rq.id)
      check('after 10 seconds unclaimed, this window takes it: "pinned", no reopen', res && res.state === 'pinned' && pinOf() === 'finn' && opened() === 0, JSON.stringify(res))
      check('and the phone is told it moves the next time it opens', res && res.text.includes('the next time it opens'), res && res.text)

      reqTabs([chatTab])
      rq = reqLib.submit(TEST_ROOT, { kind: 'unpinChat', sessionId: CHAT })
      const other = process.ppid
      check('another window claims it first (the rename only one can win)', !!reqLib.claim(TEST_ROOT, rq.id, other) && !reqLib.claim(TEST_ROOT, rq.id, process.pid))
      await ext._test.requestsTick()
      check('so this window does nothing with it', pinOf() === 'finn' && reqLib.result(TEST_ROOT, rq.id) === null && opened() === 0)
      fs.rmSync(reqLib.claimFile(TEST_ROOT, rq.id, other), { force: true })

      setRec(CHAT, 'idle')
      rq = reqLib.submit(TEST_ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'dana' })
      await Promise.all([ext._test.requestsTick(), ext._test.requestsTick()])
      check('two checks at once handle it once', opened() === 1 && reqLib.result(TEST_ROOT, rq.id).state === 'reopened')

      executed.length = 0
      before = messages.length
      rq = reqLib.submit(TEST_ROOT, { kind: 'unpinChat', sessionId: CHAT })
      await ext._test.requestsTick()
      res = reqLib.result(TEST_ROOT, rq.id)
      check('Unpin from the phone: unpinned and reopened', res && res.ok === true && res.state === 'unpinned' && pinOf() === null && opened() === 1 &&
        res.text.includes('reopened on ' + activeLabel + '.'), JSON.stringify(res))
      check('and the window says "Unpinned ... from your phone."', messages.slice(before).some((m) => m.includes('Unpinned "' + longTitle + '" from your phone.')))
      check('the wrapper\'s list drops it', !wrapperList().includes(CHAT))
      rq = reqLib.submit(TEST_ROOT, { kind: 'unpinChat', sessionId: CHAT })
      await ext._test.requestsTick()
      res = reqLib.result(TEST_ROOT, rq.id)
      check('Unpin of a chat that isn\'t pinned says so', res && res.ok === true && res.text.includes('wasn\'t pinned'), JSON.stringify(res))

      const seven = []
      for (let i = 0; i < 7; i++) seven.push(reqLib.submit(TEST_ROOT, { kind: 'unpinChat', sessionId: CHAT }).id)
      await ext._test.requestsTick()
      const answered = () => seven.filter((id) => reqLib.result(TEST_ROOT, id)).length
      check('seven requests at once: five are handled in one tick', answered() === 5, String(answered()))
      await ext._test.requestsTick()
      check('and the other two at the next', answered() === 7, String(answered()))

      const madeUpFolder = path.join(TEST_ROOT, 'made-up-project')
      store.setPin(TEST_ROOT, madeUpFolder, 'finn')
      setRec(CHAT, 'idle', { cwd: madeUpFolder })
      rq = reqLib.submit(TEST_ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'dana' })
      await ext._test.requestsTick()
      executed.length = 0
      rq = reqLib.submit(TEST_ROOT, { kind: 'unpinChat', sessionId: CHAT })
      await ext._test.requestsTick()
      res = reqLib.result(TEST_ROOT, rq.id)
      const finnLabel = store.displayOf(TEST_ROOT, 'finn').label
      check('unpin in a pinned folder names the folder\'s account it reopens on', res && res.state === 'unpinned' && opened() === 1 &&
        res.text.includes('reopened on ' + finnLabel + ' (its folder\'s account)'), JSON.stringify(res))
      check('and the account it falls back to is the folder\'s', ext._test.fallbackAccount(CHAT).name === 'finn')
      store.setPin(TEST_ROOT, madeUpFolder, null)
      await ext._test.syncPins()
      check('without the folder pin it is the active account', ext._test.fallbackAccount(CHAT).name === store.getActive(TEST_ROOT))
      setRec(CHAT, 'idle')

      executed.length = 0
      const refused = reqLib.submit(TEST_ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'work' })
      check('submit refuses an account with no pinning login', refused.ok === false && refused.reason === 'no-pinning-login', JSON.stringify(refused))
      const badId = 'abcdef0123456789'
      fs.writeFileSync(reqLib.requestFile(TEST_ROOT, badId), JSON.stringify({ v: 1, id: badId, kind: 'pinChat', sessionId: CHAT, account: 'nobody', from: 'hub', at: Date.now() }))
      await ext._test.requestsTick()
      res = reqLib.result(TEST_ROOT, badId)
      check('a request for an account that isn\'t saved is answered ok:false, and nothing is pinned', res && res.ok === false && pinOf() === null && opened() === 0 &&
        res.text.includes('no saved account'), JSON.stringify(res))

      delete vscode.window.tabGroups
      rq = reqLib.submit(TEST_ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'dana' })
      backdate(rq.id, reqLib.EXPIRE_MS + 1000)
      reqLib.sweep(TEST_ROOT)
      await ext._test.requestsTick()
      res = reqLib.result(TEST_ROOT, rq.id)
      check('an expired request is answered "expired" and never acted on', res && res.ok === false && res.state === 'expired' && pinOf() === null, JSON.stringify(res))
      dropRec()
      fs.rmSync(reqDir, { recursive: true, force: true })
    }
    chatPinsLib.remove(TEST_ROOT, CHAT)

    console.log('\n-- 1.4: Sign in again on the card --')
    signinQ.push({ email: 'finn@example.com', uuid: 'uuid-f', rt: 'RT-F2', days: 0.5 })
    await ext._test.onPageMessage({ type: 'relogin', name: 'finn' })
    si = signins[signins.length - 1]
    check('Sign in again fills in the account\'s email', si.o.email === 'finn@example.com')
    check('the new login is main', Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'finn').loginExpiresAt) - 0.5) < 0.1)
    check('the previous main went to pinning, as it lasts longer', Math.abs(daysOf(loginsLib.readMeta(TEST_ROOT, 'finn').expiresAt) - 30.5) < 0.1)
    check('and the notice says so', messages.some((m) => /^INFO: Finn is signed in again\..*previous login now keeps its pinned chats/.test(m)))
    signinQ.push({ email: 'zed@example.com', uuid: 'uuid-z', rt: 'RT-Z', days: 30 })
    q.warn.push(undefined)
    await ext._test.onPageMessage({ type: 'relogin', name: 'finn' })
    check('signing in as someone else changes nothing, and says so', messages.some((m) => m.startsWith('WARN: That\'s a different account')) &&
      !profiles.exists(TEST_ROOT, 'zed') && Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'finn').loginExpiresAt) - 0.5) < 0.1)
    check('no sign-in folder is left behind', !fs.readdirSync(path.join(TEST_ROOT, 'accounts')).some((n) => n.startsWith('.signin-')))
    signinQ.push({ email: 'yan@example.com', uuid: 'uuid-y', rt: 'RT-Y', days: 30.5 })
    q.warn.push({ value: 'Add it as its own account' }, { value: 'Done' })
    await ext._test.onPageMessage({ type: 'relogin', name: 'finn' })
    check('Sign in again as an account not saved: "Add it as its own account" adds it', profiles.exists(TEST_ROOT, 'yan') &&
      Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'finn').loginExpiresAt) - 0.5) < 0.1)
    check('and leaves no sign-in folder', !fs.readdirSync(path.join(TEST_ROOT, 'accounts')).some((n) => n.startsWith('.signin-')))
    q.warn.length = 0
    profiles.remove(TEST_ROOT, 'yan')

    console.log('\n-- 1.4: the last-day exchange --')
    store.setPin(TEST_ROOT, OTHER, 'finn')
    const INUSE = loginsLib.inUseDir(TEST_ROOT)
    fs.mkdirSync(INUSE, { recursive: true })
    fs.writeFileSync(path.join(INUSE, process.pid + '.json'), JSON.stringify({ pid: process.pid, name: 'finn', sessionId: 'chat-on-finn' }))
    setBusy('chat-on-finn', true)
    await ext._test.loginWatch()
    check('no exchange while a chat on the account is replying', Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'finn').loginExpiresAt) - 0.5) < 0.1)
    setBusy('chat-on-finn', false)
    fs.rmSync(path.join(INUSE, process.pid + '.json'), { force: true })
    q.info.push('Not now')
    await ext._test.loginWatch()
    await tick()
    check('then the logins swap: main has the long one', Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'finn').loginExpiresAt) - 30.5) < 0.1)
    check('and pinning the short one', Math.abs(daysOf(loginsLib.readMeta(TEST_ROOT, 'finn').expiresAt) - 0.5) < 0.1)
    check('with a notice afterwards', messages.some((m) => /^INFO: Finn's main login was on its last day, so it quietly swapped places/.test(m)))
    check('the wrapper list has the new pinning end date', wrapperList().split('\n').some((l) => {
      const [k, n, at] = l.split('\t')
      return k === 'login' && n === 'finn' && Math.abs(daysOf(Number(at)) - 0.5) < 0.1
    }))

    store.setPin(TEST_ROOT, OTHER, null)

    console.log('\n-- 1.4: reminders --')
    givePinning('dana', 'dana@example.com', 'uuid-d', 'RT-D9', 2.5)
    store.setPin(TEST_ROOT, OTHER, 'dana')
    let before = messages.length
    q.info.push('Not now')
    await ext._test.loginWatch()
    await tick()
    const remind = (from) => messages.slice(from).filter((m) => /dana's pinning login ends in 2 days/.test(m))
    check('3 days before a pinning login with pins ends: a reminder', remind(before).length === 1 && remind(before)[0].startsWith('INFO: '))
    before = messages.length
    await ext._test.loginWatch()
    await tick()
    check('Not now: not again the same day', remind(before).length === 0)
    const unsnooze = () => { const st = loginsLib.readReminderState(TEST_ROOT); st.snoozed = {}; loginsLib.writeReminderState(TEST_ROOT, st) }
    unsnooze()
    before = messages.length
    q.info.push('Don\'t ask again')
    await ext._test.loginWatch()
    await tick()
    check('a day later it comes back', remind(before).length === 1)
    unsnooze()
    before = messages.length
    await ext._test.loginWatch()
    await tick()
    check('Don\'t ask again: never again for that login', remind(before).length === 0)
    givePinning('finn', 'finn@example.com', 'uuid-f', 'RT-FP2', 2.5)
    before = messages.length
    await ext._test.loginWatch()
    await tick()
    check('a pinning login with nothing pinned gets no reminder', !messages.slice(before).some((m) => /Finn's pinning login/.test(m)))
    store.setPin(TEST_ROOT, OTHER, null)

    console.log('\n-- 1.4: 1.3 window logins become pinning logins --')
    await loginsLib.remove(TEST_ROOT, 'finn')
    const fwdir = windowsLib.prepare(TEST_ROOT, 'finn')
    fs.writeFileSync(path.join(fwdir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'finn@example.com', accountUuid: 'uuid-f' } }))
    credstore.write(fwdir, { claudeAiOauth: { accessToken: 'AT-EW', refreshToken: 'RT-FW', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: Date.now() + 12.5 * DAY } })
    check('the window folder\'s sessions/ is the shared one (a link)', windowsLib.isLink(path.join(fwdir, 'sessions')))
    const sharedRec = path.join(fs.realpathSync(path.join(fwdir, 'sessions')), process.pid + '.json')
    fs.writeFileSync(sharedRec, JSON.stringify({ pid: process.pid, sessionId: 'x' }))
    fs.mkdirSync(path.join(fwdir, 'ide'), { recursive: true })
    const lockFile = path.join(fwdir, 'ide', '45678.lock')
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, workspaceFolders: [] }))
    await ext._test.startupLogins()
    check('a window login whose window is still open (a live lock in its ide/) is left for later', fs.existsSync(fwdir) && !loginsLib.readMeta(TEST_ROOT, 'finn'))
    fs.rmSync(lockFile, { force: true })
    fs.writeFileSync(path.join(fwdir, 'ide', process.pid + '.lock'), JSON.stringify({ workspaceFolders: [] }))
    await ext._test.startupLogins()
    check('a chat running elsewhere (in the shared sessions) doesn\'t hold it back', !fs.existsSync(fwdir) && !!loginsLib.readMeta(TEST_ROOT, 'finn'))
    fs.rmSync(sharedRec, { force: true })
    const em = loginsLib.readMeta(TEST_ROOT, 'finn')
    check('otherwise it becomes the account\'s pinning login', em && Math.abs(daysOf(em.expiresAt) - 12.5) < 0.1 && loginsLib.hasLogin(TEST_ROOT, 'finn'), JSON.stringify(em))
    check('and its window folder is gone', !fs.existsSync(fwdir))

    console.log('\n-- a sign-in folder still in use is removed once its program has closed --')
    const sdir = path.join(TEST_ROOT, 'accounts', '.signin-harness1')
    fs.mkdirSync(sdir, { recursive: true })
    credstore.write(sdir, { claudeAiOauth: { accessToken: 'AT-SI', refreshToken: 'RT-SI', expiresAt: Date.now() + 3600e3 } })
    const holder = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 900)'], { cwd: sdir, stdio: 'ignore' })
    const holderGone = new Promise((r) => holder.on('exit', r))
    await new Promise((r) => setTimeout(r, 250))
    ext._test.setSigninDropRetryMs([1200, 1500])
    ext._test.dropSigninDir(sdir)
    check('its login goes at once', !credstore.exists(sdir))
    if (process.platform === 'win32') check('on Windows the folder waits while the program runs in it', fs.existsSync(sdir))
    await holderGone
    await new Promise((r) => setTimeout(r, 1500))
    check('and is removed once the program has closed', !fs.existsSync(sdir))
    ext._test.setSigninDropRetryMs(null)

    console.log('\n-- 1.4: Remote Control and Artifacts in pinned chats --')
    const setFile = path.join(TEST_ROOT, 'pinning', 'finn.settings.json')
    await ext._test.onPageMessage({ type: 'remote', name: 'finn', on: false })
    check('Remote Control off writes the pinned chats\' settings file', fs.existsSync(setFile) && readJson(setFile).disableRemoteControl === true)
    await ext._test.onPageMessage({ type: 'artifacts', name: 'finn', on: false })
    check('Artifacts off adds to it', readJson(setFile).enableArtifact === false && readJson(setFile).disableRemoteControl === true)
    check('with the deny rules for publishing to claude.ai', JSON.stringify(readJson(setFile).permissions) === JSON.stringify({ deny: require('../lib/artifacts').DENY }))
    await ext._test.onPageMessage({ type: 'remote', name: 'finn', on: true })
    await ext._test.onPageMessage({ type: 'artifacts', name: 'finn', on: true })
    check('it never turns anything on, and is removed when nothing is off', !fs.existsSync(setFile))
    fs.writeFileSync(path.join(TEST_ROOT, 'pinning', 'gone.settings.json'), '{"disableRemoteControl":true}')
    ext._test.writePinnedSettings('finn')
    check('nothing restricted: still no file', !fs.existsSync(setFile))

    console.log('\n-- 1.4: Check everything --')
    givePinning('finn', 'finn@example.com', 'uuid-f', 'RT-FP3', 0.5)
    const checking = ext._test.checkAll()
    let cAsk = null
    for (let i = 0; i < 300 && !(cAsk && cAsk.spec.done); i++) { await tick(); cAsk = ext._test.openAsks().find((a) => a.spec.kind === 'checks') }
    check('Check everything shows its results in a checks pop-up', cAsk && cAsk.spec.done && cAsk.spec.items.length > 2, cAsk && JSON.stringify(cAsk.spec).slice(0, 300))
    const items = (cAsk && cAsk.spec.items) || []
    check('it has a row for each account\'s main login', ext._test.pageState().accounts.filter((a) => typeof a.loginExpiresAt === 'number').every((a) => items.some((x) => x.label === a.label + ': main login')),
      items.map((x) => x.label + '=' + x.status).join('; '))
    check('the pin wrapper has rows', items.some((x) => /^Pin wrapper: /.test(x.label)))
    const finnRow = items.findIndex((x) => x.label === 'Finn: pinning login')
    check('a pinning login running out has a fix', finnRow >= 0 && items[finnRow].status !== 'ok' && items[finnRow].fix === 'Sign in again',
      finnRow >= 0 ? JSON.stringify(items[finnRow]) : 'no row')
    signinQ.push({ email: 'finn@example.com', uuid: 'uuid-f', rt: 'RT-F3', days: 20.5 })
    q.warn.push({ value: 'Done' })
    if (cAsk) await ext._test.onPageMessage({ type: 'answer', id: cAsk.id, value: 'fix', index: finnRow })
    await checking
    await tick()
    check('its fix signs a pinning login in', Math.abs(daysOf((loginsLib.readMeta(TEST_ROOT, 'finn') || {}).expiresAt) - 20.5) < 0.1)

    console.log('\n-- 1.4: main ended while a chat was replying --')
    store.setPin(TEST_ROOT, OTHER, 'finn')
    profiles.updateCredentials(TEST_ROOT, 'finn', { claudeAiOauth: { accessToken: 'AT-FE', refreshToken: 'RT-FE', expiresAt: Date.now() - 7200e3, refreshTokenExpiresAt: Date.now() - 3600e3 } })
    fs.mkdirSync(INUSE, { recursive: true })
    fs.writeFileSync(path.join(INUSE, process.pid + '.json'), JSON.stringify({ pid: process.pid, name: 'finn', sessionId: 'chat-on-finn2' }))
    setBusy('chat-on-finn2', true)
    before = messages.length
    q.warn.push('Not now')
    await ext._test.loginWatch()
    await tick()
    const endedNotice = (from) => messages.slice(from).filter((m) => /^WARN: Finn's main login has ended\. Its pinning login takes over as soon as no chat on Finn is replying/.test(m))
    check('main ended while a chat replies: a notice that the pinning login takes over when no chat is replying', endedNotice(before).length === 1, messages.slice(before).join(' / '))
    check('one notice, not two: no "main login has ended" reminder as well', !messages.slice(before).some((m) => /Finn's main login has ended\. Sign in again/.test(m)))
    check('nothing swapped yet', loginsLib.hasLogin(TEST_ROOT, 'finn') && Math.abs(daysOf(loginsLib.readMeta(TEST_ROOT, 'finn').expiresAt) - 20.5) < 0.1)
    before = messages.length
    await ext._test.loginWatch()
    await tick()
    check('and it isn\'t said again', endedNotice(before).length === 0 && !messages.slice(before).some((m) => /Finn's main login has ended/.test(m)))
    fs.writeFileSync(busyFile, JSON.stringify({ pid: 99999999, sessionId: 'chat-on-finn2', status: 'busy', statusUpdatedAt: Date.now() }))
    fs.rmSync(path.join(INUSE, process.pid + '.json'), { force: true })
    before = messages.length
    q.info.push('Not now')
    await ext._test.loginWatch()
    await tick()
    check('a "busy" session file whose process has ended doesn\'t hold it up', Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'finn').loginExpiresAt) - 20.5) < 0.1)
    check('it went through the exchange: the ended main is in the pinning slot, marked retired',
      loginsLib.hasLogin(TEST_ROOT, 'finn') && (loginsLib.readMeta(TEST_ROOT, 'finn') || {}).retired === true)
    check('a retired login is no pinning login: the wrapper ignores it', loginsLib.info(TEST_ROOT, 'finn') === null && loginsLib.wrapperLogin(TEST_ROOT, 'finn') === null)
    check('the page shows the account needs a pinning login', !(ext._test.pageState().accounts.find((a) => a.name === 'finn') || {}).pinning)
    check('the notice says so in plain words', messages.slice(before).some((m) => /^INFO: Finn's main login had ended, so its pinning login is now the main login, good for about 20 days\. Finn needs a new pinning login: until you add one/.test(m)),
      messages.slice(before).join(' / '))
    check('no notice about an ended pinning login', !messages.slice(before).some((m) => /Finn's pinning login has ended/.test(m)))
    before = messages.length
    await ext._test.loginWatch()
    await tick()
    check('and no reminder about the retired login later', !messages.slice(before).some((m) => /Finn's (pinning|main) login/.test(m)), messages.slice(before).join(' / '))
    fs.rmSync(busyFile, { force: true })
    store.setPin(TEST_ROOT, OTHER, null)

    console.log('\n-- 1.4: the first-run checklist --')
    await ext._test.onPageMessage({ type: 'checklistDone' })
    check('Done hides it for good', ext._test.pageState().checklist === false)

    console.log('\n-- 1.4: Claude Code\'s own /login --')
    ext._test.setIdentityDelayMs(10)
    await ext._test.loginChangeTick()
    const liveWho = () => (readJson(LIVE_CFG).oauthAccount || {}).emailAddress
    const whoBefore = liveWho()
    const activeBefore = profiles.activeProfile(TEST_ROOT)
    const DANA_PIN = loginsLib.dirFor(TEST_ROOT, 'dana')
    const chatLogin = (dir, email, uuid, rt, days) => {
      nextKeychainSecond()
      credstore.write(dir, { claudeAiOauth: { accessToken: 'AT-' + rt, refreshToken: rt, expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: Date.now() + days * DAY } })
      const cfg = readJson(LIVE_CFG)
      cfg.oauthAccount = { emailAddress: email, accountUuid: uuid, organizationName: 'Acme' }
      fs.writeFileSync(LIVE_CFG, JSON.stringify(cfg))
    }
    givePinning('dana', 'dana@example.com', 'uuid-d', 'RT-DP0', 2.5)
    await ext._test.loginChangeTick()
    before = messages.length
    chatLogin(DANA_PIN, 'dana@example.com', 'uuid-d', 'RT-DP1', 50.5)
    await ext._test.loginChangeTick()
    check('/login in a pinned chat as the same account: the new pinning login is kept',
      Math.abs(daysOf(loginsLib.readMeta(TEST_ROOT, 'dana').expiresAt) - 50.5) < 0.1 && credstore.read(DANA_PIN).claudeAiOauth.refreshToken === 'RT-DP1')
    check('and says so', messages.slice(before).some((m) => /^INFO: A chat pinned to dana signed in to dana again/.test(m)), messages.slice(before).join(' / '))
    check('the account in use is put back in ~/.claude.json', liveWho() === whoBefore && profiles.activeProfile(TEST_ROOT) === activeBefore, liveWho())
    before = messages.length
    await ext._test.loginChangeTick()
    check('looked at once only', messages.length === before)
    store.setPin(TEST_ROOT, OTHER, 'dana')
    await ext._test.syncPins()
    await ext._test.loginChangeTick()
    {
      const m = loginsLib.readMeta(TEST_ROOT, 'dana')
      m.signedInAt = Date.now() - 6 * 3600e3
      fs.writeFileSync(loginsLib.metaFile(TEST_ROOT, 'dana'), JSON.stringify(m))
    }
    const rnMeta = loginsLib.readMeta(TEST_ROOT, 'dana')
    const rnEnd = rnMeta.expiresAt + 37
    const rnIdentity = JSON.stringify(readJson(LIVE_CFG).oauthAccount)
    before = messages.length
    nextKeychainSecond()
    credstore.write(DANA_PIN, { claudeAiOauth: { accessToken: 'AT-DP1r', refreshToken: 'RT-DP1r', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: rnEnd } })
    {
      const cfg = readJson(LIVE_CFG)
      cfg.oauthAccount = { ...cfg.oauthAccount, organizationName: 'Dana Merged Org', displayName: 'Dana' }
      fs.writeFileSync(LIVE_CFG, JSON.stringify(cfg))
    }
    await ext._test.loginChangeTick()
    await tick()
    const rnAfter = loginsLib.readMeta(TEST_ROOT, 'dana') || {}
    check('a pinned chat renewing its pinning login (end 37 ms later) is not a /login: nothing held, nothing asked',
      !loginsLib.foreignOf(TEST_ROOT, 'dana') && !messages.slice(before).some((m) => /^(WARN|INFO):/.test(m)), messages.slice(before).join(' / '))
    check('its meta follows the new end date quietly, signed-in time and the rest unchanged',
      rnAfter.expiresAt === rnEnd && rnAfter.signedInAt === rnMeta.signedInAt && rnAfter.accountUuid === rnMeta.accountUuid && rnAfter.email === rnMeta.email,
      JSON.stringify(rnAfter))
    check('the wrapper\'s list keeps dana\'s login line, with the new end date',
      wrapperList().split('\n').some((l) => { const f = l.split('\t'); return f[0] === 'login' && f[1] === 'dana' && f[2] === String(Math.floor(rnEnd)) }), wrapperList())
    check('the fields the renewal merged into ~/.claude.json are put back to the active account\'s', JSON.stringify(readJson(LIVE_CFG).oauthAccount) === rnIdentity,
      JSON.stringify(readJson(LIVE_CFG).oauthAccount))
    before = messages.length
    await ext._test.loginChangeTick()
    check('and nothing more the next time', messages.length === before && credstore.read(DANA_PIN).claudeAiOauth.refreshToken === 'RT-DP1r')
    store.setPin(TEST_ROOT, OTHER, null)
    await ext._test.syncPins()
    q.warn.push('Add it as its own account', { value: 'Done', text: 'Zed' })
    chatLogin(DANA_PIN, 'zed@example.com', 'uuid-z', 'RT-ZP', 30.5)
    await ext._test.loginChangeTick()
    check('/login in a pinned chat as someone else: it is taken out of dana\'s pinning folder',
      !loginsLib.readMeta(TEST_ROOT, 'dana') && !loginsLib.hasLogin(TEST_ROOT, 'dana'))
    check('with a warning', messages.some((m) => /^WARN: A chat pinned to dana signed in as zed@example.com, which isn't dana/.test(m)))
    check('"Add it as its own account" adds it', profiles.exists(TEST_ROOT, 'zed') && ext._test.pageState().accounts.some((a) => a.name === 'zed' && a.label === 'Zed'))
    check('dana now needs a pinning login', (ext._test.pageState().accounts.find((a) => a.name === 'dana') || {}).pinning === null)
    check('the account in use is put back again', liveWho() === whoBefore, liveWho())
    check('no sign-in folder is left over', !fs.readdirSync(path.join(TEST_ROOT, 'accounts')).some((n) => n.startsWith('.signin-')))

    const M1CHAT = '6b8cbf67-2222-4333-8444-955566667777'
    const m1Title = 'Refactor the billing module'
    givePinning('dana', 'dana@example.com', 'uuid-d', 'RT-DP3', 20.5)
    store.setPin(TEST_ROOT, OTHER, 'dana')
    chatPinsLib.set(TEST_ROOT, M1CHAT, 'dana', m1Title)
    await ext._test.syncPins()
    await ext._test.loginChangeTick()
    const danaLine = () => wrapperList().split('\n').some((l) => l.split('\t')[0] === 'login' && l.split('\t')[1] === 'dana')
    check('(before: the wrapper list has dana\'s login line)', danaLine())
    fs.mkdirSync(INUSE, { recursive: true })
    fs.writeFileSync(path.join(INUSE, process.pid + '.json'), JSON.stringify({ pid: process.pid, name: 'dana', sessionId: M1CHAT }))
    vscode.window.tabGroups = { all: [{ tabs: [{ label: m1Title, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } }] }], close: async () => {} }
    setBusy(M1CHAT, true)
    executed.length = 0
    before = messages.length
    q.warn.push('Discard it')
    chatLogin(DANA_PIN, 'zed@example.com', 'uuid-z', 'RT-ZP2', 30.5)
    await ext._test.loginChangeTick()
    await tick()
    check('another account\'s /login: the login is not moved while its chat runs', credstore.read(DANA_PIN).claudeAiOauth.refreshToken === 'RT-ZP2')
    check('but it is no pinning login: dana\'s login line is out of the wrapper list at once', !danaLine(), wrapperList())
    check('and dana needs a pinning login', (ext._test.pageState().accounts.find((a) => a.name === 'dana') || {}).pinning === null)
    check('the chat on it waits for its reply: "reopens on the active account when this reply finishes"',
      messages.slice(before).some((m) => /^INFO: "Refactor the billing module" runs on a login that isn't dana's, so it reopens on the active account when this reply finishes/.test(m)) &&
      !executed.some((e) => e.id === 'claude-vscode.editor.open'), messages.slice(before).join(' / '))
    check('the choice waits for it', ext._test.takeoutsPending().includes('dana'))
    await ext._test.fastTick()
    check('still replying: nothing moves', credstore.read(DANA_PIN).claudeAiOauth.refreshToken === 'RT-ZP2' && !executed.some((e) => e.id === 'claude-vscode.editor.open'))
    credstore.write(DANA_PIN, { claudeAiOauth: { accessToken: 'AT-x', refreshToken: 'RT-ZP2b', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: credstore.read(DANA_PIN).claudeAiOauth.refreshTokenExpiresAt } })
    before = messages.length
    await ext._test.loginChangeTick()
    check('its chat renewing it is not a new /login', messages.length === before && !danaLine())
    const heldEnd = loginsLib.foreignOf(TEST_ROOT, 'dana').expiresAt
    nextKeychainSecond()
    credstore.write(DANA_PIN, { claudeAiOauth: { accessToken: 'AT-y', refreshToken: 'RT-ZP2c', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: heldEnd + 25 } })
    {
      const cfg = readJson(LIVE_CFG)
      cfg.oauthAccount = { ...cfg.oauthAccount }
      fs.writeFileSync(LIVE_CFG, JSON.stringify(cfg))
    }
    before = messages.length
    await ext._test.loginChangeTick()
    await tick()
    check('its chat renewing it with an end date a few ms later: still held, no new question, its end date followed',
      messages.slice(before).filter((m) => /^(WARN|INFO):/.test(m)).length === 0 && !danaLine() && (loginsLib.foreignOf(TEST_ROOT, 'dana') || {}).expiresAt === heldEnd + 25,
      messages.slice(before).join(' / '))
    setBusy(M1CHAT, false)
    await ext._test.fastTick()
    check('the reply finished: the chat reopens (on the active account)', executed.some((e) => e.id === 'claude-vscode.editor.open' && e.args[0] === M1CHAT))
    check('while its old process runs, the login stays', credstore.read(DANA_PIN) && credstore.read(DANA_PIN).claudeAiOauth.refreshToken === 'RT-ZP2c')
    fs.rmSync(path.join(INUSE, process.pid + '.json'), { force: true })
    await ext._test.fastTick()
    await tick()
    check('then "Discard it" deletes it', !loginsLib.hasLogin(TEST_ROOT, 'dana') && !loginsLib.readMeta(TEST_ROOT, 'dana') && !ext._test.takeoutsPending().includes('dana'))
    q.info.length = 0
    delete vscode.window.tabGroups
    chatPinsLib.remove(TEST_ROOT, M1CHAT)

    const activeNow = profiles.activeProfile(TEST_ROOT)
    const activeWho = profiles.savedWho(TEST_ROOT, activeNow)
    givePinning('dana', 'dana@example.com', 'uuid-d', 'RT-DP4', 20.5)
    await ext._test.loginChangeTick()
    before = messages.length
    q.warn.push(undefined)
    chatLogin(DANA_PIN, activeWho.email, activeWho.accountUuid, 'RT-AP', 33.5)
    await ext._test.loginChangeTick()
    await tick()
    check('/login in a pinned chat as the active account: a different account from dana, so not dana\'s pinning login',
      activeNow !== 'dana' && (ext._test.pageState().accounts.find((a) => a.name === 'dana') || {}).pinning === null && !danaLine(), activeNow)
    check('with the warning, offering it to the active account', messages.slice(before).some((m) => /^WARN: A chat pinned to dana signed in as .*: use it as .*'s pinning login\?/.test(m)), messages.slice(before).join(' / '))
    check('ignored: the login stays with its chat', credstore.read(DANA_PIN).claudeAiOauth.refreshToken === 'RT-AP' && !ext._test.takeoutsPending().includes('dana'))
    check('the account in use is still the active one', profiles.activeProfile(TEST_ROOT) === activeNow)

    before = messages.length
    q.warn.push(undefined)
    await ext._test.startupLogins()
    await tick()
    check('after a reload, the held login asks again with its choices',
      messages.slice(before).filter((m) => /^WARN: A chat pinned to dana signed in as .*: use it as .*'s pinning login\?/.test(m)).length === 1, messages.slice(before).join(' / '))
    check('ignored again: still held, still no pinning login', credstore.read(DANA_PIN).claudeAiOauth.refreshToken === 'RT-AP' && !!loginsLib.foreignOf(TEST_ROOT, 'dana') && !danaLine())
    before = messages.length
    await ext._test.startupLogins()
    await tick()
    check('asked once per window, not on every check', !messages.slice(before).some((m) => /signed in as .*which isn't dana/.test(m)))
    const heldMeta = loginsLib.readMeta(TEST_ROOT, 'dana')
    heldMeta.foreign.since = heldMeta.foreign.since + 1
    fs.writeFileSync(loginsLib.metaFile(TEST_ROOT, 'dana'), JSON.stringify(heldMeta))
    before = messages.length
    q.warn.push('Discard it')
    q.info.push('Not now')
    await ext._test.startupLogins()
    await tick()
    await tick()
    check('answered after a reload: "Discard it" deletes it (no chat runs on it now)',
      !loginsLib.hasLogin(TEST_ROOT, 'dana') && !loginsLib.readMeta(TEST_ROOT, 'dana') && !ext._test.takeoutsPending().includes('dana'), messages.slice(before).join(' / '))
    q.info.length = 0

    const lfEnd = givePinning('dana', 'dana@example.com', 'uuid-d', 'RT-LF', 12.5)
    {
      const lm = loginsLib.readMeta(TEST_ROOT, 'dana')
      lm.foreign = { expiresAt: lfEnd, oauthAccount: { emailAddress: activeWho.email, accountUuid: activeWho.accountUuid }, since: Date.now() }
      lm.expiresAt = null
      fs.writeFileSync(loginsLib.metaFile(TEST_ROOT, 'dana'), JSON.stringify(lm))
    }
    await ext._test.loginChangeTick()
    before = messages.length
    q.warn.push('Keep it as dana\'s pinning login')
    q.info.push('OK')
    await ext._test.startupLogins()
    await tick()
    await tick()
    const lfAsk = messages.slice(before).filter((m) => /^WARN: /.test(m))
    check('a held login left over from 1.4.0/1.4.1 that reads as the active account: asked to keep it as dana\'s, not to give it to the active account',
      lfAsk.length === 1 && /Keep it as dana's pinning login\?/.test(lfAsk[0]) && !/use it as|Add .* as an account of its own/.test(lfAsk[0]), lfAsk.join(' / '))
    const lfMeta = loginsLib.readMeta(TEST_ROOT, 'dana') || {}
    check('"Keep it" makes it dana\'s pinning login again, with dana\'s own identity',
      !loginsLib.foreignOf(TEST_ROOT, 'dana') && lfMeta.expiresAt === lfEnd && lfMeta.accountUuid === 'uuid-d' && lfMeta.email === 'dana@example.com' &&
      credstore.read(DANA_PIN).claudeAiOauth.refreshToken === 'RT-LF', JSON.stringify(lfMeta))
    check('and the wrapper\'s list has dana\'s login line again', danaLine(), wrapperList())
    q.info.length = 0
    q.warn.length = 0

    const F3CHAT = '7d9e0a11-3333-4444-8555-a66677778888'
    const f3Title = 'Write the release notes'
    const zedLogin = { claudeAiOauth: { accessToken: 'AT-ZP3', refreshToken: 'RT-ZP3', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: Date.now() + 30.5 * DAY } }
    credstore.write(DANA_PIN, zedLogin)
    await loginsLib.holdForeign(TEST_ROOT, 'dana', { expiresAt: profiles.loginExpiresAt(zedLogin), oauthAccount: { emailAddress: 'zed@example.com', accountUuid: 'uuid-z' } })
    await ext._test.loginChangeTick()
    chatPinsLib.set(TEST_ROOT, F3CHAT, 'dana', f3Title)
    fs.mkdirSync(INUSE, { recursive: true })
    const f3Marker = path.join(INUSE, process.pid + '.json')
    fs.writeFileSync(f3Marker, JSON.stringify({ pid: process.pid, name: 'dana', sessionId: F3CHAT }))
    vscode.window.tabGroups = { all: [{ tabs: [{ label: f3Title, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } }] }], close: async () => {} }
    setBusy(F3CHAT, true)
    executed.length = 0
    before = messages.length
    signinQ.push({ email: 'dana@example.com', uuid: 'uuid-d', rt: 'RT-D6', days: 3.5 })
    q.warn.push({ value: 'Done', checked: false })
    const f3Open = () => executed.some((e) => e.id === 'claude-vscode.editor.open' && e.args[0] === F3CHAT)
    const adding = ext._test.onPageMessage({ type: 'addPinning', name: 'dana' })
    await tick()
    await tick()
    check('Add account for pinning while a chat runs on a held login: the new login waits, the held one stays',
      credstore.read(DANA_PIN).claudeAiOauth.refreshToken === 'RT-ZP3' && !!loginsLib.foreignOf(TEST_ROOT, 'dana'))
    check('and says so', messages.slice(before).some((m) => /^INFO: dana's new pinning login goes in once the chats on the login zed@example\.com have reopened/.test(m)),
      messages.slice(before).join(' / '))
    check('its chat waits for its reply', !f3Open())
    setBusy(F3CHAT, false)
    await ext._test.fastTick()
    check('the reply finished: the chat reopens', f3Open())
    check('while its old process runs, still nothing is written', credstore.read(DANA_PIN).claudeAiOauth.refreshToken === 'RT-ZP3')
    fs.rmSync(f3Marker, { force: true })
    await ext._test.fastTick()
    await adding
    await tick()
    check('then the held login goes and the new pinning login goes in', credstore.read(DANA_PIN).claudeAiOauth.refreshToken === 'RT-D6' &&
      !loginsLib.foreignOf(TEST_ROOT, 'dana') && Math.abs(daysOf((loginsLib.readMeta(TEST_ROOT, 'dana') || {}).expiresAt) - 3.5) < 0.1)
    check('with no "needs a new pinning login" notice in between', !messages.slice(before).some((m) => /was discarded/.test(m)), messages.slice(before).join(' / '))
    q.info.length = 0
    delete vscode.window.tabGroups
    chatPinsLib.remove(TEST_ROOT, F3CHAT)
    givePinning('dana', 'dana@example.com', 'uuid-d', 'RT-AP', 33.5)
    await ext._test.loginChangeTick()

    before = messages.length
    nextKeychainSecond()
    credstore.write(DANA_PIN, { claudeAiOauth: { accessToken: 'AT-DP5', refreshToken: 'RT-DP5', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: Date.now() + 44.5 * DAY } })
    const old = new Date(Date.now() - 60000)
    fs.utimesSync(LIVE_CFG, old, old)
    await ext._test.loginChangeTick()
    check('"can\'t tell who signed in": kept as dana\'s pinning login', Math.abs(daysOf((loginsLib.readMeta(TEST_ROOT, 'dana') || {}).expiresAt) - 44.5) < 0.1 && danaLine())
    check('and logged', messages.slice(before).some((m) => /didn't change within .* taken as the same account/.test(m)), messages.slice(before).join(' / '))
    store.setPin(TEST_ROOT, OTHER, null)

    givePinning('dana', 'dana@example.com', 'uuid-d', 'RT-DP2', 2.5)
    store.setPin(TEST_ROOT, OTHER, 'dana')
    profiles.updateCredentials(TEST_ROOT, 'dana', { claudeAiOauth: { accessToken: 'AT-DM', refreshToken: 'RT-DM', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: Date.now() + 40.5 * DAY } })
    await ext._test.loginChangeTick()
    before = messages.length
    chatLogin(null, 'dana@example.com', 'uuid-d', 'RT-DL', 45.5)
    await ext._test.loginChangeTick()
    check('plain /login as a saved account: kept as its main login', Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'dana').loginExpiresAt) - 45.5) < 0.1 &&
      profiles.readPayload(TEST_ROOT, 'dana').credentials.claudeAiOauth.refreshToken === 'RT-DL')
    check('the previous main keeps its pins going', Math.abs(daysOf(loginsLib.readMeta(TEST_ROOT, 'dana').expiresAt) - 40.5) < 0.1 &&
      credstore.read(DANA_PIN).claudeAiOauth.refreshToken === 'RT-DM')
    check('and says so', messages.slice(before).some((m) => /^INFO: Claude Code signed in as dana\. Switcher kept that fresh login.*previous login now keeps/.test(m)), messages.slice(before).join(' / '))
    before = messages.length
    await ext._test.loginChangeTick()
    check('nothing more the next time', messages.length === before)
    check('(dana is the active account now)', profiles.activeProfile(TEST_ROOT) === 'dana')
    before = messages.length
    chatLogin(null, 'dana@example.com', 'uuid-d', 'RT-DL2', 55.5)
    await ext._test.loginChangeTick()
    check('plain /login on the active account: main is renewed', Math.abs(daysOf(profiles.readMeta(TEST_ROOT, 'dana').loginExpiresAt) - 55.5) < 0.1 &&
      profiles.readPayload(TEST_ROOT, 'dana').credentials.claudeAiOauth.refreshToken === 'RT-DL2')
    check('its old saved copy (maybe out of date) is not moved to pinning', credstore.read(DANA_PIN).claudeAiOauth.refreshToken === 'RT-DM' &&
      Math.abs(daysOf(loginsLib.readMeta(TEST_ROOT, 'dana').expiresAt) - 40.5) < 0.1)
    check('and the notice says nothing about a previous login', messages.slice(before).some((m) => /^INFO: Claude Code signed in as dana\. Switcher kept that fresh login/.test(m)) &&
      !messages.slice(before).some((m) => /previous login now keeps/.test(m)), messages.slice(before).join(' / '))
    {
      const liveNow = credstore.read(null).claudeAiOauth
      const savedBefore = profiles.readMeta(TEST_ROOT, 'dana').loginExpiresAt
      before = messages.length
      nextKeychainSecond()
      credstore.write(null, { claudeAiOauth: { ...liveNow, accessToken: 'AT-DL2r', refreshToken: 'RT-DL2r', refreshTokenExpiresAt: liveNow.refreshTokenExpiresAt + 37 } })
      await ext._test.loginChangeTick()
      check('Claude Code renewing the main login (end date 37 ms later) is not a /login: no notice, nothing saved over',
        !messages.slice(before).some((m) => /^(INFO|WARN):/.test(m)) && profiles.readMeta(TEST_ROOT, 'dana').loginExpiresAt === savedBefore, messages.slice(before).join(' / '))
    }
    store.setPin(TEST_ROOT, OTHER, null)

    console.log('\n-- 1.4.2: two accounts signed in back to back, and changes while a pinned renewal waits --')
    {
      const breeDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs-bree-'))
      writeSignin(breeDir, { email: 'bree@example.com', uuid: 'uuid-b', rt: 'RT-B', days: 30 })
      profiles.importFromDir(TEST_ROOT, 'bree', breeDir)
      const danaEnd = profiles.readMeta(TEST_ROOT, 'dana').loginExpiresAt
      profiles.updateCredentials(TEST_ROOT, 'bree', { claudeAiOauth: { accessToken: 'AT-B', refreshToken: 'RT-B', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: danaEnd + 40e3 } })
      await ext._test.loginChangeTick()
      const liveEnd = credstore.read(null).claudeAiOauth.refreshTokenExpiresAt
      check('(set up: dana is active, its live end drifted, bree\'s saved end 40 s after dana\'s)', profiles.activeProfile(TEST_ROOT) === 'dana' &&
        liveEnd !== danaEnd && loginsLib.sameLoginEnd(liveEnd, danaEnd) && loginsLib.sameLoginEnd(liveEnd, profiles.readMeta(TEST_ROOT, 'bree').loginExpiresAt))
      const liveUuid = () => (readJson(LIVE_CFG).oauthAccount || {}).accountUuid
      const WORK_PIN = loginsLib.dirFor(TEST_ROOT, 'work')
      const workEnd = givePinning('work', 'work@example.com', 'uuid-w', 'RT-WP', 20.5)
      await ext._test.loginChangeTick()
      before = messages.length
      nextKeychainSecond()
      credstore.write(WORK_PIN, { claudeAiOauth: { accessToken: 'AT-WPr', refreshToken: 'RT-WPr', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: workEnd + 25 } })
      {
        const cfg = readJson(LIVE_CFG)
        cfg.oauthAccount = { ...cfg.oauthAccount, displayName: 'Work' }
        fs.writeFileSync(LIVE_CFG, JSON.stringify(cfg))
      }
      await ext._test.loginChangeTick()
      await tick()
      check('a pinned renewal with two accounts\' ends within 2 minutes: ~/.claude.json is put back to dana (the active account), not bree',
        liveUuid() === 'uuid-d' && !readJson(LIVE_CFG).oauthAccount.displayName && profiles.activeProfile(TEST_ROOT) === 'dana' &&
        loginsLib.readMeta(TEST_ROOT, 'work').expiresAt === workEnd + 25, JSON.stringify(readJson(LIVE_CFG).oauthAccount) + ' / ' + messages.slice(before).join(' / '))
      await ext._test.onPageMessage({ type: 'switch', name: 'work' })
      check('a switch away then saves the live login under dana, not bree',
        profiles.readPayload(TEST_ROOT, 'dana').credentials.claudeAiOauth.refreshToken === 'RT-DL2r' &&
        profiles.readPayload(TEST_ROOT, 'bree').credentials.claudeAiOauth.refreshToken === 'RT-B',
        profiles.readPayload(TEST_ROOT, 'dana').credentials.claudeAiOauth.refreshToken + ' / ' + profiles.readPayload(TEST_ROOT, 'bree').credentials.claudeAiOauth.refreshToken)
      await ext._test.onPageMessage({ type: 'switch', name: 'dana' })
      await ext._test.loginChangeTick()

      ext._test.setIdentityDelayMs(5000)
      const renewWork = async (rt, plus) => {
        const end = loginsLib.readMeta(TEST_ROOT, 'work').expiresAt
        nextKeychainSecond()
        credstore.write(WORK_PIN, { claudeAiOauth: { accessToken: 'AT-' + rt, refreshToken: rt, expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: end + plus } })
        const t = ext._test.loginChangeTick()
        for (let i = 0; i < 200 && loginsLib.readMeta(TEST_ROOT, 'work').expiresAt !== end + plus; i++) await new Promise((r) => setTimeout(r, 10))
        return { t, end: end + plus }
      }
      before = messages.length
      const r1 = await renewWork('RT-WPr2', 11)
      chatLogin(null, 'bree@example.com', 'uuid-b', 'RT-BL', 60.5)
      await r1.t
      check('a /login as another account elsewhere while a pinned renewal waits is not undone', loginsLib.readMeta(TEST_ROOT, 'work').expiresAt === r1.end &&
        liveUuid() === 'uuid-b', JSON.stringify(readJson(LIVE_CFG).oauthAccount) + ' / ' + messages.slice(before).join(' / '))
      await ext._test.loginChangeTick()
      check('and its login is saved as bree\'s, not dana\'s', profiles.readPayload(TEST_ROOT, 'bree').credentials.claudeAiOauth.refreshToken === 'RT-BL' &&
        profiles.readPayload(TEST_ROOT, 'dana').credentials.claudeAiOauth.refreshToken === 'RT-DL2r')
      await ext._test.onPageMessage({ type: 'switch', name: 'dana' })
      await ext._test.loginChangeTick()
      {
        const p = profiles.readPayload(TEST_ROOT, 'work')
        profiles.updateCredentials(TEST_ROOT, 'work', { claudeAiOauth: { ...p.credentials.claudeAiOauth, refreshTokenExpiresAt: Date.now() + 9.5 * DAY } })
      }
      before = messages.length
      const r2 = await renewWork('RT-WPr3', 13)
      {
        const p = profiles.readPayload(TEST_ROOT, 'work')
        credstore.write(null, p.credentials)
        const cfg = readJson(LIVE_CFG)
        Object.assign(cfg, p.identity)
        fs.writeFileSync(LIVE_CFG, JSON.stringify(cfg))
      }
      await r2.t
      check('a switch from another window while a pinned renewal waits is not undone', loginsLib.readMeta(TEST_ROOT, 'work').expiresAt === r2.end &&
        liveUuid() === 'uuid-w' && profiles.activeProfile(TEST_ROOT) === 'work', JSON.stringify(readJson(LIVE_CFG).oauthAccount) + ' / ' + messages.slice(before).join(' / '))
      await ext._test.loginChangeTick()
      await ext._test.onPageMessage({ type: 'switch', name: 'dana' })
      await ext._test.loginChangeTick()
      {
        const danaRt = profiles.readPayload(TEST_ROOT, 'dana').credentials.claudeAiOauth.refreshToken
        before = messages.length
        const r3 = await renewWork('RT-WPr4', 17)
        chatLogin(null, 'work@example.com', 'uuid-w', 'RT-WL1', 40.5)
        await r3.t
        check('a /login as the pinned account elsewhere while its pinned renewal waits is not undone', loginsLib.readMeta(TEST_ROOT, 'work').expiresAt === r3.end &&
          liveUuid() === 'uuid-w', JSON.stringify(readJson(LIVE_CFG).oauthAccount) + ' / ' + messages.slice(before).join(' / '))
        await ext._test.loginChangeTick()
        check('and its login is saved as work\'s, not dana\'s, and work shows as the account in use',
          profiles.readPayload(TEST_ROOT, 'work').credentials.claudeAiOauth.refreshToken === 'RT-WL1' &&
          profiles.readPayload(TEST_ROOT, 'dana').credentials.claudeAiOauth.refreshToken === danaRt &&
          profiles.activeProfile(TEST_ROOT) === 'work' && liveUuid() === 'uuid-w' &&
          !messages.slice(before).some((m) => /signed in as Dana/i.test(m)), messages.slice(before).join(' / '))
        await ext._test.onPageMessage({ type: 'switch', name: 'dana' })
        await ext._test.loginChangeTick()
      }
      ext._test.setIdentityDelayMs(10)

      {
        givePinning('work', 'work@example.com', 'uuid-w', 'RT-WPold', 3.5)
        const pm = profiles.readMeta(TEST_ROOT, 'work')
        pm.signedInAt = Date.now() - 5 * DAY
        profiles.writeMeta(TEST_ROOT, 'work', pm)
        const movedSignedIn = pm.signedInAt
        await ext._test.loginChangeTick()
        before = messages.length
        chatLogin(null, 'work@example.com', 'uuid-w', 'RT-WL2', 50.5)
        await ext._test.loginChangeTick()
        const mm = loginsLib.readMeta(TEST_ROOT, 'work') || {}
        check('a login moved into pinning by a /login keeps its own sign-in time',
          credstore.read(WORK_PIN).claudeAiOauth.refreshToken === 'RT-WL1' && mm.signedInAt === movedSignedIn &&
          Math.abs(profiles.readMeta(TEST_ROOT, 'work').signedInAt - Date.now()) < 60e3, JSON.stringify(mm) + ' / ' + messages.slice(before).join(' / '))
        await ext._test.onPageMessage({ type: 'switch', name: 'dana' })
        await ext._test.loginChangeTick()
        before = messages.length
        const end = loginsLib.readMeta(TEST_ROOT, 'work').expiresAt
        nextKeychainSecond()
        credstore.write(WORK_PIN, { claudeAiOauth: { accessToken: 'AT-WL1r', refreshToken: 'RT-WL1r', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: end + 30 } })
        {
          const cfg = readJson(LIVE_CFG)
          cfg.oauthAccount = { ...cfg.oauthAccount, displayName: 'Work' }
          fs.writeFileSync(LIVE_CFG, JSON.stringify(cfg))
        }
        await ext._test.loginChangeTick()
        await tick()
        const after = loginsLib.readMeta(TEST_ROOT, 'work') || {}
        check('and its renewal minutes after the move is followed quietly, not held as the active account\'s',
          !after.foreign && after.expiresAt === end + 30 && liveUuid() === 'uuid-d' && !messages.slice(before).some((m) => /^WARN:/.test(m)),
          JSON.stringify(after) + ' / ' + messages.slice(before).join(' / '))
      }

      const freshEnd = givePinning('work', 'work@example.com', 'uuid-w', 'RT-WP3', 25.5)
      {
        const m = loginsLib.readMeta(TEST_ROOT, 'work')
        m.signedInAt = Date.now() - 30e3
        fs.writeFileSync(loginsLib.metaFile(TEST_ROOT, 'work'), JSON.stringify(m))
      }
      await ext._test.loginChangeTick()
      before = messages.length
      q.warn.push(undefined)
      nextKeychainSecond()
      credstore.write(WORK_PIN, { claudeAiOauth: { accessToken: 'AT-BP', refreshToken: 'RT-BP', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: freshEnd + 50e3 } })
      {
        const cfg = readJson(LIVE_CFG)
        cfg.oauthAccount = { emailAddress: 'bree@example.com', accountUuid: 'uuid-b', organizationName: 'Acme' }
        fs.writeFileSync(LIVE_CFG, JSON.stringify(cfg))
      }
      await ext._test.loginChangeTick()
      await tick()
      check('a /login as another account within 2 minutes of the pinning sign-in is not taken for a renewal: held, and asked',
        ((loginsLib.foreignOf(TEST_ROOT, 'work') || {}).oauthAccount || {}).accountUuid === 'uuid-b' &&
        messages.slice(before).some((m) => /^WARN: A chat pinned to .* signed in as bree@example\.com/.test(m)), messages.slice(before).join(' / '))
      check('and the active account is put back in ~/.claude.json', liveUuid() === 'uuid-d')
      fs.rmSync(WORK_PIN, { recursive: true, force: true })
      fs.rmSync(loginsLib.metaFile(TEST_ROOT, 'work'), { force: true })
      await ext._test.loginChangeTick()

      const workLabel = (ext._test.pageState().accounts.find((a) => a.name === 'work') || {}).label
      const oldEnd = givePinning('work', 'work@example.com', 'uuid-w', 'RT-WL', 12.5)
      const oldSignedIn = Date.now() - 17.5 * DAY
      const writeHold = (m) => fs.writeFileSync(loginsLib.metaFile(TEST_ROOT, 'work'), JSON.stringify(m))
      writeHold({ ...loginsLib.readMeta(TEST_ROOT, 'work'), signedInAt: oldSignedIn, expiresAt: null,
        foreign: { expiresAt: oldEnd, oauthAccount: { emailAddress: 'bree@example.com', accountUuid: 'uuid-b' }, since: Date.now() - 2 * DAY } })
      await ext._test.loginChangeTick()
      before = messages.length
      q.warn.push('Keep it as ' + workLabel + '\'s pinning login')
      q.info.push('OK')
      await ext._test.startupLogins()
      await tick()
      await tick()
      const sw = messages.slice(before).filter((m) => /^WARN: /.test(m))
      check('a leftover hold after a switch: still asked to keep it as work\'s, not to give it to bree',
        sw.length === 1 && /Keep it as .*'s pinning login\?/.test(sw[0]) && !/use it as/.test(sw[0]), sw.join(' / '))
      const kept = loginsLib.readMeta(TEST_ROOT, 'work') || {}
      check('"Keep it" keeps the login\'s own sign-in time', !kept.foreign && kept.expiresAt === oldEnd && kept.accountUuid === 'uuid-w' && kept.signedInAt === oldSignedIn,
        JSON.stringify(kept))
      q.info.length = 0
      q.warn.length = 0
      nextKeychainSecond()
      credstore.write(WORK_PIN, { claudeAiOauth: { accessToken: 'AT-BG', refreshToken: 'RT-BG', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: Date.now() + 30 * DAY } })
      writeHold({ ...loginsLib.readMeta(TEST_ROOT, 'work'), signedInAt: Date.now() - 10 * DAY, expiresAt: null,
        foreign: { expiresAt: Date.now() + 30 * DAY, oauthAccount: { emailAddress: 'bree@example.com', accountUuid: 'uuid-b' }, since: Date.now() } })
      await ext._test.loginChangeTick()
      before = messages.length
      q.warn.push(undefined)
      await ext._test.startupLogins()
      await tick()
      const gw = messages.slice(before).filter((m) => /^WARN: /.test(m))
      check('a leftover hold of a real sign-in as bree is still offered to bree', gw.length === 1 && /use it as .*'s pinning login\?/.test(gw[0]), gw.join(' / '))
      q.warn.length = 0
      const leftover = async (end, since, signedInAt, who) => {
        nextKeychainSecond()
        credstore.write(WORK_PIN, { claudeAiOauth: { accessToken: 'AT-LO', refreshToken: 'RT-LO' + since, expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: end } })
        writeHold({ ...loginsLib.readMeta(TEST_ROOT, 'work'), signedInAt, expiresAt: null, foreign: { expiresAt: end, oauthAccount: who, since } })
        await ext._test.loginChangeTick()
        before = messages.length
        q.warn.push(undefined)
        await ext._test.startupLogins()
        await tick()
        q.warn.length = 0
        return messages.slice(before).filter((m) => /^WARN: /.test(m))
      }
      const BREE = { emailAddress: 'bree@example.com', accountUuid: 'uuid-b' }
      const DANA = { emailAddress: 'dana@example.com', accountUuid: 'uuid-d' }
      const KEEP = /Keep it as .*'s pinning login\?/, USE = /use it as .*'s pinning login\?/
      const s8 = Date.now() - 10 * DAY
      let lw = await leftover(s8 + 30 * DAY, s8 + 8 * 3600e3, s8, BREE)
      check('a leftover hold 8 hours after the sign-in, after a switch: asked to keep it as work\'s', lw.length === 1 && KEEP.test(lw[0]) && !USE.test(lw[0]), lw.join(' / '))
      lw = await leftover(s8 + 30 * DAY + 5, s8 + 8 * 3600e3 + 5, s8, DANA)
      check('a leftover hold 8 hours after the sign-in, no switch: asked to keep it as work\'s', lw.length === 1 && KEEP.test(lw[0]) && !USE.test(lw[0]), lw.join(' / '))
      lw = await leftover(Date.now() + 12.5 * DAY, Date.now() - 2 * DAY, Date.now() - 5 * DAY, DANA)
      check('a leftover hold of a login moved into pinning (sign-in time = move time), no switch: asked to keep it as work\'s',
        lw.length === 1 && KEEP.test(lw[0]) && !USE.test(lw[0]), lw.join(' / '))
      lw = await leftover(Date.now() + 30 * DAY, Date.now() - 1000, Date.now() - 10 * DAY, DANA)
      check('a leftover hold of a real sign-in as the active account still asks the old question', lw.length === 1 && USE.test(lw[0]), lw.join(' / '))
      fs.rmSync(WORK_PIN, { recursive: true, force: true })
      fs.rmSync(loginsLib.metaFile(TEST_ROOT, 'work'), { force: true })
      profiles.remove(TEST_ROOT, 'bree')
      fs.rmSync(breeDir, { recursive: true, force: true })
      await ext._test.loginChangeTick()
    }

    console.log('\n-- 1.4: Forget removes the pinning login and its settings --')
    await ext._test.onPageMessage({ type: 'remote', name: 'finn', on: false })
    q.warn.length = 0
    q.warn.push('Forget')
    await ext._test.onPageMessage({ type: 'forget', name: 'finn' })
    check('the account is gone', !profiles.exists(TEST_ROOT, 'finn'), messages.slice(-2).join(' / '))
    check('the confirm said it deletes the pinning login and unpins its chats and folders', messages.some((m) => /^WARN: Forget "Finn"\? This deletes its saved login and its pinning login, and unpins its chats and folders/.test(m)))
    check('the 1.3 window login command is gone', !registered['claudeswitcher.windowLogin'])
    check('with its pinning login and its settings file', !loginsLib.readMeta(TEST_ROOT, 'finn') && !loginsLib.hasLogin(TEST_ROOT, 'finn') && !fs.existsSync(setFile))

    done14(run14.c)
    delete process.env.CLAUDE_CONFIG_DIR
    vscode.workspace.workspaceFolders = []
  }

  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====')
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  fs.rmSync(FAKE_HOME, { recursive: true, force: true })
  fs.rmSync(TEST_ROOT + '-vscode', { recursive: true, force: true })
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1) })
