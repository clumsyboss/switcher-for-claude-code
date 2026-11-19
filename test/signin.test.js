require('./fake-security')

const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const signin = require('../lib/signin.js')
const fsx = require('../lib/fsx.js')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-signin-'))
const FAKE = path.join(TMP, 'fake-claude.js')
const CREDSTORE = path.join(__dirname, '..', 'lib', 'credstore.js')
const SECRET_STATE = 'state=SECRET-STATE-123'
const URL = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&' + SECRET_STATE
const GOOD = 'GOOD-CODE-42'

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}

fs.writeFileSync(FAKE, `
const fs = require('fs'), path = require('path')
const dir = process.env.CLAUDE_CONFIG_DIR, mode = process.env.FAKE_MODE
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, env: {
  CLAUDE_CONFIG_DIR: dir, SSD: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR || null,
  TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || null }, pid: process.pid }) + '\\n')
const creds = { claudeAiOauth: { accessToken: 'AT-new', refreshToken: 'RT-new', expiresAt: Date.now() + 8 * 3600e3,
  refreshTokenExpiresAt: Date.now() + 29 * 86400e3 } }
function signedIn(identity) {
  if (mode === 'mac') require(process.env.FAKE_CREDSTORE).write(dir, creds, { platform: 'darwin', env: { USER: 'someone' } })
  else fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(creds))
  if (identity) fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'new@example.com', accountUuid: 'uuid-new' } }))
}
if (args[0] === 'auth' && args[1] === 'status') {
  const has = fs.existsSync(path.join(dir, '.credentials.json'))
  process.stdout.write(JSON.stringify({ loggedIn: has, email: has ? 'new@example.com' : null }))
  process.exit(has ? 0 : 1)
}
if (mode === 'fail') { process.stderr.write('Error: could not reach ${URL}\\n'); process.exit(2) }
process.stdout.write('\\x1b[1mOpening browser to sign in\\u2026\\x1b[0m\\n')
setTimeout(() => {
  process.stdout.write("If the browser didn't open, visit: ${URL}\\n")
  process.stdout.write('Paste code here if prompted > ')
}, 50)
if (mode === 'browser' || mode === 'mac') setTimeout(() => { signedIn(true); process.stdout.write('\\nLogin successful.\\n'); process.exit(0) }, 400)
if (mode === 'noident') setTimeout(() => { signedIn(false); process.exit(0) }, 300)
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  input += d
  if (!input.includes('\\n')) return
  const code = input.trim()
  if (mode !== 'code') return
  if (code === '${GOOD}') { signedIn(true); process.stdout.write('Login successful.\\n'); process.exit(0) }
  process.stderr.write('Invalid code: ' + code + '\\n'); process.exit(1)
})
if (mode === 'hang') setInterval(() => {}, 1000)
`)

const LOG = path.join(TMP, 'calls.log')
const calls = () => fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
let spawned = []
function fakeSpawn(cmd, args, opts) {
  spawned.push({ cmd, args, opts })
  return cp.spawn(process.execPath, [FAKE, ...args], opts)
}

let n = 0
function run(mode, extra) {
  const dir = path.join(TMP, 'login-' + (++n))
  const heard = []
  const h = signin.start({
    bin: 'claude', configDir: dir, spawn: fakeSpawn, pollMs: 40, graceMs: 300, log: (t) => heard.push(t),
    env: { ...process.env, FAKE_MODE: mode, FAKE_LOG: LOG, FAKE_CREDSTORE: CREDSTORE,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(TMP, 'shared'), CLAUDE_CODE_OAUTH_TOKEN: 'inherited-token' },
    ...(extra || {}),
  })
  return { h, dir, heard }
}

const gone = (pid) => new Promise((resolve) => {
  const until = Date.now() + 5000
  const t = setInterval(() => { if (!fsx.pidAlive(pid) || Date.now() > until) { clearInterval(t); resolve(!fsx.pidAlive(pid)) } }, 50)
})

