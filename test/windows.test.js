const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-windows-'))
process.env.USERPROFILE = HOME
process.env.HOME = HOME
const ROOT = path.join(HOME, '.claude-switcher')
const OPTS = { home: HOME }

const store = require('../lib/store.js')
const windows = require('../lib/windows.js')
const claude = require('../lib/claude.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}
function throws(fn, re) { try { fn(); return false } catch (e) { return re ? re.test(e.message) : true } }

const CLAUDE = path.join(HOME, '.claude')
const CANARY = path.join(CLAUDE, 'projects', 'C--work-repo', 'precious-chat.jsonl')
fs.mkdirSync(path.dirname(CANARY), { recursive: true })
fs.writeFileSync(CANARY, '{"type":"user","message":"do not lose me"}\n')
fs.writeFileSync(path.join(CLAUDE, 'settings.json'), JSON.stringify({
  hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'relay.bat' }] }] },
  env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
  model: 'opus',
  disableRemoteControl: true,
}, null, 2))
fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({
  oauthAccount: { emailAddress: 'live@example.com', accountUuid: 'uuid-live' },
  userID: 'uid-live',
  cachedUsageUtilization: { utilization: { limits: [] } },
  cachedGrowthBookFeatures: { flag: true },
  projects: { 'C:/work/repo': { hasTrustDialogAccepted: true, allowedTools: ['Bash(npm test)'] } },
  mcpServers: { github: { command: 'gh-mcp' } },
  hasCompletedOnboarding: true,
}))
store.ensureRoot(ROOT)

console.log('\n-- preparing a window login --')
const dir = windows.prepare(ROOT, 'Work', OPTS)
check('lives under windows/, not accounts/ (which the switcher imports from)',
  dir === path.join(ROOT, 'windows', 'Work') && !fs.existsSync(path.join(ROOT, 'accounts', 'Work')))
check('every shared folder is a link', windows.SHARED.every((s) => windows.isLink(path.join(dir, s))))
check('and every link points into ~/.claude', windows.linksHealthy(ROOT, 'Work', OPTS))
check('the existing chat is visible through the link',
  fs.existsSync(path.join(dir, 'projects', 'C--work-repo', 'precious-chat.jsonl')))
fs.writeFileSync(path.join(dir, 'projects', 'C--work-repo', 'new-chat.jsonl'), 'x\n')
check('a chat written in the window lands in the one shared history',
  fs.existsSync(path.join(CLAUDE, 'projects', 'C--work-repo', 'new-chat.jsonl')))
check('login and identity are NOT shared', !windows.isLink(path.join(dir, '.credentials.json')) &&
  !windows.isLink(path.join(dir, '.claude.json')) && !windows.SHARED.includes('.credentials.json'))
check('org-synced skills and plugins are NOT shared (they are per account)',
  !windows.SHARED.includes('skills') && !windows.SHARED.includes('plugins'))

console.log('\n-- the seeded .claude.json --')
const seed = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'))
check('carries your project trust and allowed tools', seed.projects['C:/work/repo'].hasTrustDialogAccepted === true)
check('carries your MCP servers', seed.mcpServers.github.command === 'gh-mcp')
check('carries no identity', !seed.oauthAccount && !seed.userID)
check('carries no account caches or flags', !seed.cachedUsageUtilization && !seed.cachedGrowthBookFeatures)
fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ ...seed, oauthAccount: { emailAddress: 'work@example.com' } }))
windows.prepare(ROOT, 'Work', OPTS)
check('a second prepare never overwrites a signed-in identity',
  JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).oauthAccount.emailAddress === 'work@example.com')

console.log('\n-- settings, and Remote Control per account --')
let s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
check('hooks copied', s.hooks.SessionEnd[0].hooks[0].command === 'relay.bat')
check('env and model copied', s.env.CLAUDE_CODE_ENABLE_TELEMETRY === '1' && s.model === 'opus')
check("the live account's Remote Control flag does not leak in", s.disableRemoteControl === undefined)
store.setRemote(ROOT, 'Work', 'off')
check('turning Remote Control off for this account rewrites it', windows.syncSettings(ROOT, 'Work', OPTS) === true)
s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
check('off for this account', s.disableRemoteControl === true)
check('and nothing else changed', s.hooks && s.model === 'opus')
check('syncing again with nothing new is a no-op', windows.syncSettings(ROOT, 'Work', OPTS) === false)
store.setRemote(ROOT, 'Work', 'on')
windows.syncSettings(ROOT, 'Work', OPTS)
check('back on', JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).disableRemoteControl === undefined)

console.log('\n-- Artifacts per account --')
const winSettings = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
const globalFile = path.join(CLAUDE, 'settings.json')
const globalBefore = fs.readFileSync(globalFile, 'utf8')
fs.writeFileSync(globalFile, JSON.stringify({ ...JSON.parse(globalBefore), enableArtifact: false }))
windows.syncSettings(ROOT, 'Work', OPTS)
check('while nobody uses the switch, the window copies the user\'s own choice', winSettings().enableArtifact === false)
store.setArtifacts(ROOT, 'Other', 'off')
windows.syncSettings(ROOT, 'Work', OPTS)
check('once it is in use, the live account\'s "off" does not leak into a window whose account is on',
  winSettings().enableArtifact === undefined)
