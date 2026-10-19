require('./fake-security')

const assert = require('assert')
const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const store = require('../lib/store.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}
const code = (fn) => { try { fn(); return null } catch (e) { return e.code || e.message } }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-store-'))
const REG = path.join(ROOT, 'registry.json')

async function main() {
  console.log('a registry.json that can\'t be read')
  store.setPin(ROOT, '/work/app', 'work')
  store.setDisplay(ROOT, 'work', { label: 'Work', icon: 'briefcase', color: 'blue' })
  const good = fs.readFileSync(REG, 'utf8')
  const broken = good.replace(/}\s*$/, ',\n}')
  fs.writeFileSync(REG, broken)

  check('is read as the defaults, without writing anything', store.getPins(ROOT)['/work/app'] === undefined && fs.readFileSync(REG, 'utf8') === broken)
  check('and says what is wrong', /registry\.json has an error/.test(store.registryError(ROOT) || ''), store.registryError(ROOT))
  for (const [what, fn] of [
    ['the every-30-seconds live log', () => store.recordLive(ROOT, 'work')],
    ['the mode fix-up at startup', () => store.setMode(ROOT, 'login')],
    ['a pin', () => store.setPin(ROOT, '/other', 'work')],
  ]) {
    check(what + ' refuses to write over it', code(fn) === 'EREGISTRY' && fs.readFileSync(REG, 'utf8') === broken)
  }
  fs.writeFileSync(REG, good)
  check('once fixed, everything is back', store.getPin(ROOT, '/work/app') === 'work' && store.displayOf(ROOT, 'work').label === 'Work' &&
    store.registryError(ROOT) === null)

  console.log('backups and file safety')
  store.setPin(ROOT, '/second', 'work')
  const bak = JSON.parse(fs.readFileSync(REG + '.bak', 'utf8'))
  check('the previous good copy is kept in registry.json.bak', bak.pins[store.pinKey('/work/app')] === 'work' && !bak.pins[store.pinKey('/second')])
  if (process.platform !== 'win32') check('registry.json is private (0600)', (fs.statSync(REG).mode & 0o777) === 0o600)

  console.log('values that are not safe to use are dropped on read')
  const reg = JSON.parse(fs.readFileSync(REG, 'utf8'))
  reg.accounts = [{ name: 123 }, null, { name: '../../escape' }, { name: 'fine', icon: 'constructor', label: 'x\n![](https://e.example/b.png)' }]
  reg.pins = { '/a': 7, '/b': '../x', 'relative/c': 'fine', '/d': 'fine' }
  fs.writeFileSync(REG, JSON.stringify(reg))
  const r = store.readRegistry(ROOT)
  check('accounts with invalid names', r.accounts.length === 1 && r.accounts[0].name === 'fine', JSON.stringify(r.accounts))
  check('icons that are object properties, and labels with line breaks', !r.accounts[0].icon && !r.accounts[0].label)
  check('pins to invalid names or relative folders', JSON.stringify(r.pins) === '{"/d":"fine"}', JSON.stringify(r.pins))
  check('a name with a path in it never reaches a folder path', code(() => store.configDir(ROOT, '../../escape')) !== null)

  console.log('pins and symlinked folders (L2)')
  if (process.platform !== 'win32') {
    fs.writeFileSync(REG, JSON.stringify({ accounts: [], active: null }))
    const real = path.join(ROOT, 'proj-real')
    const link = path.join(ROOT, 'proj-link')
    fs.mkdirSync(real)
    fs.symlinkSync(real, link)
    store.setPin(ROOT, link, 'work')
    check('a folder pinned through a symlink is pinned when opened by its real path', store.getPin(ROOT, real) === 'work')
    fs.writeFileSync(REG, JSON.stringify({ accounts: [], active: null, pins: { [link]: 'old' } }))
    check('an older key, saved as the symlink path, still works', store.getPin(ROOT, real) === 'old')
    store.setPin(ROOT, real, 'new')
    check('and re-pinning replaces it rather than adding a second pin', JSON.stringify(Object.values(store.getPins(ROOT))) === '["new"]',
      JSON.stringify(store.getPins(ROOT)))
  }

  console.log('reads reuse the last copy while the file is unchanged')
  fs.writeFileSync(REG, JSON.stringify({ accounts: [{ name: 'one' }], active: 'one' }))
  const first = store.readRegistry(ROOT)
  first.accounts.push({ name: 'two' })
  check('changing what was read changes nothing for the next reader', store.readRegistry(ROOT).accounts.length === 1)
  fs.writeFileSync(REG, JSON.stringify({ accounts: [{ name: 'one' }, { name: 'six' }], active: 'one' }))
  check('an edit by hand is seen at once', store.readRegistry(ROOT).accounts.length === 2)
  fs.writeFileSync(REG, '{"accounts": [,')
  check('and so is one that breaks the file', store.readRegistry(ROOT).accounts.length === 0 && store.registryError(ROOT) !== null)

  console.log('three windows writing at once')
  fs.writeFileSync(REG, JSON.stringify({ accounts: [], active: null }))
  const N = 25
  const kids = [0, 1, 2].map((id) => cp.spawn(process.execPath, ['-e',
    'const s = require(' + JSON.stringify(path.join(__dirname, '..', 'lib', 'store.js')) + ');' +
    'for (let i = 0; i < ' + N + '; i++) { s.setPin(' + JSON.stringify(ROOT) + ', "/w' + id + '/" + i, "acct' + id + '");' +
    ' s.recordLive(' + JSON.stringify(ROOT) + ', i % 2 ? "a" : "b") }'], { stdio: ['ignore', 'ignore', 'pipe'] }))
  let reads = 0
  let bad = 0
  const errs = []
  kids.forEach((k) => k.stderr.on('data', (d) => errs.push(String(d))))
  const timer = setInterval(() => {
    reads++
    try { JSON.parse(fs.readFileSync(REG, 'utf8')) } catch { bad++ }
  }, process.platform === 'win32' ? 25 : 1)
  await Promise.all(kids.map((k) => new Promise((res) => k.on('exit', res))))
  clearInterval(timer)
  const pins = store.getPins(ROOT)
  check('every read of the file was valid JSON', bad === 0 && reads > 0, bad + ' of ' + reads)
  check('no window lost another\'s change', Object.keys(pins).length === 3 * N, Object.keys(pins).length + ' of ' + 3 * N)
  check('and none of them failed', errs.length === 0, errs.join('').slice(0, 300))

  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  assert.strictEqual(failed, 0, 'store tests failed')
}

main().catch((e) => { console.error(e); process.exit(1) })
