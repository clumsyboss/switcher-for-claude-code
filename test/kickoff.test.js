require('./fake-security')

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const kickoff = require('../lib/kickoff.js')
const profiles = require('../lib/profiles.js')
const secrets = require('../lib/secrets.js')
const store = require('../lib/store.js')
const credstore = require('../lib/credstore.js')
const tracker = require('../lib/tracker.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-kickoff-'))
store.ensureRoot(ROOT)
fs.mkdirSync(profiles.profilesDir(ROOT), { recursive: true })

function saveAccount(name, rt, expiresInMs) {
  const payload = {
    credentials: { claudeAiOauth: { accessToken: 'AT-' + rt, refreshToken: rt, expiresAt: Date.now() + expiresInMs } },
    identity: { oauthAccount: { emailAddress: name + '@example.com', organizationName: 'Acme' }, userID: 'u-' + name },
    capturedAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(profiles.profilesDir(ROOT), name + '.enc'), secrets.protect(Buffer.from(JSON.stringify(payload))))
  profiles.writeMeta(ROOT, name, { email: name + '@example.com', org: 'Acme', capturedAt: payload.capturedAt })
}
const savedRt = (name) => profiles.readPayload(ROOT, name).credentials.claudeAiOauth.refreshToken
const leftovers = () => { try { return fs.readdirSync(kickoff.kickoffRoot(ROOT)).length } catch { return 0 } }

