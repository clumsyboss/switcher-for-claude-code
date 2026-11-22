require('./fake-security')
const assert = require('assert')
const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const un = require('../scripts/uninstall')

let pass = 0
let fail = 0
function check(name, ok) {
  if (ok) { pass++; console.log('  PASS  ' + name) } else { fail++; console.log('  FAIL  ' + name) }
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-')))
const KEY = un.KEY

function parseJsonc(text) {
  const toks = un.tokens(text)
  const parts = []
  toks.forEach((t, i) => {
    if (t.t === ',' && toks[i + 1] && (toks[i + 1].t === '}' || toks[i + 1].t === ']')) return
    parts.push(text.slice(t.start, t.end))
  })
  return JSON.parse(parts.join(''))
}

console.log('-- where VS Code keeps its user settings --')
check('Windows: under APPDATA, Code and Code - Insiders first',
  JSON.stringify(un.userDirs({ platform: 'win32', home: 'C:\\Users\\someone', env: { APPDATA: 'D:\\Roaming' } }).slice(0, 2)) ===
  JSON.stringify(['D:\\Roaming\\Code\\User', 'D:\\Roaming\\Code - Insiders\\User']))
check('and the editors built on VS Code: Cursor, Windsurf, VSCodium and the rest', (() => {
  const d = un.userDirs({ platform: 'win32', home: 'C:\\Users\\someone', env: { APPDATA: 'D:\\Roaming' } })
  return ['Cursor', 'Cursor Nightly', 'Windsurf', 'Windsurf - Next', 'VSCodium', 'VSCodium - Insiders', 'Code - OSS', 'Antigravity', 'Kiro', 'Trae', 'Positron']
    .every((n) => d.includes('D:\\Roaming\\' + n + '\\User')) && d.length === un.PRODUCTS.length
})())
check('on macOS too', un.userDirs({ platform: 'darwin', home: '/Users/someone', env: {} }).includes('/Users/someone/Library/Application Support/Cursor/User'))
check('Windows without APPDATA: the usual place in the home folder',
  un.userDirs({ platform: 'win32', home: 'C:\\Users\\someone', env: {} })[0] === 'C:\\Users\\someone\\AppData\\Roaming\\Code\\User')
check('macOS: Library/Application Support',
  JSON.stringify(un.userDirs({ platform: 'darwin', home: '/Users/someone', env: {} })) ===
  JSON.stringify(['/Users/someone/Library/Application Support/Code/User', '/Users/someone/Library/Application Support/Code - Insiders/User'].concat(
    un.PRODUCTS.slice(2).map((n) => '/Users/someone/Library/Application Support/' + n + '/User'))))
check('Linux: XDG_CONFIG_HOME, else ~/.config',
  un.userDirs({ platform: 'linux', home: '/home/someone', env: { XDG_CONFIG_HOME: '/cfg' } })[0] === '/cfg/Code/User' &&
  un.userDirs({ platform: 'linux', home: '/home/someone', env: {} })[1] === '/home/someone/.config/Code - Insiders/User')

console.log('-- is it ours? --')
check('a wrapper in ~/.claude-switcher/bin is ours', un.pointsInto('C:\\Users\\someone\\.claude-switcher\\bin\\claude-wrapper.exe', 'C:\\Users\\someone\\.claude-switcher\\bin', 'win32'))
check('on Windows whatever the slashes and letter case', un.pointsInto('c:/users/SOMEONE/.Claude-Switcher/BIN/claude-wrapper.exe', 'C:\\Users\\someone\\.claude-switcher\\bin', 'win32'))
check('on Linux letter case counts', !un.pointsInto('/home/someone/.Claude-Switcher/bin/claude-wrapper.sh', '/home/someone/.claude-switcher/bin', 'linux') &&
  un.pointsInto('/home/someone/.claude-switcher/bin/claude-wrapper.sh', '/home/someone/.claude-switcher/bin', 'linux'))
check('not a folder that only starts the same, not a climb out, not the folder itself, not a relative path',
  !un.pointsInto('/home/someone/.claude-switcher/bin2/w.sh', '/home/someone/.claude-switcher/bin', 'linux') &&
  !un.pointsInto('/home/someone/.claude-switcher/bin/../w.sh', '/home/someone/.claude-switcher/bin', 'linux') &&
  !un.pointsInto('/home/someone/.claude-switcher/bin', '/home/someone/.claude-switcher/bin', 'linux') &&
  !un.pointsInto('.claude-switcher/bin/w.sh', '/home/someone/.claude-switcher/bin', 'linux') &&
  !un.pointsInto(42, '/home/someone/.claude-switcher/bin', 'linux'))

console.log('-- the edit --')
const BIN = '/home/someone/.claude-switcher/bin'
const OURS = JSON.stringify(BIN + '/claude-wrapper.sh')
const rm = (t) => un.removeWrapperSetting(t, BIN, 'linux')
const mid = '{\n  // my settings\n  "editor.fontSize": 14,\n  "' + KEY + '": ' + OURS + ',\n  /* keep */\n  "files.autoSave": "afterDelay",\n}\n'
check('in the middle: just that line goes, comments and the trailing comma stay',
  rm(mid) === '{\n  // my settings\n  "editor.fontSize": 14,\n  /* keep */\n  "files.autoSave": "afterDelay",\n}\n')
check('the result is still valid settings, with everything else in it', JSON.stringify(parseJsonc(rm(mid))) === JSON.stringify({ 'editor.fontSize': 14, 'files.autoSave': 'afterDelay' }))
const last = '{\n  "a": 1, // one\n  "' + KEY + '": ' + OURS + '\n}'
check('the last one: the comma before it goes too, its comment stays', rm(last) === '{\n  "a": 1 // one\n}')
check('the only one: an empty object', rm('{\n  "' + KEY + '": ' + OURS + '\n}\n') === '{\n}\n')
check('all on one line', rm('{"a":1,"' + KEY + '":' + OURS + ',"b":2}') === '{"a":1,"b":2}' && rm('{"a":1,"' + KEY + '":' + OURS + '}') === '{"a":1}')
check('the last, with a trailing comma', rm('{\n "a": 1,\n "' + KEY + '": ' + OURS + ',\n}') === '{\n "a": 1,\n}')
check('Windows line endings', rm('{\r\n  "a": 1,\r\n  "' + KEY + '": ' + OURS + ',\r\n  "b": 2\r\n}\r\n') === '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n')
check('a byte-order mark stays', rm('\ufeff{\n  "' + KEY + '": ' + OURS + ',\n  "a": 1\n}') === '\ufeff{\n  "a": 1\n}')
check('a comment after it on its line stays', rm('{\n  "' + KEY + '": ' + OURS + ', // switcher\n  "a": 1\n}') === '{\n  // switcher\n  "a": 1\n}')
check('every copy of it goes', rm('{\n  "' + KEY + '": ' + OURS + ',\n  "a": 1,\n  "' + KEY + '": ' + OURS + '\n}') === '{\n  "a": 1\n}')
check('someone else\'s wrapper: nothing changes', rm('{\n  "' + KEY + '": "/opt/tools/my-wrapper"\n}') === null)
check('only the top level: the same name inside another setting stays',
  rm('{\n  "[python]": { "' + KEY + '": ' + OURS + ' },\n  "a": 1\n}') === null)
check('a mention in a comment or another value: nothing changes',
  rm('{\n  // "' + KEY + '": ' + OURS.replace(/"/g, '') + '\n  "note": "' + KEY + '"\n}') === null)
check('a value that isn\'t a string: nothing changes', rm('{\n  "' + KEY + '": null\n}') === null)
check('a file it can\'t follow (an open comment or string): nothing changes, no error',
  rm('{\n  /* open\n  "' + KEY + '": ' + OURS + '\n}') === null && rm('{ "' + KEY + '": "/home/someone/.claude-switcher/bin/x') === null)
check('not an object at all: nothing changes', rm('') === null && rm('[1, 2]') === null && rm('hello') === null)

console.log('-- running it --')
const home = path.join(tmp, 'home')
const plat = process.platform
const binDir = path.join(home, '.claude-switcher', 'bin')
const ourPath = JSON.stringify(path.join(binDir, plat === 'win32' ? 'claude-wrapper.exe' : 'claude-wrapper.sh'))
const env = { APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(home, '.config') }
const dirs = un.userDirs({ platform: plat, home, env })
const stable = path.join(dirs[0], 'settings.json')
const insiders = path.join(dirs[1], 'settings.json')
const profile = path.join(dirs[0], 'profiles', 'a1b2c3', 'settings.json')
const foreign = path.join(dirs[0], 'profiles', 'd4e5f6', 'settings.json')
for (const f of [stable, insiders, profile, foreign]) fs.mkdirSync(path.dirname(f), { recursive: true })
fs.writeFileSync(stable, '{\n  "editor.tabSize": 2,\n  "' + KEY + '": ' + ourPath + '\n}\n')
fs.writeFileSync(insiders, '{\n  // nothing of ours\n  "editor.tabSize": 4,\n}\n')
fs.writeFileSync(profile, '{ "' + KEY + '": ' + ourPath + ', "x": true }')
const foreignText = '{ "' + KEY + '": "/opt/tools/my-wrapper" }'
fs.writeFileSync(foreign, foreignText)
const insidersBefore = fs.statSync(insiders).mtimeMs
check('it finds the default profile\'s and each named profile\'s settings', un.settingsFiles({ platform: plat, home, env }).filter((f) => fs.existsSync(f)).sort().join('|') ===
  [stable, insiders, profile, foreign].sort().join('|'))
const results = un.run({ home, platform: plat, env })
check('ours is taken out where it was set', results.filter((r) => r.changed).map((r) => r.file).sort().join('|') === [stable, profile].sort().join('|') &&
  fs.readFileSync(stable, 'utf8') === '{\n  "editor.tabSize": 2\n}\n' && fs.readFileSync(profile, 'utf8') === '{ "x": true }')
check('files without it, and someone else\'s wrapper, are left exactly as they were',
  fs.readFileSync(foreign, 'utf8') === foreignText && fs.statSync(insiders).mtimeMs === insidersBefore && results.every((r) => !r.error))
check('no temp files are left behind', fs.readdirSync(dirs[0]).every((n) => !n.endsWith('.tmp')))
check('a second run changes nothing', un.run({ home, platform: plat, env }).every((r) => !r.changed))
check('it never throws, whatever it\'s given', (() => {
  try {
    const r = un.run({ home, platform: plat, files: [path.join(tmp, 'missing.json'), dirs[0], 42] })
    return Array.isArray(r) && r.every((x) => !x.changed)
  } catch { return false }
})())

fs.writeFileSync(stable, '{\n  "' + KEY + '": ' + ourPath + ',\n  "a": 1\n}\n')
const childEnv = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, APPDATA: env.APPDATA, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME })
const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'uninstall.js')], { env: childEnv, encoding: 'utf8', timeout: 20000 })
check('run as a script: exits cleanly and does the same', r.status === 0 && fs.readFileSync(stable, 'utf8') === '{\n  "a": 1\n}\n')

