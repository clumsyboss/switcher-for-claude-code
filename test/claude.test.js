require('./fake-security')
const fs = require('fs')
const os = require('os')
const path = require('path')

const claude = require('../lib/claude.js')

const TMP = path.join(os.tmpdir(), 'cs-claude-' + Date.now())
const HOME = path.join(TMP, 'home')

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  <- ' + extra : '')) }
}

function extension(base, name, exe) {
  const dir = path.join(HOME, base, 'extensions', name)
  fs.mkdirSync(path.join(dir, 'resources', 'native-binary'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'resources', 'native-binary', exe), '')
  return dir
}

const rel = (p) => path.relative(HOME, p).split(path.sep).join('/')

function main() {
  console.log('-- the copy inside the Claude Code extension --')
  check('nothing installed, nothing found', claude.bundled(HOME, [], 'win32').length === 0)

  extension('.vscode', 'anthropic.claude-code-2.1.300-win32-x64', 'claude.exe')
  extension('.vscode', 'anthropic.claude-code-2.1.322-win32-x64', 'claude.exe')
  extension('.vscode', 'anthropic.claude-code-2.1.400-darwin-arm64', 'claude')
  extension('.vscode', 'anthropic.chatgpt-9.9.9', 'claude.exe')
  extension('.vscode-insiders', 'anthropic.claude-code-2.1.310-win32-x64', 'claude.exe')
  let got = claude.bundled(HOME, [], 'win32').map(rel)
  check('on Windows: every installed version, newest first, from VS Code and Insiders', got.join() === [
    '.vscode/extensions/anthropic.claude-code-2.1.322-win32-x64/resources/native-binary/claude.exe',
    '.vscode-insiders/extensions/anthropic.claude-code-2.1.310-win32-x64/resources/native-binary/claude.exe',
    '.vscode/extensions/anthropic.claude-code-2.1.300-win32-x64/resources/native-binary/claude.exe',
  ].join(), got.join(' '))
  const HOME3 = path.join(TMP, 'home3')
  for (const v of ['2.1.99', '2.1.100']) fs.mkdirSync(path.join(HOME3, '.vscode', 'extensions', 'anthropic.claude-code-' + v + '-win32-x64'), { recursive: true })
  check('versions compare as numbers, not text (2.1.100 before 2.1.99)', claude.bundled(HOME3, [], 'win32')[0].includes('2.1.100'))
  check('another platform\'s build and other extensions are left out',
    !got.some((g) => g.includes('darwin') || g.includes('chatgpt')))

  got = claude.bundled(HOME, [], 'darwin').map(rel)
  check('on macOS: the macOS build, named claude', got.length === 1 &&
    got[0] === '.vscode/extensions/anthropic.claude-code-2.1.400-darwin-arm64/resources/native-binary/claude')

  const elsewhere = path.join(TMP, 'portable', 'anthropic.claude-code-2.1.330-win32-x64')
  got = claude.bundled(HOME, [elsewhere], 'win32')
  check('the folder VS Code reports comes first, wherever it is',
    got[0] === path.join(elsewhere, 'resources', 'native-binary', 'claude.exe') && got.length === 4)

  extension('.vscode', 'anthropic.claude-code-3.0.0', process.platform === 'win32' ? 'claude.exe' : 'claude')
  check('a build for every platform counts too', rel(claude.bundled(HOME, [])[0]) ===
    '.vscode/extensions/anthropic.claude-code-3.0.0/resources/native-binary/' + (process.platform === 'win32' ? 'claude.exe' : 'claude'))

  console.log('\n-- resolveBin, with no other claude anywhere --')
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, PATH: process.env.PATH, SHELL: process.env.SHELL }
  const HOME2 = path.join(TMP, 'home2')
  process.env.USERPROFILE = HOME2
  process.env.HOME = HOME2
  process.env.PATH = ''
  process.env.SHELL = path.join(TMP, 'no-shell')
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const own = (v) => path.join(HOME2, '.vscode', 'extensions', 'anthropic.claude-code-' + v + '-' + process.platform + '-x64')
  const binOf = (dir) => path.join(dir, 'resources', 'native-binary', exe)
  for (const v of ['2.1.300', '2.1.322']) { fs.mkdirSync(path.dirname(binOf(own(v))), { recursive: true }); fs.writeFileSync(binOf(own(v)), '') }
  const systemWide = claude.candidates(HOME2).find((c) => fs.existsSync(c))
  if (systemWide) console.log('  (skipped: this machine has claude installed at ' + systemWide + ', which is found first)')
  else try {
    const hinted = path.join(TMP, 'portable', 'anthropic.claude-code-2.1.330')
    claude.addBundledHint(undefined)
    claude.addBundledHint('')
    claude.addBundledHint(hinted)
    check('found: the newest installed copy, the hinted one being missing', claude.resolveBin() === binOf(own('2.1.322')), claude.resolveBin())
    fs.rmSync(own('2.1.322'), { recursive: true, force: true })
    check('after an update deletes that folder, it looks again instead of keeping a path that has gone',
      claude.resolveBin() === binOf(own('2.1.300')), claude.resolveBin())
    fs.mkdirSync(path.dirname(binOf(hinted)), { recursive: true })
    fs.writeFileSync(binOf(hinted), '')
    fs.rmSync(own('2.1.300'), { recursive: true, force: true })
    check('the folder VS Code reports is used first', claude.resolveBin() === binOf(hinted), claude.resolveBin())
    fs.rmSync(hinted, { recursive: true, force: true })
    check('and with nothing left, nothing is found', claude.resolveBin() === null)
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  if (fail) process.exit(1)
}

main()