store.setArtifacts(ROOT, 'Work', 'off')
windows.syncSettings(ROOT, 'Work', OPTS)
check('and a window whose account is off gets false', winSettings().enableArtifact === false)
check('with everything else intact', winSettings().model === 'opus' && winSettings().hooks)
store.setArtifacts(ROOT, 'Work', 'on')
store.setArtifacts(ROOT, 'Other', 'on')
fs.writeFileSync(globalFile, globalBefore)
windows.syncSettings(ROOT, 'Work', OPTS)
check('back to the default', winSettings().enableArtifact === undefined)

console.log('\n-- links are repaired, never destructively --')
windows.removeLink(path.join(dir, 'todos'))
fs.mkdirSync(path.join(dir, 'todos'))
fs.writeFileSync(path.join(dir, 'todos', 'local-note.json'), 'keep')
windows.ensureLinks(ROOT, 'Work', OPTS)
check('a real folder where a link belongs is moved aside, contents kept',
  fs.readdirSync(dir).some((e) => e.startsWith('todos.moved-aside-') &&
    fs.existsSync(path.join(dir, e, 'local-note.json'))))
check('and the link is back', windows.isLink(path.join(dir, 'todos')) && windows.linksHealthy(ROOT, 'Work', OPTS))
windows.removeLink(path.join(dir, 'plans'))
fs.symlinkSync(os.tmpdir(), path.join(dir, 'plans'), process.platform === 'win32' ? 'junction' : 'dir')
check('a link pointing somewhere else is detected', !windows.linksHealthy(ROOT, 'Work', OPTS))
windows.ensureLinks(ROOT, 'Work', OPTS)
check('and repointed without touching what it pointed to', windows.linksHealthy(ROOT, 'Work', OPTS) && fs.existsSync(os.tmpdir()))

console.log('\n-- pins --')
check('an unpinned folder runs as the global account', windows.decide(ROOT, 'C:\\work\\repo', {}, OPTS).source === null)
store.setPin(ROOT, 'C:\\work\\repo', 'Work')
check('pinned', store.getPin(ROOT, 'C:\\work\\repo') === 'Work')
if (process.platform === 'win32') {
  check('matched case-insensitively on Windows', store.getPin(ROOT, 'c:\\WORK\\Repo') === 'Work')
}
check('a trailing separator does not matter', store.getPin(ROOT, 'C:\\work\\repo\\') === 'Work')
let d = windows.decide(ROOT, 'C:\\work\\repo', {}, OPTS)
check('a pin with no window login is refused, not half-applied', d.source === 'pin' && d.ready === false && d.problem === 'no-login')
fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'AT', refreshToken: 'RT' } }))
d = windows.decide(ROOT, 'C:\\work\\repo', {}, OPTS)
check('with a window login it is applied', d.source === 'pin' && d.ready && d.dir === dir && d.name === 'Work')
d = windows.decide(ROOT, 'C:\\anything', { CLAUDE_CONFIG_DIR: dir }, OPTS)
check('a window launched with the variable keeps it (the race-free path)', d.source === 'launch' && d.name === 'Work')
check('names resolve for window folders', windows.nameForDir(ROOT, dir) === 'Work' && windows.isWindowDir(ROOT, dir))
store.setPin(ROOT, 'C:\\other', 'Work')
check('forgetting an account removes all its pins', store.unpinAccount(ROOT, 'Work') === 2 && !store.getPin(ROOT, 'C:\\other'))
check('bad names are rejected', throws(() => store.setPin(ROOT, 'C:\\x', '../evil'), /Invalid/) &&
  throws(() => windows.windowDir(ROOT, '..\\evil'), /Invalid/))

console.log('\n-- launching a pinned window --')
const le = windows.launchEnv(dir, { PATH: 'p', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '9', VSCODE_IPC_HOOK: 'x', CLAUDE_CONFIG_DIR: 'old' })
check('VS Code internals are stripped (ELECTRON_RUN_AS_NODE made Code.exe run as Node)',
  !('ELECTRON_RUN_AS_NODE' in le) && !('VSCODE_PID' in le) && !('VSCODE_IPC_HOOK' in le))
check('the account is set and everything else kept', le.CLAUDE_CONFIG_DIR === dir && le.PATH === 'p')

console.log('\n-- child processes for the default login --')
process.env.CLAUDE_CONFIG_DIR = dir
check('the default login runs with the variable REMOVED, not inherited', !('CLAUDE_CONFIG_DIR' in claude.envFor(null)))
check('nor set to ~/.claude (on macOS that picks a different Keychain item)',
  !('CLAUDE_CONFIG_DIR' in claude.envFor(path.join(HOME, '.claude'))))
check('an explicit folder is passed through', claude.envFor(dir).CLAUDE_CONFIG_DIR === dir)
delete process.env.CLAUDE_CONFIG_DIR

console.log('\n-- forgetting a window login --')
check('removed', windows.remove(ROOT, 'Work', OPTS) === true && !fs.existsSync(dir))
check('THE SHARED HISTORY SURVIVES', fs.existsSync(CANARY) &&
  fs.existsSync(path.join(CLAUDE, 'projects', 'C--work-repo', 'new-chat.jsonl')))
check('every shared folder still exists', windows.SHARED.every((x) => fs.existsSync(path.join(CLAUDE, x))))
check('the global settings are untouched', JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8')).disableRemoteControl === true)
check('removing again is harmless', windows.remove(ROOT, 'Work', OPTS) === false)

fs.rmSync(HOME, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'window login tests failed')
