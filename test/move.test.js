require('./fake-security')

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const moveLib = require('../lib/movefile.js')
const secrets = require('../lib/secrets.js')
const profiles = require('../lib/profiles.js')
const store = require('../lib/store.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-move-'))
const PASS = 'correct horse 42'
const account = (name, rt) => ({
  name,
  payload: { credentials: { claudeAiOauth: { accessToken: 'AT-' + rt, refreshToken: rt, expiresAt: Date.now() + 3600e3 } },
    identity: { oauthAccount: { emailAddress: name.toLowerCase() + '@example.com', organizationName: 'Acme' } },
    capturedAt: new Date().toISOString() },
  meta: { email: name.toLowerCase() + '@example.com', org: 'Acme', capturedAt: new Date().toISOString() },
  display: { label: name + ' (spare)', icon: 'rocket', color: 'teal' },
  remote: 'off',
  artifacts: 'on',
})

console.log('\n-- the file format --')
const bundle = { exportedAt: new Date().toISOString(), accounts: [account('Work', 'RT-WORK-SPARE')] }
const sealed = moveLib.seal(bundle, PASS)
check('the right passphrase opens it', JSON.stringify(moveLib.open(sealed, PASS)) === JSON.stringify(bundle))
check('no token or email can be read in it', !/RT-WORK|example\.com/.test(sealed))
check('two seals of the same thing differ (fresh salt and IV each time)', moveLib.seal(bundle, PASS) !== sealed)
let err = null
try { moveLib.open(sealed, 'wrong horse 42') } catch (e) { err = e }
check('a wrong passphrase is refused, with a reason', err && /Wrong passphrase/.test(err.message))
err = null
try { moveLib.open('{"hello":1}', PASS) } catch (e) { err = e }
check('a file that isn\'t a move file is refused', err && /not an account move file/.test(err.message))
err = null
const tampered = JSON.parse(sealed)
tampered.data = Buffer.from(Buffer.from(tampered.data, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b))).toString('base64')
try { moveLib.open(JSON.stringify(tampered), PASS) } catch (e) { err = e }
check('a damaged file is refused rather than half-read', err && /damaged/.test(err.message))
err = null
try { moveLib.seal(bundle, 'short') } catch (e) { err = e }
check('a passphrase under ' + moveLib.MIN_PASSPHRASE + ' characters is refused', err && /at least/.test(err.message))

