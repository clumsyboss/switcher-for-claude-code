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
check('Windows: under APPDATA, Code and Code - Insiders',
  JSON.stringify(un.userDirs({ platform: 'win32', home: 'C:\\Users\\someone', env: { APPDATA: 'D:\\Roaming' } })) ===
  JSON.stringify(['D:\\Roaming\\Code\\User', 'D:\\Roaming\\Code - Insiders\\User']))
check('Windows without APPDATA: the usual place in the home folder',
  un.userDirs({ platform: 'win32', home: 'C:\\Users\\someone', env: {} })[0] === 'C:\\Users\\someone\\AppData\\Roaming\\Code\\User')
check('macOS: Library/Application Support',
  JSON.stringify(un.userDirs({ platform: 'darwin', home: '/Users/someone', env: {} })) ===
  JSON.stringify(['/Users/someone/Library/Application Support/Code/User', '/Users/someone/Library/Application Support/Code - Insiders/User']))
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

const repo = path.join(__dirname, '..')
check('the build packages the uninstall script', /const PAYLOAD = \[[^\]]*'scripts\/uninstall\.js'/.test(fs.readFileSync(path.join(repo, 'build.js'), 'utf8')))
check('VS Code runs it on uninstall', JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).scripts['vscode:uninstall'] === 'node ./scripts/uninstall.js')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(pass + ' passed, ' + fail + ' failed')
assert.strictEqual(fail, 0, 'uninstall tests failed')