console.log('-- the recorded editors, and what Artifacts off added to Claude Code\'s settings --')
{
  const editors = require('../lib/editors')
  const store = require('../lib/store')
  const artifacts = require('../lib/artifacts')
  const h = path.join(tmp, 'home2')
  const root = path.join(h, '.claude-switcher')
  const claudeSettings = path.join(h, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true })
  const readC = () => JSON.parse(fs.readFileSync(claudeSettings, 'utf8'))
  const userA = path.join(h, 'apps', 'Code', 'User')
  const userB = path.join(h, 'apps', 'SomeFork', 'User')
  const extA = path.join(h, 'ext-a', 'publisher.switcher-1.5.0')
  const extB = path.join(h, 'ext-b', 'publisher.switcher-1.5.0')
  for (const d of [userA, userB, extA, extB]) fs.mkdirSync(d, { recursive: true })
  const wrapper = JSON.stringify(path.join(root, 'bin', 'claude-wrapper.exe'))
  fs.writeFileSync(path.join(userA, 'settings.json'), '{\n  "' + KEY + '": ' + wrapper + ',\n  "a": 1\n}\n')
  fs.writeFileSync(path.join(userB, 'settings.json'), '{\n  "' + KEY + '": ' + wrapper + ',\n  "b": 1\n}\n')

  check('the User folder is two levels up from the global storage folder', editors.userDirOf(path.join(userB, 'globalStorage', 'publisher.switcher')) === userB &&
    editors.userDirOf('/not/a/storage/folder') === null && editors.userDirOf(undefined) === null)
  check('recording an editor writes the list', editors.record(root, userA, extA) === true && editors.record(root, userB, extB) === true)
  const stamp = fs.statSync(editors.filePath(root)).mtimeMs
  check('recording it again unchanged doesn\'t write', editors.record(root, userA, extA) === false && fs.statSync(editors.filePath(root)).mtimeMs === stamp)
  check('both are listed', editors.read(root).length === 2)
  check('a broken list reads as empty, and recording never throws', (() => {
    const other = path.join(tmp, 'broken-root'); fs.mkdirSync(other, { recursive: true }); fs.writeFileSync(path.join(other, editors.FILE), '{nope')
    return editors.read(other).length === 0 && editors.record(other, 'relative/User', extA) === false
  })())

  fs.writeFileSync(claudeSettings, JSON.stringify({ permissions: { deny: ['Bash(rm -rf:*)'] }, model: 'opus' }, null, 2) + '\n')
  store.setActive(root, 'acctA')
  store.setArtifacts(root, 'acctA', 'off')
  artifacts.setOff(true, { home: h }, root)
  check('(set up: the rules and enableArtifact are in)', readC().enableArtifact === false && artifacts.DENY.every((e) => readC().permissions.deny.includes(e)))

  let res = un.run({ home: h, platform: process.platform, env: {}, root, ext: extA })
  check('uninstall from one editor: that editor\'s wrapper setting goes', fs.readFileSync(path.join(userA, 'settings.json'), 'utf8') === '{\n  "a": 1\n}\n')
  check('the other editor\'s wrapper setting stays', fs.readFileSync(path.join(userB, 'settings.json'), 'utf8').includes(KEY))
  check('while another editor has it installed, the shared rules and enableArtifact stay', readC().enableArtifact === false &&
    artifacts.DENY.every((e) => readC().permissions.deny.includes(e)) && res.some((x) => x.shared && x.skipped), JSON.stringify(res))
  check('its own entry is forgotten, the other one\'s kept', editors.read(root).length === 1 && editors.same(editors.read(root)[0].ext, extB))

  res = un.run({ home: h, platform: process.platform, env: {}, root, ext: extB })
  check('the last uninstall takes out its wrapper setting', !fs.readFileSync(path.join(userB, 'settings.json'), 'utf8').includes(KEY))
  check('and only the rules the switcher added, the user\'s own kept', JSON.stringify(readC().permissions.deny) === JSON.stringify(['Bash(rm -rf:*)']) &&
    readC().model === 'opus', JSON.stringify(readC()))
  check('and enableArtifact, which the switcher wrote', !('enableArtifact' in readC()))
  check('the record is cleared, and the list is empty', store.getArtifactsAdded(root) === null && editors.read(root).length === 0)
  check('a second run changes nothing', un.run({ home: h, platform: process.platform, env: {}, root, ext: extB }).every((x) => !x.changed))

  fs.writeFileSync(claudeSettings, JSON.stringify({}, null, 2) + '\n')
  artifacts.setOff(true, { home: h }, root)
  editors.record(root, userB, path.join(h, 'ext-gone', 'publisher.switcher-1.4.0'))
  un.run({ home: h, platform: process.platform, env: {}, root, ext: extA })
  check('a recorded copy whose folder is gone counts as uninstalled', JSON.stringify(readC()) === '{}', JSON.stringify(readC()))

  store.setArtifacts(root, 'acctA', 'on')
  fs.writeFileSync(claudeSettings, JSON.stringify({ enableArtifact: false }, null, 2) + '\n')
  artifacts.setOff(true, { home: h }, root)
  un.run({ home: h, platform: process.platform, env: {}, root, ext: extA })
  check('created permissions and deny go when empty; enableArtifact the switcher didn\'t write stays', JSON.stringify(readC()) === '{"enableArtifact":false}', JSON.stringify(readC()))
  check('an unreadable settings file: no error thrown, left as it was', (() => {
    store.setArtifacts(root, 'acctA', 'off')
    fs.writeFileSync(claudeSettings, '{ not json')
    try { const rr = un.run({ home: h, platform: process.platform, env: {}, root, ext: extA }); return Array.isArray(rr) && fs.readFileSync(claudeSettings, 'utf8') === '{ not json' } catch { return false }
  })())

  fs.writeFileSync(claudeSettings, JSON.stringify({}, null, 2) + '\n')
  store.setArtifacts(root, 'acctA', 'on')
  artifacts.setOff(true, { home: h }, root)
  const offline = path.join(h, 'ext-offline', 'publisher.switcher-1.5.0')
  editors.record(root, userB, offline)
  const realStat = fs.statSync
  fs.statSync = function (p, ...rest) {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(offline)) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e }
    return realStat.call(fs, p, ...rest)
  }
  try {
    res = un.run({ home: h, platform: process.platform, env: {}, root, ext: extA })
  } finally { fs.statSync = realStat }
  check('a recorded copy that can\'t be reached counts as installed: the shared rules stay', artifacts.DENY.every((e) => (readC().permissions || { deny: [] }).deny.includes(e)) &&
    res.some((x) => x.shared && x.skipped), JSON.stringify(readC()))
  const aFile = path.join(h, 'a-file'); fs.writeFileSync(aFile, 'x')
  editors.record(root, userB, path.join(aFile, 'publisher.switcher-1.5.0'))
  un.run({ home: h, platform: process.platform, env: {}, root, ext: extA })
  check('a recorded copy under a file counts as uninstalled: the shared rules go', !('permissions' in readC()), JSON.stringify(readC()))
}