const SCRIPT = path.join(__dirname, '..', 'scripts', 'move-accounts.js')
if (!fs.existsSync(SCRIPT)) {
  console.log('\n-- move-accounts.js is not in this copy: skipping its checks --')
} else {
  const run = (rootDir, args) => cp.spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_SWITCHER_ROOT: rootDir, MOVE_PASSPHRASE: PASS }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tokenOf = (rootDir, name) => profiles.readPayload(rootDir, name).credentials.claudeAiOauth.refreshToken

  console.log('\n-- a file the extension made imports with the script --')
  const B = path.join(TMP, 'other-pc')
  const file = path.join(TMP, 'work-login.move')
  fs.writeFileSync(file, sealed)
  let r = run(B, ['import', file])
  check('imported', /Added: Work/.test(r.stdout) && profiles.exists(B, 'Work'), r.stdout + r.stderr)
  check('with its own login', tokenOf(B, 'Work') === 'RT-WORK-SPARE')
  check('and its name, icon, colour and Remote Control choice',
    store.displayOf(B, 'Work').label === 'Work (spare)' && store.displayOf(B, 'Work').color === 'teal' &&
    store.getRemote(B, 'Work') === 'off')

  console.log('\n-- --replace swaps a fresh login in for an existing one --')
  fs.writeFileSync(file, moveLib.seal({ accounts: [account('Work', 'RT-WORK-NEWER')] }, PASS))
  r = run(B, ['import', file])
  check('without it, an account already saved is left alone', /Skipped: Work/.test(r.stdout) && tokenOf(B, 'Work') === 'RT-WORK-SPARE', r.stdout)
  r = run(B, ['import', file, '--replace'])
  check('with it, the new login takes its place', /Added: Work/.test(r.stdout) && tokenOf(B, 'Work') === 'RT-WORK-NEWER', r.stdout + r.stderr)

  console.log('\n-- and the script\'s own exports open with the library --')
  const A = path.join(TMP, 'this-pc')
  store.ensureRoot(A)
  fs.mkdirSync(profiles.profilesDir(A), { recursive: true })
  const p = account('Personal', 'RT-PERSONAL')
  fs.writeFileSync(path.join(profiles.profilesDir(A), 'Personal.enc'), secrets.protect(Buffer.from(JSON.stringify(p.payload))))
  profiles.writeMeta(A, 'Personal', p.meta)
  const out = path.join(TMP, 'personal.move')
  r = run(A, ['export', out, 'Personal'])
  check('exported and moved out', /Moved out of this PC: Personal/.test(r.stdout) && !profiles.exists(A, 'Personal'), r.stdout + r.stderr)
  const opened = moveLib.open(fs.readFileSync(out, 'utf8'), PASS)
  check('the library reads it', opened.accounts[0].name === 'Personal' &&
    opened.accounts[0].payload.credentials.claudeAiOauth.refreshToken === 'RT-PERSONAL')
  if (process.platform !== 'win32') check('the file is private (0600)', (fs.statSync(out).mode & 0o777) === 0o600)
  check('and a copy of what was moved out stays in backups/', fs.readdirSync(path.join(A, 'backups')).some((f) => f.startsWith('Personal-')))

  console.log('\n-- a used file can\'t be imported twice (audit #9) --')
  const once = path.join(TMP, 'once.move')
  fs.writeFileSync(once, moveLib.seal({ exportedAt: new Date().toISOString(), accounts: [account('Solo', 'RT-SOLO')] }, PASS))
  const C = path.join(TMP, 'third-pc')
  r = run(C, ['import', once])
  const used = fs.readdirSync(TMP).find((f) => f.startsWith('once.move.imported-'))
  check('once imported, the file is renamed', /Added: Solo/.test(r.stdout) && !fs.existsSync(once) && !!used, r.stdout + r.stderr)
  r = run(path.join(TMP, 'fourth-pc'), ['import', path.join(TMP, used)])
  check('and the renamed file is refused', /already imported/.test(r.stderr) && !profiles.exists(path.join(TMP, 'fourth-pc'), 'Solo'), r.stderr)

  console.log('\n-- nothing in a file is trusted as it is (audit #9) --')
  const crafted = path.join(TMP, 'crafted.move')
  const bad = account('Shiny', 'RT-SHINY')
  bad.meta = { ...bad.meta, name: 'Work', email: 'victim@example.com', needsLogin: true, extra: 'x'.repeat(10) }
  bad.display = { label: 'Team\n\n![x](https://evil.example/b.png)', icon: 'constructor', color: 'ultraviolet' }
  const injected = account('Inject', 'RT-INJ')
  injected.payload.identity.oauthAccount.emailAddress = 'ops@acme.io; touch /tmp/pwned'
  const empty = { name: 'Empty', payload: { credentials: {}, identity: {} } }
  const traversal = account('../../escape', 'RT-ESC')
  fs.writeFileSync(crafted, moveLib.seal({ exportedAt: new Date().toISOString(), accounts: [bad, injected, empty, traversal] }, PASS))
  const D = path.join(TMP, 'crafted-pc')
  r = run(D, ['import', crafted])
  check('a usable account is imported', /Added: Shiny/.test(r.stdout) && profiles.exists(D, 'Shiny'), r.stdout + r.stderr)
  const shiny = profiles.list(D).find((x) => x.name === 'Shiny') || {}
  check('its sidecar can\'t rename it, or claim another email', shiny.name === 'Shiny' && shiny.email === 'shiny@example.com' && !shiny.needsLogin && !('extra' in shiny))
  check('a label with line breaks, an icon named "constructor" and an unknown colour are dropped',
    store.displayOf(D, 'Shiny').label === 'Shiny' && store.displayOf(D, 'Shiny').icon === 'account' && store.displayOf(D, 'Shiny').color === null)
  check('an account whose only email is shell text is refused', /Inject \(no account details/.test(r.stdout) && !profiles.exists(D, 'Inject'), r.stdout)
  check('so is one with no login, and one whose name is a path', /Empty \(no usable login/.test(r.stdout) && /not a valid name/.test(r.stdout))

  console.log('\n-- --replace only swaps in the same account, never an older login (audit #9) --')
  const other = account('Shiny', 'RT-OTHER')
  other.payload.identity.oauthAccount.emailAddress = 'someone-else@example.com'
  const otherFile = path.join(TMP, 'other.move')
  fs.writeFileSync(otherFile, moveLib.seal({ exportedAt: new Date().toISOString(), accounts: [other] }, PASS))
  r = run(D, ['import', otherFile, '--replace'])
  check('a different account under the same name is refused', /different one/.test(r.stdout) && tokenOf(D, 'Shiny') === 'RT-SHINY', r.stdout)
  const older = path.join(TMP, 'older.move')
  fs.writeFileSync(older, moveLib.seal({ exportedAt: new Date(Date.now() - 86400e3).toISOString(), accounts: [account('Shiny', 'RT-OLD')] }, PASS))
  r = run(D, ['import', older, '--replace'])
  check('a login older than the one saved here is refused', /newer than the one in the file/.test(r.stdout) && tokenOf(D, 'Shiny') === 'RT-SHINY', r.stdout)
}

console.log('\n-- the file format, version 2 (L4) --')
{
  const crypto = require('crypto')
  check('new files are version 2', JSON.parse(moveLib.seal({ accounts: [] }, PASS)).magic === moveLib.MAGIC)
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(PASS, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([c.update(JSON.stringify({ accounts: [account('Old', 'RT-OLD1')] })), c.final()])
  const v1 = JSON.stringify({ magic: moveLib.MAGIC_V1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') })
  check('files from older builds still open', moveLib.open(v1, PASS).accounts[0].name === 'Old')
  let e2 = null
  const short = JSON.parse(v1)
  short.tag = Buffer.alloc(4).toString('base64')
  try { moveLib.open(JSON.stringify(short), PASS) } catch (e) { e2 = e }
  check('a truncated authentication tag is refused', e2 && /damaged/.test(e2.message))
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'move tests failed')