async function main() {
  console.log('\n-- what it asks Claude Code to do --')
  const args = kickoff.ARGS
  check('print mode, a one-word "hi"', args[0] === '-p' && args[1] === 'hi')
  check('the cheapest model', args.join(' ').includes('--model haiku'))
  check('nothing saved', args.includes('--no-session-persistence'))
  check('no tools', args[args.indexOf('--tools') + 1] === '')
  check('a one-line system prompt, and none of your MCP servers', args.includes('--system-prompt') && args.includes('--strict-mcp-config'))
  process.env.ANTHROPIC_API_KEY = 'sk-should-not-be-used'
  const env = kickoff.envFor(path.join(ROOT, 'x'))
  delete process.env.ANTHROPIC_API_KEY
  check('it runs as the saved login, never an API key from the environment',
    env.CLAUDE_CONFIG_DIR === path.join(ROOT, 'x') && !('ANTHROPIC_API_KEY' in env) && !('CLAUDE_CODE_OAUTH_TOKEN' in env))
  check('a run is capped well inside the lock\'s 2 minutes', kickoff.RUN_TIMEOUT_MS < kickoff.LOCK_STALE_MS)

  console.log('\n-- a run --')
  saveAccount('work', 'RT-WORK', 6 * 3600e3)
  const before = JSON.stringify(profiles.readPayload(ROOT, 'work'))
  let seen = null
  let res = await kickoff.startSession(ROOT, 'work', {
    run: async (dir) => {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'))
      seen = { dir, rt: (credstore.read(dir) || {}).claudeAiOauth.refreshToken, email: cfg.oauthAccount.emailAddress,
        lockBusy: (await tracker.renew(ROOT, 'work', { force: true })).skipped === 'busy' }
      return { ok: true }
    },
  })
  check('it succeeds', res && res.ok === true)
  check('Claude Code gets the account\'s saved login, in a throwaway folder', seen && seen.rt === 'RT-WORK' && seen.dir.startsWith(kickoff.kickoffRoot(ROOT)))
  check('and its identity', seen && seen.email === 'work@example.com')
  check('the background renewal waits while it runs', seen && seen.lockBusy)
  check('the folder is destroyed afterwards', seen && !fs.existsSync(seen.dir) && leftovers() === 0)
  check('an untouched login is left exactly as it was', JSON.stringify(profiles.readPayload(ROOT, 'work')) === before)

  console.log('\n-- if Claude Code renews the login during the run --')
  res = await kickoff.startSession(ROOT, 'work', {
    run: async (dir) => {
      credstore.write(dir, { claudeAiOauth: { accessToken: 'AT-RT-WORK-2', refreshToken: 'RT-WORK-2', expiresAt: Date.now() + 8 * 3600e3 } })
      return { ok: true }
    },
  })
  check('the renewed login is saved back (the old one is dead by then)', res.ok && savedRt('work') === 'RT-WORK-2')

  console.log('\n-- when the run fails --')
  res = await kickoff.startSession(ROOT, 'work', { run: async () => ({ ok: false, reason: 'mocked failure' }) })
  check('the reason comes back', res.ok === false && res.reason === 'mocked failure')
  let threw = null
  try { await kickoff.startSession(ROOT, 'work', { run: async () => { throw new Error('boom') } }) } catch (e) { threw = e }
  check('a crash still destroys the folder and frees the lock', threw && leftovers() === 0 &&
    (await tracker.renew(ROOT, 'work', { force: false })).skipped !== 'busy')

  console.log('\n-- before it runs --')
  saveAccount('soon', 'RT-SOON', 5 * 60e3)
  let renewed = null
  res = await kickoff.startSession(ROOT, 'soon', {
    renew: async (_root, name, o) => { renewed = { name, force: o && o.force }; return { name, renewed: true } },
    run: async () => ({ ok: true }),
  })
  check('a login about to expire is renewed first', renewed && renewed.name === 'soon' && renewed.force === true)
  res = await kickoff.startSession(ROOT, 'soon', {
    renew: async (_root, name) => ({ name, failed: 'rejected' }),
    run: async () => { throw new Error('should not run') },
  })
  check('and if that renewal is refused, nothing runs', res.ok === false && /sign it in again/.test(res.reason))
  profiles.markNeedsLogin(ROOT, 'work', 'mocked')
  let ran = false
  res = await kickoff.startSession(ROOT, 'work', { run: async () => { ran = true; return { ok: true } } })
  check('an account whose login expired is refused without running', res.ok === false && !ran && /sign it in again/.test(res.reason))

  console.log('\n-- after a reload or crash --')
  fs.mkdirSync(path.join(kickoff.kickoffRoot(ROOT), 'work-left'), { recursive: true })
  fs.writeFileSync(path.join(kickoff.kickoffRoot(ROOT), 'work-left', '.credentials.json'), '{}')
  check('leftover folders are wiped at the next start', kickoff.cleanup(ROOT) === 1 && leftovers() === 0)

  console.log('\n-- another window starting up while a run is in progress (audit #7) --')
  saveAccount('busy', 'RT-BUSY', 6 * 3600e3)
  let cleanedMidRun = null
  res = await kickoff.startSession(ROOT, 'busy', {
    run: async (dir) => {
      cleanedMidRun = kickoff.cleanup(ROOT)
      const stillThere = fs.existsSync(dir)
      credstore.write(dir, { claudeAiOauth: { accessToken: 'AT-B2', refreshToken: 'RT-BUSY-2', expiresAt: Date.now() + 8 * 3600e3 } })
      return { ok: stillThere }
    },
  })
  check('leaves the run\'s folder alone', cleanedMidRun === 0 && res.ok === true)
  check('so the login renewed during the run is still saved', savedRt('busy') === 'RT-BUSY-2')

  const dead = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
  const orphan = path.join(kickoff.kickoffRoot(ROOT), 'busy-' + dead + '-zz')
  fs.mkdirSync(orphan, { recursive: true })
  fs.writeFileSync(path.join(orphan, 'owner.json'), JSON.stringify({ pid: Number(dead), name: 'busy', startedAt: Date.now() }))
  credstore.write(orphan, { claudeAiOauth: { accessToken: 'AT-B3', refreshToken: 'RT-BUSY-3', expiresAt: Date.now() + 9 * 3600e3 } })
  check('a crashed run\'s folder is cleaned up', kickoff.cleanup(ROOT) === 1 && !fs.existsSync(orphan))
  check('after saving the login renewed in it, not throwing it away', savedRt('busy') === 'RT-BUSY-3')

  const legacyDir = path.join(kickoff.kickoffRoot(ROOT), 'busy-Ab12Cd')
  fs.mkdirSync(legacyDir, { recursive: true })
  credstore.write(legacyDir, { claudeAiOauth: { accessToken: 'AT-B4', refreshToken: 'RT-BUSY-4', expiresAt: Date.now() + 10 * 3600e3 } })
  check('a folder from the previous version is recovered by its name too', kickoff.cleanup(ROOT) === 1 && savedRt('busy') === 'RT-BUSY-4')

  console.log('\n-- if the account becomes the live one before it runs (M1) --')
  saveAccount('liveone', 'RT-LIVE', 6 * 3600e3)
  const P = profiles.paths()
  fs.mkdirSync(P.claudeDir, { recursive: true })
  credstore.write(null, { claudeAiOauth: { accessToken: 'AT-RT-LIVE', refreshToken: 'RT-LIVE', expiresAt: Date.now() + 6 * 3600e3 } })
  fs.writeFileSync(P.claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'liveone@example.com', organizationName: 'Acme' } }))
  ran = false
  res = await kickoff.startSession(ROOT, 'liveone', { run: async () => { ran = true; return { ok: true } } })
  check('it does not run: a second Claude Code renewing the live login would sign it out', res.ok === false && !ran, JSON.stringify(res))
  fs.rmSync(P.claudeJson, { force: true })
  credstore.remove(null)

  if (process.platform !== 'win32' && !(process.getuid && process.getuid() === 0)) {
    console.log('\n-- if the renewed login can\'t be saved back (M1) --')
    saveAccount('stuck', 'RT-STUCK', 6 * 3600e3)
    const pdir = profiles.profilesDir(ROOT)
    let runDir = null
    res = await kickoff.startSession(ROOT, 'stuck', {
      run: async (dir) => {
        runDir = dir
        credstore.write(dir, { claudeAiOauth: { accessToken: 'AT-S2', refreshToken: 'RT-STUCK-2', expiresAt: Date.now() + 8 * 3600e3 } })
        fs.chmodSync(pdir, 0o500)
        return { ok: true }
      },
    })
    fs.chmodSync(pdir, 0o700)
    check('it says so', res.ok === false && /could not be saved/.test(res.reason), JSON.stringify(res))
    check('and keeps the folder, which holds the only good copy', runDir && fs.existsSync(runDir))
    const ownerFile = path.join(runDir, 'owner.json')
    fs.writeFileSync(ownerFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(ownerFile, 'utf8')), startedAt: Date.now() - kickoff.MAX_AGE_MS - 1000 }))
    check('the next cleanup saves it', kickoff.cleanup(ROOT) === 1 && savedRt('stuck') === 'RT-STUCK-2' && !fs.existsSync(runDir))
  }

  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  assert.strictEqual(failed, 0, 'kickoff tests failed')
}

main().catch((e) => { console.error(e); process.exit(1) })