console.log('-- VS Code profiles, and an extensions folder reached through a link --')
{
  const editors = require('../lib/editors')
  const h = path.join(tmp, 'home3')
  const root = path.join(h, '.claude-switcher')
  const wrapper = JSON.stringify(path.join(root, 'bin', 'claude-wrapper.exe'))
  const withOurs = (extra) => '{\n  "' + KEY + '": ' + wrapper + ',\n  "' + extra + '": 1\n}\n'
  const user = path.join(h, 'apps', 'Code', 'User')
  const ext = path.join(h, 'ext', 'publisher.switcher-1.5.0')
  const dflt = path.join(user, 'settings.json')
  const prof = path.join(user, 'profiles', '7a3f9e', 'settings.json')
  for (const d of [path.dirname(prof), ext]) fs.mkdirSync(d, { recursive: true })

  check('a named profile\'s global storage folder maps up to the editor\'s User folder',
    editors.userDirOf(path.join(user, 'profiles', '7a3f9e', 'globalStorage', 'publisher.switcher')) === user &&
    editors.userDirOf(path.join(user, 'globalStorage', 'publisher.switcher')) === user &&
    editors.userDirOf(path.join(h, 'x', 'profiles', 'p', 'globalStorage', 'publisher.switcher')) === path.join(h, 'x', 'profiles', 'p'))
  check('recording from a profile and from the default profile gives one entry, the User folder', (() => {
    editors.record(root, editors.userDirOf(path.join(user, 'profiles', '7a3f9e', 'globalStorage', 'publisher.switcher')), ext)
    editors.record(root, editors.userDirOf(path.join(user, 'globalStorage', 'publisher.switcher')), ext)
    const l = editors.read(root); return l.length === 1 && editors.same(l[0].user, user)
  })())
  fs.writeFileSync(dflt, withOurs('a'))
  fs.writeFileSync(prof, withOurs('p'))
  un.run({ home: h, platform: process.platform, env: {}, root, ext, shared: false })
  check('uninstall cleans both the default and the profile settings', fs.readFileSync(dflt, 'utf8') === '{\n  "a": 1\n}\n' && fs.readFileSync(prof, 'utf8') === '{\n  "p": 1\n}\n')

  const user2 = path.join(h, 'apps', 'Other', 'User')
  fs.mkdirSync(user2, { recursive: true })
  fs.writeFileSync(editors.filePath(root), JSON.stringify([{ user: path.join(user, 'profiles', '7a3f9e'), ext }, { user: user2, ext }]))
  fs.writeFileSync(dflt, withOurs('a'))
  fs.writeFileSync(prof, withOurs('p'))
  fs.writeFileSync(path.join(user2, 'settings.json'), withOurs('o'))
  un.run({ home: h, platform: process.platform, env: {}, root, ext, shared: false })
  check('every entry of the copy being uninstalled is cleaned, not just the first', !fs.readFileSync(dflt, 'utf8').includes(KEY) &&
    !fs.readFileSync(prof, 'utf8').includes(KEY) && !fs.readFileSync(path.join(user2, 'settings.json'), 'utf8').includes(KEY) && editors.read(root).length === 0)

  const realExt = path.join(h, 'real-extensions')
  const linked = path.join(h, 'linked-extensions')
  const realCopy = path.join(realExt, 'publisher.switcher-1.5.0')
  fs.mkdirSync(realCopy, { recursive: true })
  let linkOk = true
  try { fs.symlinkSync(realExt, linked, process.platform === 'win32' ? 'junction' : 'dir') } catch (e) { linkOk = false; console.log('  SKIP  a linked extensions folder: this system would not make a link (' + ((e && e.code) || e) + ')') }
  if (linkOk) {
    const viaLink = path.join(linked, 'publisher.switcher-1.5.0')
    check('a copy reached through a link is the same folder as its real path', editors.same(viaLink, realCopy))
    check('recording keeps the real path', editors.record(root, user, viaLink) && editors.read(root)[0].ext === fs.realpathSync.native(realCopy))
    fs.writeFileSync(editors.filePath(root), JSON.stringify([{ user, ext: viaLink }]))
    fs.writeFileSync(dflt, withOurs('a'))
    const rr = un.run({ home: h, platform: process.platform, env: {}, root, ext: realCopy })
    check('the script running from the real path still knows the linked entry as its own: wrapper cleaned, entry forgotten, not skipped',
      !fs.readFileSync(dflt, 'utf8').includes(KEY) && editors.read(root).length === 0 && !rr.some((x) => x.skipped), JSON.stringify(rr))
  }
}

const repo = path.join(__dirname, '..')
check('the build packages the uninstall script', /const PAYLOAD = \[[^\]]*'scripts\/uninstall\.js'/.test(fs.readFileSync(path.join(repo, 'build.js'), 'utf8')))
check('VS Code runs it on uninstall', JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).scripts['vscode:uninstall'] === 'node ./scripts/uninstall.js')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(pass + ' passed, ' + fail + ' failed')
assert.strictEqual(fail, 0, 'uninstall tests failed')
