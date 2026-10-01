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

const q = { input: [], quick: [], info: [], warn: [], open: [] }
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

function mockWebview() {
  const w = {
    html: '', options: null, cspSource: 'vscode-resource://test', posted: [], handler: null,
    asWebviewUri: (u) => 'vscode-resource://test' + u.fsPath.replace(/\\/g, '/'),
    postMessage: async (m) => { w.posted.push(m); return true },
    onDidReceiveMessage: (fn) => { w.handler = fn; return { dispose() {} } },
  }
  return w
}

const FAKE_APPROOT = path.join(TEST_ROOT + '-vscode', 'resources', 'app')

const vscode = {
  env: { appRoot: FAKE_APPROOT },
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
    showOpenDialog: async () => shift(q.open, 'showOpenDialog'),
    onDidChangeWindowState: () => ({ dispose() {} }),
    showTextDocument: async () => ({}),
    createTerminal: (opts) => {
      const t = { opts, sent: [], show() {}, sendText(s) { t.sent.push(s) }, dispose() {} }
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

const claudeLib = require('../lib/claude.js')
let authMock = { ok: false, error: 'mocked' }
claudeLib.authStatus = () => authMock
claudeLib.resolveBin = () => 'C:\\fake\\claude.exe'
ext._test.setLoginPollMs(20)

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
const iso = (ms) => new Date(Date.now() + ms).toISOString()

const CLAUDE_DIR = path.join(FAKE_HOME, '.claude')
const LIVE_CREDS = path.join(CLAUDE_DIR, '.credentials.json')
const LIVE_CFG = path.join(FAKE_HOME, '.claude.json')
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

function signInLive(email, uuid, rt, expiresInMs) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true })
  fs.writeFileSync(LIVE_CREDS, JSON.stringify({
    claudeAiOauth: { accessToken: 'AT-' + rt, refreshToken: rt, expiresAt: Date.now() + expiresInMs },
  }))
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
  const ctx = { subscriptions: [] }
  ext.activate(ctx)
  await tick()
  check('root directory created', fs.existsSync(TEST_ROOT))
  check('registers exactly the release commands',
    Object.keys(registered).map((i) => i.replace('claudeswitcher.', '')).sort().join(',') ===
      editionLib.MAIN_COMMANDS.slice().sort().join(','), Object.keys(registered).join(','))
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
  check('there is no bottom-left item any more', bars.length === 2)

  console.log('\n-- Add Account: save the login you are signed in to --')
  q.quick.push('Save the account'); q.input.push('work'); q.info.push(undefined)
  await registered['claudeswitcher.globalAdd']()
  check('saved as a profile', profiles.exists(TEST_ROOT, 'work'))
  check('it is now the live account', profiles.activeProfile(TEST_ROOT) === 'work')
  check('status bar shows it, no warning', (bars[0].text || '').includes('work') && !bars[0].bg, bars[0].text)

  console.log('\n-- Add Account: sign a new account in, no Verify click --')
  authMock = { ok: true, loggedIn: true, email: 'dana@example.com', orgName: 'Acme' }
  q.input.push('dana', '')
  await registered['claudeswitcher.globalAdd']()
  const term = terminals[terminals.length - 1]
  check('a login terminal opened in the account\'s own folder',
    term.opts.env.CLAUDE_CONFIG_DIR === path.join(TEST_ROOT, 'accounts', 'dana'), term.opts.env.CLAUDE_CONFIG_DIR)
  check('the live login is untouched while signing in', readJson(LIVE_CREDS).claudeAiOauth.refreshToken === 'RT-WORK')
  check('no --email when left blank', !term.sent[0].includes('--email'), term.sent[0])
  finishStagedLogin('dana', 'dana@example.com', 'uuid-d', 'RT-D')
  q.info.push(undefined)
  await ext._test.settle()
  check('completed login detected and added', profiles.exists(TEST_ROOT, 'dana'))
  check('moved into the switcher, not left in the folder',
    !fs.existsSync(path.join(TEST_ROOT, 'accounts', 'dana', '.credentials.json')))
  check('user told it is in the switcher', messages.some((m) => m.includes('It is in the account switcher now')))

  console.log('\n-- signing in to an account you already have is caught --')
  q.input.push('second-dev', 'dev@example.com')
  await registered['claudeswitcher.globalAdd']()
  check('the email is pre-filled on the login page', terminals[terminals.length - 1].sent[0].includes('--email dev@example.com'))
  finishStagedLogin('second-dev', 'dana@example.com', 'uuid-d', 'RT-2')
  q.warn.push('Discard This Login')
  await ext._test.settle()
  check('not saved twice under a new name', !profiles.exists(TEST_ROOT, 'second-dev'))
  check('its throwaway folder entry is removed', !store.readRegistry(TEST_ROOT).accounts.some((a) => a.name === 'second-dev'))

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
  q.quick.push('dana'); q.info.push('Not Now')
  await registered['claudeswitcher.globalSwitch']()
  check('the live login is now dana', readJson(LIVE_CREDS).claudeAiOauth.refreshToken === 'RT-D')
  check('identity swapped', readJson(LIVE_CFG).oauthAccount.emailAddress === 'dana@example.com')
  check('the chat is exactly where it was', fs.readFileSync(path.join(CLAUDE_DIR, 'projects', 'C--repo', 'chat.jsonl'), 'utf8') === 'precious\n')
  check('the account switched away from was re-saved first',
    profiles.readPayload(TEST_ROOT, 'work').credentials.claudeAiOauth.refreshToken === 'RT-WORK')
  q.quick.push('Manage accounts')
  await registered['claudeswitcher.globalSwitch']()
  check('the switcher offers "Manage accounts…", which opens the page', panels.length === 1)
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
  check('reads session | fable | weekly', bars[1].text === '$(pulse) 36% | 53% | 57%', bars[1].text)
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
  check('bar shows the LIVE numbers', bars[1].text === '$(pulse) 11% | 33% | 22%', bars[1].text)
  check('cached under our own dir, not in .claude.json', fs.existsSync(usageLib.cachePath(TEST_ROOT, null)) &&
    readJson(LIVE_CFG).cachedUsageUtilization.utilization.limits[0].percent === 97)
  nextFetch = { ok: false, reason: 'mocked 401' }
  q.warn.push(undefined)
  await registered['claudeswitcher.refreshUsage']()
  check('a failed refresh keeps the figures', bars[1].text === '$(pulse) 11% | 33% | 22%', bars[1].text)
  nextFetch = { raw: { status: 200, body: '{}', headers: {} } }
  q.warn.push(undefined)
  await registered['claudeswitcher.refreshUsage']()
  check('a 200 with no usage in it keeps them too', bars[1].text === '$(pulse) 11% | 33% | 22%')
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
  check('the meter still shows this window\'s account', /^\$\(pulse\) \d+% \| \d+% \| \d+%$/.test(acctBar.text || ''), acctBar.text)
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
  const renewsBefore = trackerCalls.filter((c) => c.startsWith('refresh:')).length
  const before = trackerCalls.length
  await registered['claudeswitcher.refreshAllAccounts']()
  check('an update re-reads accounts whose figures were fresh', trackerCalls.slice(before).some((c) => c.startsWith('usage:')))
  check('but never renews a login that is not due', trackerCalls.filter((c) => c.startsWith('refresh:')).length === renewsBefore)
  await registered['claudeswitcher.switchTo']('no-such-account')
  await registered['claudeswitcher.switchTo']({ not: 'a name' })
  check('links to unknown or malformed names do nothing', readJson(LIVE_CREDS).claudeAiOauth.refreshToken === 'RT-D')
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
  check('the page shows it off', ext._test.pageState().accounts.find((a) => a.name === 'dana').artifactsOff === true)
  check('Show Status lists it', (await ext._test.onPageMessage({ type: 'status' }), messages.some((m) => /dana.*artifacts:off/.test(m))))
  q.info.push('Not Now')
  await ext._test.onPageMessage({ type: 'switch', name: 'work' })
  check('Switch on a card switches', readJson(LIVE_CREDS).claudeAiOauth.refreshToken.startsWith('RT-WORK'))
  check('switching to an account with Artifacts on removes the setting', !('enableArtifact' in readJson(SETTINGS)) &&
    readJson(SETTINGS).theme === 'kept')
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

  store.setPin(TEST_ROOT, PIN_FOLDER, 'dana')
  q.warn.push(undefined)
  let run = activateFresh()
  check('a pin with no window login leaves the window on the global account', !process.env.CLAUDE_CONFIG_DIR)
  check('and offers to sign in', messages.some((m) => m.includes('has no window login yet')))
  disposeAll(run.c)

  const wdir = windowsLib.prepare(TEST_ROOT, 'dana')
  fs.writeFileSync(path.join(wdir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'AT-W', refreshToken: 'RT-W' } }))
  fs.writeFileSync(path.join(wdir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dana@example.com', organizationName: 'Acme' } }))
  run = activateFresh()
  check("activation points the window at the account's window login", process.env.CLAUDE_CONFIG_DIR === wdir)
  check('the status bar shows the pin', /\$\(pin\)/.test(run.accountBar.text || ''), run.accountBar.text)
  check('clicking it manages the pin', run.accountBar.command === 'claudeswitcher.pinFolder')
  check('the window login got its own settings copy', fs.existsSync(path.join(wdir, 'settings.json')))
  check('with the account\'s Artifacts choice (dana is set to off)', readJson(path.join(wdir, 'settings.json')).enableArtifact === false)
  await ext._test.onPageMessage({ type: 'artifacts', name: 'dana', on: true })
  check('turning it back on reaches the pinned window', !('enableArtifact' in readJson(path.join(wdir, 'settings.json'))))
  check('without touching the live account\'s settings', !('enableArtifact' in readJson(path.join(CLAUDE_DIR, 'settings.json'))))
  check('with nobody set to off, the switcher manages nothing', !store.artifactsManaged(TEST_ROOT))
  check('it is never imported into the switcher', fs.existsSync(path.join(wdir, '.credentials.json')))
  check('the page knows this window is pinned', ext._test.pageState().window.pinnedTo === 'dana')
  q.warn.push(undefined)
  await ext._test.onPageMessage({ type: 'forgetWindowLogin', name: 'dana' })
  check('the window login in use here cannot be forgotten from here', fs.existsSync(path.join(wdir, '.credentials.json')))
  q.quick.push('Unpin this folder'); q.info.push('Later')
  await registered['claudeswitcher.pinFolder']()
  check('Pin Folder offers "Unpin this folder", which works', !store.getPin(TEST_ROOT, PIN_FOLDER))
  check('and offers the reload that makes it take effect', messages.some((m) => m.includes('is unpinned')))
  disposeAll(run.c)

  delete process.env.CLAUDE_CONFIG_DIR
  run = activateFresh()
  check('unpinned, the window is back on the global account', !process.env.CLAUDE_CONFIG_DIR)
  executed.length = 0
  q.quick.push('Another folder'); q.open.push([{ fsPath: OTHER }]); q.quick.push('dana')
  await registered['claudeswitcher.pinFolder']()
  check('"Another folder…" pins it', store.getPin(TEST_ROOT, OTHER) === 'dana')
  check('and opens it in a new window', executed.some((e) => e.id === 'vscode.openFolder' && e.args[1] && e.args[1].forceNewWindow))
  q.info.length = 0
  await ext._test.onPageMessage({ type: 'unpin', folder: store.pinKey(OTHER) })
  check('Unpin on the page removes it', !store.getPin(TEST_ROOT, OTHER))
  q.warn.push('Forget'); q.info.push(undefined)
  await ext._test.onPageMessage({ type: 'forgetWindowLogin', name: 'dana' })
  check('from an unpinned window the window login can be forgotten', !fs.existsSync(wdir))
  check('and the shared history it linked to is untouched',
    fs.readFileSync(path.join(CLAUDE_DIR, 'projects', 'C--repo', 'chat.jsonl'), 'utf8') === 'precious\n')
  disposeAll(run.c)

  console.log('\n-- the release (main) build --')
  windowsLib.prepare(TEST_ROOT, 'dana')
  fs.writeFileSync(path.join(wdir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'AT-W', refreshToken: 'RT-W' } }))
  store.setPin(TEST_ROOT, PIN_FOLDER, 'dana')
  delete process.env.CLAUDE_CONFIG_DIR
  run = activateFresh({ claudeswitcher: { edition: 'main' } })
  const ids = Object.keys(registered).map((i) => i.replace('claudeswitcher.', '')).sort()
  check('registers exactly the release set', ids.join(',') === editionLib.MAIN_COMMANDS.slice().sort().join(','), ids.join(','))
  check('and folder pins work in the release too', process.env.CLAUDE_CONFIG_DIR === wdir)
  check('the release page has the Artifacts switch too', ext._test.pageState().features.artifacts === true)
  await ext._test.onPageMessage({ type: 'artifacts', name: 'work', on: false })
  check('and it works there', store.getArtifacts(TEST_ROOT, 'work') === 'off')
  await ext._test.onPageMessage({ type: 'artifacts', name: 'work', on: true })
  disposeAll(run.c)
  delete process.env.CLAUDE_CONFIG_DIR
  vscode.workspace.workspaceFolders = []
  ext._test.stopLoginWatchers()

  console.log('\n-- name validation --')
  check('rejects path traversal', !store.validName('../evil'))
  check('rejects spaces', !store.validName('my account'))
  check('accepts normal name', store.validName('work-2'))
  check('rejects a blank label', !store.validLabel('   '))
  check('rejects an icon with spaces', !store.validIcon('my icon'))

  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====')
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  fs.rmSync(FAKE_HOME, { recursive: true, force: true })
  fs.rmSync(TEST_ROOT + '-vscode', { recursive: true, force: true })
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1) })
