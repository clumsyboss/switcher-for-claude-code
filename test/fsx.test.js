require('./fake-security')

const assert = require('assert')
const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const fsx = require('../lib/fsx.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}
const code = (fn) => { try { fn(); return null } catch (e) { return e.code || e.message } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-fsx-'))
const f = (n) => path.join(TMP, n)
const posix = process.platform !== 'win32'

console.log('readJsonForWrite')
{
  check('a missing file is an empty object', JSON.stringify(fsx.readJsonForWrite(f('none.json')).data) === '{}')
  for (const [what, text] of [['half-written', '{"a": {'], ['empty', ''], ['null', 'null'], ['an array', '[1]'], ['a string', '"x"']]) {
    fs.writeFileSync(f('bad.json'), text)
    check('a file that is ' + what + ' is refused, not read as {}', code(() => fsx.readJsonForWrite(f('bad.json'))) === 'EUNREADABLEJSON')
  }
  fs.writeFileSync(f('bom.json'), '﻿{"a":1}')
  check('a byte-order mark is fine', fsx.readJsonForWrite(f('bom.json')).data.a === 1)
  check('and it says when it was read, for a later write to check', !!fsx.readJsonForWrite(f('bom.json')).stamp)
}

console.log('writeFileAtomic')
{
  fsx.writeJsonAtomic(f('new.json'), { a: 1 })
  if (posix) check('a new file is private (0600)', (fs.statSync(f('new.json')).mode & 0o777) === 0o600)
  if (posix) {
    fs.writeFileSync(f('shared.json'), '{}')
    fs.chmodSync(f('shared.json'), 0o640)
    fsx.writeJsonAtomic(f('shared.json'), { b: 2 })
    check('an existing file keeps its permissions', (fs.statSync(f('shared.json')).mode & 0o777) === 0o640)
    fsx.writeJsonAtomic(f('shared.json'), { b: 3 }, { mode: 0o600, forceMode: true })
    check('unless the caller says the file must be private', (fs.statSync(f('shared.json')).mode & 0o777) === 0o600)

    fs.writeFileSync(f('target.json'), '{}')
    fs.symlinkSync(f('target.json'), f('link.json'))
    fsx.writeJsonAtomic(f('link.json'), { c: 1 })
    check('a symlink stays a link', fs.lstatSync(f('link.json')).isSymbolicLink())
    check('and the file it points to is the one written', JSON.parse(fs.readFileSync(f('target.json'), 'utf8')).c === 1)
  }

  fs.writeFileSync(f('race.json'), '{"v":1}')
  const { stamp } = fsx.readJsonForWrite(f('race.json'))
  const later = new Date(Date.now() + 5000)
  fs.writeFileSync(f('race.json'), '{"v":2,"theirs":true}')
  fs.utimesSync(f('race.json'), later, later)
  check('a write made by someone else since the read is detected, not overwritten',
    code(() => fsx.writeJsonAtomic(f('race.json'), { v: 3 }, { expect: stamp })) === 'ECONCURRENTWRITE' &&
    JSON.parse(fs.readFileSync(f('race.json'), 'utf8')).theirs === true)
  check('no temp file is left behind', !fs.readdirSync(TMP).some((n) => fsx.TEMP_RE.test(n)), fs.readdirSync(TMP).join(','))
}

console.log('stale temp files')
{
  const dead = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
  fs.writeFileSync(f('cfg.json.tmp-' + dead + '-abcdef12'), 'secret')
  fs.writeFileSync(f('cfg.json.tmp-' + process.pid + '-abcdef12'), 'mine, in progress')
  check('a crashed write\'s temp file is removed', fsx.removeStaleTemps(TMP, ['cfg.json']) === 1 &&
    !fs.existsSync(f('cfg.json.tmp-' + dead + '-abcdef12')))
  check('one a running process is writing is left alone', fs.existsSync(f('cfg.json.tmp-' + process.pid + '-abcdef12')))
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'fsx tests failed')