async function main() {
  console.log('temp:', TMP)

  console.log('\n-- the command it runs --')
  check('auth login, with the email to pre-fill', JSON.stringify(signin.loginArgs('me@example.com')) === '["auth","login","--email","me@example.com"]')
  check('no email, or not an email: none passed', JSON.stringify(signin.loginArgs('')) === '["auth","login"]' && JSON.stringify(signin.loginArgs('a b@c.d; rm')) === '["auth","login"]')
  const env = signin.envFor('/x/dir', { PATH: 'p', CLAUDE_SECURESTORAGE_CONFIG_DIR: 's', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDESWITCHER_SECURESTORAGE_CONFIG_DIR: 'u', CLAUDE_CONFIG_DIR: 'old' })
  check('env: its own folder, no shared or inherited login', env.CLAUDE_CONFIG_DIR === '/x/dir' && env.PATH === 'p' &&
    !('CLAUDE_SECURESTORAGE_CONFIG_DIR' in env) && !('CLAUDE_CODE_OAUTH_TOKEN' in env) && !('CLAUDESWITCHER_SECURESTORAGE_CONFIG_DIR' in env))
  check('links are logged without their query string', signin.redactUrl(URL) === 'https://claude.ai/oauth/authorize')
  check('CLI text is scrubbed of links\' queries and the code', !/SECRET|GOOD/.test(signin.scrub('bad ' + GOOD + ' at ' + URL, GOOD)))

  console.log('\n-- signing in with a pasted code --')
  let { h, dir, heard } = run('code', { email: 'new@example.com' })
  check('the folder is marked as being signed in', signin.isPending(dir))
  const url = await h.url
  check('the link comes from "If the browser didn\'t open, visit:"', url === URL, url)
  const sp = spawned[spawned.length - 1]
  check('hidden, piped, no shell', sp.opts.windowsHide === true && JSON.stringify(sp.opts.stdio) === '["pipe","pipe","pipe"]' && !sp.opts.shell)
  check('runs auth login --email', JSON.stringify(sp.args) === '["auth","login","--email","new@example.com"]')
  check('a code with a line break is refused', h.sendCode('a\nb') === false && h.sendCode('   ') === false)
  check('the code is sent', h.sendCode('  ' + GOOD + '  ') === true)
  let res = await h.done
  check('done: signed in, as whom', res.ok && res.email === 'new@example.com' && res.accountUuid === 'uuid-new', JSON.stringify(res))
  check('the login and identity are in the folder', fs.existsSync(path.join(dir, '.credentials.json')) && fs.existsSync(path.join(dir, '.claude.json')))
  check('no longer marked as signing in', !signin.isPending(dir) && !fs.existsSync(path.join(dir, signin.PENDING_FILE)))
  const c = calls().find((x) => x.env.CLAUDE_CONFIG_DIR === dir)
  check('the CLI saw CLAUDE_CONFIG_DIR, and no shared login or token', c && c.env.SSD === null && c.env.TOKEN === null, JSON.stringify(c))
  check('nothing logged carries the link\'s query or the code', !heard.some((t) => /SECRET|GOOD-CODE/.test(t)), JSON.stringify(heard))
  check('"link ready" is logged once, however much the CLI prints after it', heard.filter((t) => /link ready/.test(t)).length === 1, JSON.stringify(heard))
  check('sending a code after it is done does nothing', h.sendCode(GOOD) === false)
  check('signedInAs reads the folder', JSON.stringify(signin.signedInAs(dir)) === JSON.stringify({ accountUuid: 'uuid-new', email: 'new@example.com' }))

  console.log('\n-- a wrong code --')
  ;({ h, dir, heard } = run('code'))
  await h.url
  h.sendCode('WRONG-CODE-7')
  res = await h.done
  check('exited, saying how', !res.ok && res.reason === 'exited' && /exited \(1\)/.test(res.detail), JSON.stringify(res))
  check('without repeating the code', !/WRONG-CODE-7/.test(res.detail) && !heard.some((t) => /WRONG-CODE-7/.test(t)))

  console.log('\n-- finished in the browser --')
  ;({ h, dir } = run('browser'))
  res = await h.done
  check('done without a code', res.ok && res.email === 'new@example.com', JSON.stringify(res))

  console.log('\n-- a login written before its identity --')
  ;({ h, dir } = run('noident'))
  res = await h.done
  check('the CLI confirms it, and it is done with the CLI\'s email', res.ok && res.email === 'new@example.com' && res.accountUuid === null, JSON.stringify(res))
  check('auth status ran in the same folder', calls().some((x) => x.env.CLAUDE_CONFIG_DIR === dir && x.args[1] === 'status'))

  console.log('\n-- an old sign-in left in the folder --')
  const stale = path.join(TMP, 'stale')
  fs.mkdirSync(stale, { recursive: true })
  fs.writeFileSync(path.join(stale, '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: 'RT-old' } }))
  fs.writeFileSync(path.join(stale, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'old@example.com' }, userID: 'u', projects: { a: 1 } }))
  const old = new Date(Date.now() - 3600e3)
  fs.utimesSync(path.join(stale, '.credentials.json'), old, old)
  h = signin.start({ bin: 'claude', configDir: stale, spawn: fakeSpawn, pollMs: 40, graceMs: 200,
    env: { ...process.env, FAKE_MODE: 'fail', FAKE_LOG: LOG } })
  res = await h.done
  check('it is not mistaken for this sign-in', !res.ok && res.reason === 'exited', JSON.stringify(res))
  const cfg = JSON.parse(fs.readFileSync(path.join(stale, '.claude.json'), 'utf8'))
  check('the old identity was dropped, the rest kept', !cfg.oauthAccount && !cfg.userID && cfg.projects.a === 1)
  check('an error\'s link is reported without its query', !/SECRET/.test(res.detail) && /claude\.ai\/oauth\/authorize/.test(res.detail), res.detail)

  console.log('\n-- cancel, time out, no claude --')
  ;({ h, dir } = run('hang'))
  await h.url
  const pid = calls().filter((x) => x.env.CLAUDE_CONFIG_DIR === dir).pop().pid
  h.cancel()
  res = await h.done
  check('cancelled', !res.ok && res.reason === 'cancelled')
  check('and its process is stopped', await gone(pid))
  check('the folder is no longer marked', !signin.isPending(dir))

  ;({ h, dir } = run('hang', { timeoutMs: 600 }))
  res = await h.done
  check('timed out', !res.ok && res.reason === 'timed out', JSON.stringify(res))

  h = signin.start({ bin: path.join(TMP, 'no-such-claude.exe'), configDir: path.join(TMP, 'nobin'), pollMs: 40 })
  res = await h.done
  check('a claude that isn\'t there: error', !res.ok && res.reason === 'error', JSON.stringify(res))
  check('its link is null', (await h.url) === null)
  res = await signin.start({ bin: null, configDir: path.join(TMP, 'x') }).done
  check('no claude found at all: error', !res.ok && res.reason === 'error')

  ;({ h, dir } = run('hang'))
  const h2 = run('hang').h
  await Promise.all([h.url, h2.url])
  signin.cancelAll()
  const both = await Promise.all([h.done, h2.done])
  check('cancelAll stops every running sign-in', both.every((x) => x.reason === 'cancelled'))

  console.log('\n-- macOS: the login lands in the Keychain --')
  ;({ h, dir } = run('mac', { credOpts: { platform: 'darwin', env: { USER: 'someone' } } }))
  res = await h.done
  check('found there, and done', res.ok && res.email === 'new@example.com' && !fs.existsSync(path.join(dir, '.credentials.json')), JSON.stringify(res))

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  if (failed) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
