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

async function pageTransfer() {
  const transfer = require('../lib/transfer.js')
  const codeOf = async (fn) => { try { await fn(); return null } catch (e) { return e.code || e.message } }
  const HOME = path.join(TMP, 'home')
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'live@example.com' } }))
  const O = { home: HOME, waitMs: 2000 }
  const saveTo = (rootDir, a) => {
    store.ensureRoot(rootDir)
    fs.mkdirSync(profiles.profilesDir(rootDir), { recursive: true })
    fs.writeFileSync(path.join(profiles.profilesDir(rootDir), a.name + '.enc'), secrets.protect(Buffer.from(JSON.stringify(a.payload))))
    profiles.writeMeta(rootDir, a.name, a.meta)
  }
  const tokenOf = (rootDir, name) => profiles.readPayload(rootDir, name).credentials.claudeAiOauth.refreshToken

  console.log('\n-- "Move to another PC…" (lib/transfer.js) --')
  const P = path.join(TMP, 'page-pc')
  saveTo(P, account('Travel', 'RT-TRAVEL'))
  saveTo(P, account('Live', 'RT-LIVE'))
  store.setDisplay(P, 'Travel', { label: 'Travel kit', icon: 'rocket', color: 'teal' })
  store.setRemote(P, 'Travel', 'off')
  const f = path.join(TMP, 'travel.move')
  check('the account Claude Code is using is refused, and stays', await codeOf(() => transfer.exportAccounts(P, ['Live'], PASS, f, O)) === 'ELIVE' &&
    profiles.exists(P, 'Live') && !fs.existsSync(f))
  check('so is a passphrase that is too short', await codeOf(() => transfer.exportAccounts(P, ['Travel'], 'short', f, O)) === 'EPASSPHRASE')
  const res = await transfer.exportAccounts(P, ['Travel'], PASS, f, O)
  check('moved: the file holds it, and it is gone from this PC', res.moved[0] === 'Travel' && fs.existsSync(f) && !profiles.exists(P, 'Travel'))
  check('a copy of what left stays in backups/', res.backups.length === 1 && fs.existsSync(res.backups[0]))
  if (process.platform !== 'win32') check('the file is private (0600)', (fs.statSync(f).mode & 0o777) === 0o600)
  check('an existing file is never written over unless asked', await codeOf(() => transfer.exportAccounts(P, ['Live'], PASS, f, { ...O, home: TMP })) === 'EEXIST')

  console.log('\n-- "Import from a move file" --')
  let e = await codeOf(() => transfer.readFile(f, 'wrong passphrase 9'))
  check('a wrong passphrase says so, so the page can ask again', e === 'EPASSPHRASE')
  const Q = path.join(TMP, 'page-other-pc')
  const read = transfer.readFile(f, PASS)
  check('the file is read and checked before anything is saved', read.accounts.length === 1 && !fs.existsSync(Q))
  check('a new account will be added', transfer.planFor(Q, read.accounts[0], read.exportedAt, O).action === 'add')
  let got = await transfer.importAccounts(Q, read, O)
  check('added, with its own login', got.added[0] === 'Travel' && tokenOf(Q, 'Travel') === 'RT-TRAVEL')
  check('and its name, icon, colour and Remote Control choice', store.displayOf(Q, 'Travel').label === 'Travel kit' &&
    store.displayOf(Q, 'Travel').icon === 'rocket' && store.getRemote(Q, 'Travel') === 'off')
  const used = transfer.markImported(f)
  check('the file is renamed once used', !!used && transfer.wasImported(used) && !fs.existsSync(f))
  check('and the renamed file is refused', await codeOf(() => transfer.readFile(used, PASS)) === 'EUSED')

  const again = path.join(TMP, 'travel-newer.move')
  fs.writeFileSync(again, moveLib.seal({ exportedAt: new Date(Date.now() + 60000).toISOString(), accounts: [account('Travel', 'RT-TRAVEL-2')] }, PASS))
  const r2 = transfer.readFile(again, PASS)
  check('the same account with an older login here asks first', transfer.planFor(Q, r2.accounts[0], r2.exportedAt, O).action === 'replace')
  got = await transfer.importAccounts(Q, r2, O)
  check('not chosen: it is left as it is', got.skipped[0] && /left as it is/.test(got.skipped[0].reason) && tokenOf(Q, 'Travel') === 'RT-TRAVEL')
  got = await transfer.importAccounts(Q, r2, { ...O, replace: ['Travel'] })
  check('chosen: the newer login takes its place', got.replaced[0] === 'Travel' && tokenOf(Q, 'Travel') === 'RT-TRAVEL-2')
  const twin = account('Travel2', 'RT-TWIN')
  twin.payload.identity.oauthAccount.emailAddress = 'travel@example.com'
  twin.meta.email = 'travel@example.com'
  const r3 = { exportedAt: new Date().toISOString(), accounts: [moveLib.validateAccount(twin, store).account], invalid: [] }
  check('the same account under another name is not saved twice', /already saved here as "Travel"/.test(transfer.planFor(Q, r3.accounts[0], r3.exportedAt, O).reason || ''))

  console.log('\n-- every file people already have keeps importing (test/fixtures) --')
  const FIX = path.join(__dirname, 'fixtures')
  const FIX_PASS = 'fixture passphrase 1'
  const r1 = transfer.readFile(path.join(FIX, 'move-format-1.move'), FIX_PASS)
  const R1 = path.join(TMP, 'fixture-1-pc')
  got = await transfer.importAccounts(R1, r1, O)
  check('format 1, as 1.1.0\'s "Make a login for another PC" wrote it', got.added.join() === 'Fixture-Spare' &&
    tokenOf(R1, 'Fixture-Spare') === 'fixture-refresh-Fixture-Spare' && store.displayOf(R1, 'Fixture-Spare').label === 'Fixture Spare' &&
    profiles.readMeta(R1, 'Fixture-Spare').accountUuid === 'uuid-fixture-spare')
  const r2f = transfer.readFile(path.join(FIX, 'move-format-2.move'), FIX_PASS)
  const R2 = path.join(TMP, 'fixture-2-pc')
  got = await transfer.importAccounts(R2, r2f, O)
  check('format 2, as 1.2.0\'s move-accounts.js wrote it, both accounts', got.added.join() === 'Fixture-Work,Fixture-Home' &&
    tokenOf(R2, 'Fixture-Home') === 'fixture-refresh-Fixture-Home')
  check('with their Remote Control and Artifacts choices', store.getRemote(R2, 'Fixture-Work') === 'off' &&
    store.getArtifacts(R2, 'Fixture-Work') === 'off' && store.getRemote(R2, 'Fixture-Home') === 'on')
  check('reading a fixture never changes it', fs.readdirSync(FIX).filter((x) => x.endsWith('.move')).length === 2 &&
    !fs.readdirSync(FIX).some((x) => transfer.wasImported(x)))
  const future = JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIX, 'move-format-2.move'), 'utf8')), magic: 'claude-switcher-move/3' })
  e = null
  try { moveLib.open(future, FIX_PASS) } catch (x) { e = x }
  check('a file from a newer version says to update, instead of "not a move file"', e && e.code === 'ENEWER' && /newer version/.test(e.message))

  if (fs.existsSync(SCRIPT)) {
    console.log('\n-- the page and the script read each other\'s files --')
    const S = path.join(TMP, 'script-pc')
    saveTo(P, account('Roam', 'RT-ROAM'))
    const g = path.join(TMP, 'roam.move')
    await transfer.exportAccounts(P, ['Roam'], PASS, g, O)
    const r = cp.spawnSync(process.execPath, [SCRIPT, 'import', g], {
      encoding: 'utf8', env: { ...process.env, CLAUDE_SWITCHER_ROOT: S, MOVE_PASSPHRASE: PASS }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    check('a file the page made imports with the script', /Added: Roam/.test(r.stdout) && tokenOf(S, 'Roam') === 'RT-ROAM', r.stdout + r.stderr)
    const back = path.join(TMP, 'roam-back.move')
    const x = cp.spawnSync(process.execPath, [SCRIPT, 'export', back, 'Roam'], {
      encoding: 'utf8', env: { ...process.env, CLAUDE_SWITCHER_ROOT: S, MOVE_PASSPHRASE: PASS }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const T = path.join(TMP, 'page-third-pc')
    got = x.status === 0 ? await transfer.importAccounts(T, transfer.readFile(back, PASS), O) : { added: [] }
    check('and one the script made imports on the page', got.added[0] === 'Roam' && tokenOf(T, 'Roam') === 'RT-ROAM', x.stdout + x.stderr)
  }
}

pageTransfer()
  .catch((e) => { failed++; console.log('  FAIL crashed: ' + (e && e.stack)) })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true })
    console.log('\n' + passed + ' passed, ' + failed + ' failed')
    assert.strictEqual(failed, 0, 'move tests failed')
  })
