require('./fake-security')
const fs = require('fs')
const os = require('os')
const path = require('path')

const profiles = require('../lib/profiles.js')
const credstore = require('../lib/credstore.js')
const remote = require('../lib/remote.js')
const artifacts = require('../lib/artifacts.js')
const store = require('../lib/store.js')
const preferences = require('../lib/preferences.js')

const TMP = path.join(os.tmpdir(), 'cs-prefs-' + Date.now())
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
  fs.writeFileSync(P.claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: 'uuid-' + email } }, null, 2))
}

function main() {
  fs.mkdirSync(HOME, { recursive: true })
  fs.mkdirSync(ROOT, { recursive: true })
  console.log('fake home:', HOME)
  signIn('a@example.com', 'TOKEN-A')
  profiles.capture(ROOT, 'acctA', OPTS)
  signIn('b@example.com', 'TOKEN-B')
  profiles.capture(ROOT, 'acctB', OPTS)

  console.log('\n-- Remote Control --')
  const heard = []
  let res = preferences.setRemoteFor(ROOT, 'acctB', false, Object.assign({ log: (t) => heard.push(t) }, OPTS))
  check('off for the live account: saved, and Claude Code\'s settings changed', store.getRemote(ROOT, 'acctB') === 'off' &&
    remote.isDisabled(OPTS) === true && res.applied === true && res.warning === null)
  res = preferences.setRemoteFor(ROOT, 'acctA', false, OPTS)
  check('off for another account: only saved, until it\'s live', store.getRemote(ROOT, 'acctA') === 'off' && res.applied === false)
  res = preferences.setRemoteFor(ROOT, 'acctB', true, OPTS)
  check('back on for the live account undoes it, even with nothing else managed', remote.isDisabled(OPTS) === false && res.applied === true)
  preferences.applyPreferences(ROOT, 'acctA', OPTS)
  check('applied on a switch: the account that\'s off turns it off', remote.isDisabled(OPTS) === true)
  preferences.applyPreferences(ROOT, 'acctB', OPTS)
  check('and the one that\'s on turns it back on', remote.isDisabled(OPTS) === false)

  console.log('\n-- Artifacts --')
  res = preferences.setArtifactsFor(ROOT, 'acctB', false, OPTS)
  check('off for the live account: saved, and Claude Code\'s settings changed', store.getArtifacts(ROOT, 'acctB') === 'off' &&
    artifacts.isOff(OPTS) === true && res.applied === true)
  res = preferences.setArtifactsFor(ROOT, 'acctB', true, OPTS)
  check('and back on', store.getArtifacts(ROOT, 'acctB') !== 'off' && artifacts.isOff(OPTS) === false)

  console.log('\n-- a settings file that can\'t be read --')
  fs.writeFileSync(remote.settingsPath(OPTS), '{ "broken": ')
  res = preferences.setRemoteFor(ROOT, 'acctB', false, OPTS)
  check('is left alone, and the caller hears why', store.getRemote(ROOT, 'acctB') === 'off' && !!res.warning &&
    fs.readFileSync(remote.settingsPath(OPTS), 'utf8') === '{ "broken": ')

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  if (fail) process.exit(1)
}

main()
