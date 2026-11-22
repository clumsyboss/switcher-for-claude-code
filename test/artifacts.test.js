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

const TMP = path.join(os.tmpdir(), 'cs-artifacts-' + Date.now())
const HOME = path.join(TMP, 'home')
const ROOT = path.join(TMP, 'switcher')
const OPTS = { home: HOME }
const P = profiles.paths(OPTS)
const FILE = remote.settingsPath(OPTS)

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  <- ' + extra : '')) }
}

const write = (text) => fs.writeFileSync(FILE, text)
const read = () => fs.readFileSync(FILE, 'utf8')
const json = () => JSON.parse(read())
const pretty = (o) => JSON.stringify(o, null, 2) + '\n'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function signIn(email, token) {
  fs.mkdirSync(P.claudeDir, { recursive: true })
  credstore.write(null, { claudeAiOauth: { accessToken: token, refreshToken: token + '-r', expiresAt: 123 } }, OPTS)
  fs.writeFileSync(P.claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: 'uuid-' + email } }, null, 2))
}

function main() {
  fs.mkdirSync(HOME, { recursive: true })
  fs.mkdirSync(ROOT, { recursive: true })
  console.log('fake home:', HOME)
  check('the settings file is inside the temp folder', FILE.startsWith(TMP))
  signIn('a@example.com', 'TOKEN-A')
  profiles.capture(ROOT, 'acctA', OPTS)
  signIn('b@example.com', 'TOKEN-B')
  profiles.capture(ROOT, 'acctB', OPTS)

  check('the list is the five decided entries', same(artifacts.DENY,
    ['mcp__claude_ai_Claude_Docs', 'ShareOnboardingGuide', 'PublishPlugin', 'DesignSync', 'RemoteTrigger']))

  console.log('\n-- off writes the entries and records them --')
  const plain = pretty({ theme: 'dark', hooks: { Stop: [] } })
  write(plain)
  let res = preferences.setArtifactsFor(ROOT, 'acctB', false, OPTS)
  let j = json()
  check('enableArtifact false and every deny entry', res.applied === true && j.enableArtifact === false &&
    same(j.permissions, { deny: artifacts.DENY }), read())
  check('the rest stays', j.theme === 'dark' && Array.isArray(j.hooks.Stop))
  let rec = store.getArtifactsAdded(ROOT)
  check('the record names exactly the added entries, and that it created deny and permissions',
    rec && same(rec.deny, artifacts.DENY) && rec.createdDeny === true && rec.createdPermissions === true, JSON.stringify(rec))
  check('off again changes nothing', artifacts.setOff(true, OPTS, ROOT).changed === false)

  console.log('\n-- on removes only its own --')
  res = preferences.setArtifactsFor(ROOT, 'acctB', true, OPTS)
  check('the file is byte-for-byte as before', read() === plain, read())
  check('and the record is gone', store.getArtifactsAdded(ROOT) === null)

  console.log('\n-- a user\'s own identical entry survives off and on --')
  const own = pretty({ permissions: { deny: ['DesignSync', 'Bash(rm:*)'] } })
  write(own)
  preferences.setArtifactsFor(ROOT, 'acctB', false, OPTS)
  j = json()
  rec = store.getArtifactsAdded(ROOT)
  check('DesignSync is there once, and not recorded', j.permissions.deny.filter((e) => e === 'DesignSync').length === 1 &&
    !rec.deny.includes('DesignSync') && rec.createdDeny === false && rec.createdPermissions === false, JSON.stringify(rec))
  check('the user\'s entries keep their place, the new ones follow',
    same(j.permissions.deny.slice(0, 2), ['DesignSync', 'Bash(rm:*)']) && j.permissions.deny.length === 6)
  preferences.setArtifactsFor(ROOT, 'acctB', true, OPTS)
  check('on leaves the user\'s DesignSync and the file as it was', read() === own, read())

  console.log('\n-- other permissions keys and deny entries come back byte-for-byte --')
  const full = pretty({
    model: 'opus',
    permissions: { allow: ['Read'], deny: ['WebFetch', 'mcp__claude_ai_Slack'], ask: ['Bash(git push:*)'], defaultMode: 'acceptEdits' },
    env: { FOO: '1' },
  })
  write(full)
  preferences.setArtifactsFor(ROOT, 'acctB', false, OPTS)
  j = json()
  check('off keeps allow, ask, defaultMode and the key order', same(Object.keys(j.permissions), ['allow', 'deny', 'ask', 'defaultMode']) &&
    same(j.permissions.allow, ['Read']) && j.permissions.defaultMode === 'acceptEdits' &&
    same(j.permissions.deny, ['WebFetch', 'mcp__claude_ai_Slack', ...artifacts.DENY]))
  preferences.setArtifactsFor(ROOT, 'acctB', true, OPTS)
  check('on gives the same bytes back', read() === full, read())

  console.log('\n-- permissions there, deny not: deny comes and goes --')
  const noDeny = pretty({ permissions: { allow: ['Read'] } })
  write(noDeny)
  preferences.setArtifactsFor(ROOT, 'acctB', false, OPTS)
  rec = store.getArtifactsAdded(ROOT)
  check('records that it created deny, not permissions', rec.createdDeny === true && rec.createdPermissions === false)
  preferences.setArtifactsFor(ROOT, 'acctB', true, OPTS)
  check('on removes deny and keeps permissions', read() === noDeny, read())

  console.log('\n-- the user adds to permissions while off --')
  write(plain)
  preferences.setArtifactsFor(ROOT, 'acctB', false, OPTS)
  j = json()
  j.permissions.allow = ['Read']
  j.permissions.deny.push('WebSearch')
  write(pretty(j))
  preferences.setArtifactsFor(ROOT, 'acctB', true, OPTS)
  j = json()
  check('their entries stay, so permissions and deny stay', same(j.permissions, { deny: ['WebSearch'], allow: ['Read'] }), read())

  console.log('\n-- an entry the user removed by hand while off --')
  write(plain)
  preferences.setArtifactsFor(ROOT, 'acctB', false, OPTS)
  j = json()
  j.permissions.deny = j.permissions.deny.filter((e) => e !== 'RemoteTrigger')
  write(pretty(j))
  let warned = null
  res = preferences.setArtifactsFor(ROOT, 'acctB', true, Object.assign({ log: (t) => { warned = t } }, OPTS))
  check('on: no error, the rest removed, the record cleared', res.warning === null && read() === plain &&
    store.getArtifactsAdded(ROOT) === null, warned || read())
  write(plain)
  preferences.setArtifactsFor(ROOT, 'acctB', false, OPTS)
  j = json()
  delete j.permissions
  write(pretty(j))
  res = preferences.setArtifactsFor(ROOT, 'acctB', true, OPTS)
  check('all of them removed by hand: no error either', res.warning === null && read() === plain && store.getArtifactsAdded(ROOT) === null, read())

  console.log('\n-- switching between an account that is off and one that is on --')
  write(full)
  store.setArtifacts(ROOT, 'acctA', 'off')
  preferences.applyPreferences(ROOT, 'acctA', OPTS)
  j = json()
  check('to the off account: entries in', j.enableArtifact === false && artifacts.DENY.every((e) => j.permissions.deny.includes(e)))
  preferences.applyPreferences(ROOT, 'acctA', OPTS)
  check('applied again: nothing doubled', json().permissions.deny.length === 2 + artifacts.DENY.length)
  preferences.applyPreferences(ROOT, 'acctB', OPTS)
  check('to the on account: the file is as it was', read() === full, read())
  check('and nothing is recorded', store.getArtifactsAdded(ROOT) === null)
  preferences.applyPreferences(ROOT, 'acctA', OPTS)
  preferences.applyPreferences(ROOT, 'acctB', OPTS)
  check('and again', read() === full)
  store.setArtifacts(ROOT, 'acctA', 'on')

  console.log('\n-- a settings file that can\'t be read --')
  const broken = '{ "permissions": { "deny": [ ] }, // a comment\n }'
  write(broken)
  res = preferences.setArtifactsFor(ROOT, 'acctB', false, OPTS)
  check('is left alone, and the caller hears why', !!res.warning && /not valid JSON/.test(res.warning) && read() === broken)
  check('nothing is recorded', store.getArtifactsAdded(ROOT) === null)
  write(plain)
  preferences.setArtifactsFor(ROOT, 'acctB', false, OPTS)
  write(broken)
  res = preferences.setArtifactsFor(ROOT, 'acctB', true, OPTS)
  check('going on with it broken: left alone, the record kept for later', !!res.warning && read() === broken &&
    !!store.getArtifactsAdded(ROOT))
  write(pretty(Object.assign(JSON.parse(plain), { enableArtifact: false, permissions: { deny: artifacts.DENY } })))
  preferences.setArtifactsFor(ROOT, 'acctB', true, OPTS)
  check('once it is fixed, on cleans up', read() === plain && store.getArtifactsAdded(ROOT) === null, read())

  console.log('\n-- a permissions shape Claude Code would not read --')
  const odd = pretty({ permissions: { deny: 'Bash' } })
  write(odd)
  res = preferences.setArtifactsFor(ROOT, 'acctB', false, OPTS)
  j = json()
  check('enableArtifact still goes in, deny is not touched', res.warning === null && j.enableArtifact === false && j.permissions.deny === 'Bash')
  preferences.setArtifactsFor(ROOT, 'acctB', true, OPTS)
  check('and on puts it back', read() === odd)

  console.log('\n-- without the switcher\'s folder there is no record, so no deny rules --')
  write(plain)
  artifacts.setOff(true, OPTS)
  check('only enableArtifact', same(json(), Object.assign(JSON.parse(plain), { enableArtifact: false })))
  artifacts.setOff(false, OPTS)
  check('and back', read() === plain)

  console.log('\n-- the record in the registry is cleaned on read --')
  store.setArtifactsAdded(ROOT, { deny: ['PublishPlugin', 7, '', 'PublishPlugin'], createdDeny: 'yes' })
  rec = store.getArtifactsAdded(ROOT)
  check('strings only, once each, flags only when true', same(rec, { deny: ['PublishPlugin'], createdDeny: false, createdPermissions: false }))
  store.setArtifactsAdded(ROOT, null)
  check('and cleared', store.getArtifactsAdded(ROOT) === null)

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  if (fail) process.exit(1)
}

main()
