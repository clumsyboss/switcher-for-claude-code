require('./fake-security')
const fs = require('fs')
const os = require('os')
const path = require('path')

const profiles = require('../lib/profiles.js')
const credstore = require('../lib/credstore.js')
const locks = require('../lib/locks.js')
const remote = require('../lib/remote.js')
const store = require('../lib/store.js')
const tracker = require('../lib/tracker.js')
const switchLib = require('../lib/switch.js')

const TMP = path.join(os.tmpdir(), 'cs-switch-' + Date.now())
const HOME = path.join(TMP, 'home')
const ROOT = path.join(TMP, 'switcher')
const OPTS = { home: HOME }
const P = profiles.paths(OPTS)

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  <- ' + extra : '')) }
}

function signIn(email, token) {
  fs.mkdirSync(P.claudeDir, { recursive: true })
  credstore.write(null, { claudeAiOauth: { accessToken: token, refreshToken: token + '-r', expiresAt: 123 } }, OPTS)
  fs.writeFileSync(P.claudeJson, JSON.stringify({
    oauthAccount: { emailAddress: email, organizationName: 'Org', accountUuid: 'uuid-' + email },
    projects: { 'c:/work/repo': { history: ['chat-1'] } },
  }, null, 2))
}

const liveToken = () => credstore.read(null, OPTS).claudeAiOauth.accessToken

async function rejects(promise) {
  try { await promise; return null } catch (e) { return e }
}

async function main() {
  fs.mkdirSync(HOME, { recursive: true })
  fs.mkdirSync(ROOT, { recursive: true })
  console.log('fake home:', HOME)

  signIn('a@example.com', 'TOKEN-A')
  profiles.capture(ROOT, 'acctA', OPTS)
  signIn('b@example.com', 'TOKEN-B')
  profiles.capture(ROOT, 'acctB', OPTS)

  console.log('\n-- what it does nothing for --')
  let res = await switchLib.switchAccount(ROOT, 'acctB', OPTS)
  check('the live account: nothing to do', res.switched === false && res.to === 'acctB' && liveToken() === 'TOKEN-B')
  let err = await rejects(switchLib.switchAccount(ROOT, 'acctZ', OPTS))
  check('an account that isn\'t saved', err && err.code === 'NOTSAVED' && liveToken() === 'TOKEN-B')
  err = await rejects(switchLib.switchAccount(ROOT, 'acctA', Object.assign({ lock: async () => null }, OPTS)))
  check('a background renewal that won\'t finish: nothing changes', err && err.code === 'BUSY' &&
    liveToken() === 'TOKEN-B' && profiles.activeProfile(ROOT, OPTS) === 'acctB')

  console.log('\n-- a switch --')
  credstore.write(null, { claudeAiOauth: { accessToken: 'TOKEN-B2', refreshToken: 'TOKEN-B2-r', expiresAt: 456 } }, OPTS)
  store.setRemote(ROOT, 'acctA', 'off')
  const heard = []
  res = await switchLib.switchAccount(ROOT, 'acctA', Object.assign({ log: (t) => heard.push(t) }, OPTS))
  check('it switches, and says from what to what', res.switched === true && res.from === 'acctB' && res.to === 'acctA' &&
    res.email === 'a@example.com', JSON.stringify(res))
  check('the new login is live', liveToken() === 'TOKEN-A' && profiles.activeProfile(ROOT, OPTS) === 'acctA')
  check('history survives', JSON.parse(fs.readFileSync(P.claudeJson, 'utf8')).projects['c:/work/repo'].history[0] === 'chat-1')
  check('the account\'s Remote Control preference is applied', remote.isDisabled(OPTS) === true && heard.some((t) => /remote control disabled/.test(t)))
  check('every window hears of it (the live log)', store.getLiveLog(ROOT).slice(-1)[0].name === 'acctA')
  check('the locks are let go', !locks.isHeld(ROOT, tracker.accountLock('acctA')) && !locks.isHeld(ROOT, tracker.accountLock('acctB')))
  await switchLib.switchAccount(ROOT, 'acctB', OPTS)
  check('the leaving login was saved first: back on B, its renewed token is there', liveToken() === 'TOKEN-B2', liveToken())
  check('and its Remote Control is back on', remote.isDisabled(OPTS) === false)

  console.log('\n-- a live login the switcher doesn\'t keep --')
  signIn('c@example.com', 'TOKEN-C')
  err = await rejects(switchLib.switchAccount(ROOT, 'acctA', OPTS))
  check('it isn\'t thrown away without asking', err && err.code === 'UNSAVED' && liveToken() === 'TOKEN-C')
  res = await switchLib.switchAccount(ROOT, 'acctA', Object.assign({ withoutSaving: true }, OPTS))
  check('unless the caller says so', res.switched && liveToken() === 'TOKEN-A')

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  if (fail) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
