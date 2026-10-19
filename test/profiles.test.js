require('./fake-security')
const fs = require('fs')
const os = require('os')
const path = require('path')

const profiles = require('../lib/profiles.js')
const credstore = require('../lib/credstore.js')

const TMP = path.join(os.tmpdir(), 'cs-prof-' + Date.now())
const HOME = path.join(TMP, 'home')
const ROOT = path.join(TMP, 'switcher')
const OPTS = { home: HOME }

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  <- ' + extra : '')) }
}

const P = profiles.paths(OPTS)

function writeLogin(email, org, token) {
  fs.mkdirSync(P.claudeDir, { recursive: true })
  credstore.write(null, {
    claudeAiOauth: { accessToken: token, refreshToken: token + '-r', expiresAt: 123 },
    trustedDeviceToken: 'device-' + email,
  }, OPTS)
}

function writeConfig(email, org, extra) {
  fs.writeFileSync(P.claudeJson, JSON.stringify({
    oauthAccount: { emailAddress: email, organizationName: org, seatTier: 'max' },
    userID: 'uid-' + email,
    projects: { 'c:/work/repo': { history: ['chat-1', 'chat-2'], allowedTools: ['Bash'] } },
    numStartups: 42,
    tipsHistory: { 'some-tip': 1 },
    cachedUsageUtilization: { accountUuid: 'uuid-' + email, utilization: {} },
    cachedArtifactRoster: { accountUuid: 'uuid-' + email },
    githubWebConnectionStatusCache: { accountUuid: 'uuid-' + email },
    groveConfigCache: { 'uuid-a': {}, 'uuid-b': {} },
    ...(extra || {}),
  }, null, 2))
}

function main() {
  fs.mkdirSync(HOME, { recursive: true })
  fs.mkdirSync(ROOT, { recursive: true })
  console.log('fake home:', HOME)

  console.log('\n-- capture account A --')
  writeLogin('a@example.com', 'Org A', 'TOKEN-A')
  writeConfig('a@example.com', 'Org A')
  check('sees a current login', profiles.hasCurrentLogin(OPTS))
  const capA = profiles.capture(ROOT, 'acctA', OPTS)
  check('captured identity', capA.email === 'a@example.com', JSON.stringify(capA))
  check('profile blob written', profiles.exists(ROOT, 'acctA'))
  const blob = fs.readFileSync(path.join(ROOT, 'profiles', 'acctA.enc'))
  check('blob is encrypted (no token in plaintext)', !blob.toString('utf8').includes('TOKEN-A'))
  check('sidecar meta is readable and non-secret', (() => {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles', 'acctA.meta.json'), 'utf8'))
    return m.email === 'a@example.com' && !JSON.stringify(m).includes('TOKEN-A')
  })())

  console.log('\n-- log in as account B, capture it --')
  writeLogin('b@example.com', 'Org B', 'TOKEN-B')
  writeConfig('b@example.com', 'Org B')
  profiles.capture(ROOT, 'acctB', OPTS)
  check('two profiles listed', profiles.list(ROOT).length === 2,
    JSON.stringify(profiles.list(ROOT).map((p) => p.name)))
  check('active profile detected as B', profiles.activeProfile(ROOT, OPTS) === 'acctB',
    String(profiles.activeProfile(ROOT, OPTS)))

  console.log('\n-- add a conversation, then switch A -> verify nothing is lost --')
  const proj = path.join(P.claudeDir, 'projects', 'c--work-repo')
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, 'session-xyz.jsonl'), '{"msg":"my important chat"}\n')
  fs.mkdirSync(path.join(P.claudeDir, 'todos'), { recursive: true })
  fs.writeFileSync(path.join(P.claudeDir, 'todos', 't.json'), '{"todo":1}')

  const applied = profiles.apply(ROOT, 'acctA', OPTS)
  check('switch reports account A', applied.email === 'a@example.com', JSON.stringify(applied))

  const creds = credstore.read(null, OPTS)
  check('credentials are now A', creds.claudeAiOauth.accessToken === 'TOKEN-A',
    creds.claudeAiOauth.accessToken)
  check('trustedDeviceToken swapped too', creds.trustedDeviceToken === 'device-a@example.com')

  const cfg = JSON.parse(fs.readFileSync(P.claudeJson, 'utf8'))
  check('oauthAccount is now A', cfg.oauthAccount.emailAddress === 'a@example.com')
  check('userID swapped', cfg.userID === 'uid-a@example.com', cfg.userID)

  check('CONVERSATION FILE SURVIVES',
    fs.readFileSync(path.join(proj, 'session-xyz.jsonl'), 'utf8').includes('my important chat'))
  check('project history survives',
    cfg.projects['c:/work/repo'].history.length === 2, JSON.stringify(cfg.projects))
  check('allowedTools survive', cfg.projects['c:/work/repo'].allowedTools[0] === 'Bash')
  check('todos survive', fs.existsSync(path.join(P.claudeDir, 'todos', 't.json')))
  check('unrelated machine state survives', cfg.numStartups === 42 && !!cfg.tipsHistory)

  console.log('\n-- stale account caches cleared --')
  check('cachedUsageUtilization cleared', cfg.cachedUsageUtilization === undefined)
  check('cachedArtifactRoster cleared', cfg.cachedArtifactRoster === undefined)
  check('githubWebConnectionStatusCache cleared', cfg.githubWebConnectionStatusCache === undefined)
  check('uuid-keyed cache left intact', !!cfg.groveConfigCache && Object.keys(cfg.groveConfigCache).length === 2)

  console.log('\n-- switch back to B --')
  profiles.apply(ROOT, 'acctB', OPTS)
  const creds2 = credstore.read(null, OPTS)
  const cfg2 = JSON.parse(fs.readFileSync(P.claudeJson, 'utf8'))
  check('credentials are B again', creds2.claudeAiOauth.accessToken === 'TOKEN-B')
  check('identity is B again', cfg2.oauthAccount.emailAddress === 'b@example.com')
  check('conversation still there after 2 switches',
    fs.existsSync(path.join(proj, 'session-xyz.jsonl')))
  check('project history still there', cfg2.projects['c:/work/repo'].history.length === 2)

  console.log('\n-- refresh capture does not lose a rotated token --')
  writeLogin('b@example.com', 'Org B', 'TOKEN-B-ROTATED')
  profiles.capture(ROOT, 'acctB', OPTS)
  profiles.apply(ROOT, 'acctA', OPTS)
  profiles.apply(ROOT, 'acctB', OPTS)
  const creds3 = credstore.read(null, OPTS)
  check('rotated token preserved through a round trip',
    creds3.claudeAiOauth.accessToken === 'TOKEN-B-ROTATED', creds3.claudeAiOauth.accessToken)

  console.log('\n-- remove a profile --')
  profiles.remove(ROOT, 'acctA')
  check('profile gone', !profiles.exists(ROOT, 'acctA'))
  check('meta gone', !fs.existsSync(path.join(ROOT, 'profiles', 'acctA.meta.json')))
  check('live login untouched by removal', credstore.exists(null, OPTS))

  console.log('\n-- importFromDir: move a staged login into a profile --')
  const stage = path.join(TMP, 'stage-c')
  fs.mkdirSync(stage, { recursive: true })
  fs.writeFileSync(path.join(stage, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'TOKEN-C', refreshToken: 'REFRESH-C' },
  }))
  fs.writeFileSync(path.join(stage, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'c@example.com', organizationName: 'Org C' }, userID: 'uid-c',
    projects: { should: 'not be copied' },
  }))
  const imp = profiles.importFromDir(ROOT, 'acctC', stage, { move: true })
  check('import reports identity', imp.email === 'c@example.com', JSON.stringify(imp))
  check('profile created', profiles.exists(ROOT, 'acctC'))
  check('source credentials removed after verified copy', !fs.existsSync(path.join(stage, '.credentials.json')))
  check('source config left in place', fs.existsSync(path.join(stage, '.claude.json')))
  check('encrypted blob holds no plaintext token',
    !fs.readFileSync(path.join(ROOT, 'profiles', 'acctC.enc')).toString('utf8').includes('TOKEN-C'))

  profiles.apply(ROOT, 'acctC', OPTS)
  const credsC = credstore.read(null, OPTS)
  const cfgC = JSON.parse(fs.readFileSync(P.claudeJson, 'utf8'))
  check('imported profile applies as the live login', credsC.claudeAiOauth.accessToken === 'TOKEN-C')
  check('staged project state was not carried over', cfgC.projects && !cfgC.projects.should)

  console.log('\n-- importFromDir: copy mode keeps the source --')
  const stageD = path.join(TMP, 'stage-d')
  fs.mkdirSync(stageD, { recursive: true })
  fs.writeFileSync(path.join(stageD, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'TOKEN-D', refreshToken: 'REFRESH-D' },
  }))
  let noId = null
  try { profiles.importFromDir(ROOT, 'acctD', stageD, { fallback: { email: 'd@example.com', org: 'Org D' } }) } catch (e) { noId = e }
  check('a login without account details is not imported yet', noId && noId.code === 'ENOIDENTITY' && !profiles.exists(ROOT, 'acctD'))
  check('and its login is left where it is', fs.existsSync(path.join(stageD, '.credentials.json')))
  fs.writeFileSync(path.join(stageD, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'd@example.com', organizationName: 'Org D', accountUuid: 'uuid-d' } }))
  profiles.importFromDir(ROOT, 'acctD', stageD, { fallback: { email: 'd@example.com', org: 'Org D' } })
  check('copy mode leaves the source login', fs.existsSync(path.join(stageD, '.credentials.json')))
  check('once Claude Code has written them, it is imported',
    (profiles.list(ROOT).find((p) => p.name === 'acctD') || {}).email === 'd@example.com')

  console.log('\n-- importFromDir: nothing to import --')
  let threw = false
  try { profiles.importFromDir(ROOT, 'acctE', path.join(TMP, 'no-such-dir'), { move: true }) } catch { threw = true }
  check('throws when the folder has no login', threw)
  check('no empty profile left behind', !profiles.exists(ROOT, 'acctE'))

  console.log('\n-- findByEmail / capturedAt --')
  check('finds the profile holding an email', profiles.findByEmail(ROOT, 'c@example.com') === 'acctC')
  check('ignores the excluded name', profiles.findByEmail(ROOT, 'c@example.com', 'acctC') === null)
  check('unknown email finds nothing', profiles.findByEmail(ROOT, 'nobody@example.com') === null)
  check('capturedAt is a recent timestamp', Date.now() - profiles.capturedAt(ROOT, 'acctC') < 60000)
  console.log('\n-- remote control switch writes settings.json safely --')
  const remote = require('../lib/remote.js')
  const settingsFile = remote.settingsPath(OPTS)
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify({
    env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_HEADERS: 'secret-header' },
    hooks: { SessionEnd: [{ matcher: '*', hooks: [{ type: 'command', command: 'relay.bat' }] }] },
    theme: 'dark',
    remoteControlAtStartup: true,
  }, null, 2))

  check('starts enabled', remote.isDisabled(OPTS) === false)

  const off = remote.setDisabled(true, OPTS)
  check('reports the change', off.changed === true && off.disabled === true)
  check('flag written', remote.isDisabled(OPTS) === true)
  const afterOff = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  check('disableRemoteControl set to true', afterOff.disableRemoteControl === true)
  check('hooks preserved', afterOff.hooks.SessionEnd[0].hooks[0].command === 'relay.bat')
  check('env preserved', afterOff.env.OTEL_EXPORTER_OTLP_HEADERS === 'secret-header')
  check('other settings preserved', afterOff.theme === 'dark' && afterOff.remoteControlAtStartup === true)

  check('setting it again is a no-op', remote.setDisabled(true, OPTS).changed === false)

  const on = remote.setDisabled(false, OPTS)
  check('turning it back on reports a change', on.changed === true && on.disabled === false)
  const afterOn = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  check('flag removed rather than left as false', !('disableRemoteControl' in afterOn))
  check('everything else still intact',
    afterOn.theme === 'dark' && afterOn.env.CLAUDE_CODE_ENABLE_TELEMETRY === '1' &&
    afterOn.hooks.SessionEnd[0].hooks[0].command === 'relay.bat')
  check('no temp files left behind',
    fs.readdirSync(path.dirname(settingsFile)).every((f) => !f.includes('.tmp-')))

  console.log('\n-- remote control preference is per account --')
  const store2 = require('../lib/store.js')
  store2.setRemote(ROOT, 'acctB', 'off')
  check('stored for one account', store2.getRemote(ROOT, 'acctB') === 'off')
  check('other accounts unaffected', store2.getRemote(ROOT, 'acctC') === 'on')
  check('survives a registry round trip',
    JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf8')).remote.acctB === 'off')
  store2.setRemote(ROOT, 'acctB', 'on')
  check('clearing removes the entry',
    !JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf8')).remote.acctB)

  console.log('\n-- a missing settings.json is created, not crashed on --')
  fs.rmSync(settingsFile, { force: true })
  check('reads as enabled when absent', remote.isDisabled(OPTS) === false)
  remote.setDisabled(true, OPTS)
  check('creates the file with just the flag', (() => {
    const j = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    return j.disableRemoteControl === true && Object.keys(j).length === 1
  })())
  console.log('\n-- Artifacts per account writes enableArtifact, and only false --')
  const artifacts = require('../lib/artifacts.js')
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', hooks: { Stop: [] } }, null, 2))
  check('on by default', artifacts.isOff(OPTS) === false)
  check('turning it off reports a change', artifacts.setOff(true, OPTS).changed === true)
  let a1 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  check('writes enableArtifact: false', a1.enableArtifact === false && artifacts.isOff(OPTS) === true)
  check('keeps everything else', a1.theme === 'dark' && Array.isArray(a1.hooks.Stop))
  check('off again is a no-op', artifacts.setOff(true, OPTS).changed === false)
  artifacts.setOff(false, OPTS)
  a1 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  check('on removes the key rather than writing true', !('enableArtifact' in a1) && a1.theme === 'dark')
  check('on again is a no-op', artifacts.setOff(false, OPTS).changed === false)
  store2.setArtifacts(ROOT, 'acctB', 'off')
  check('the preference is per account', store2.getArtifacts(ROOT, 'acctB') === 'off' && store2.getArtifacts(ROOT, 'acctC') === 'on')
  check('and marks the setting as managed', store2.artifactsManaged(ROOT) === true)
  store2.setArtifacts(ROOT, 'acctB', 'on')
  check('with nobody off, nothing is managed', store2.artifactsManaged(ROOT) === false)

  console.log('\n-- a settings.json that is not valid JSON is never rewritten --')
  const broken = '{ "hooks": { "Stop": [ ] }, // a comment\n "theme": "dark" }'
  fs.writeFileSync(settingsFile, broken)
  let refused = null
  try { artifacts.setOff(true, OPTS) } catch (e) { refused = e }
  check('Artifacts refuses, with a reason', refused && /not valid JSON/.test(refused.message))
  refused = null
  try { remote.setDisabled(true, OPTS) } catch (e) { refused = e }
  check('so does Remote Control', refused && /not valid JSON/.test(refused.message))
  check('and the file is exactly as it was', fs.readFileSync(settingsFile, 'utf8') === broken)
  fs.writeFileSync(settingsFile, '\uFEFF{"theme":"dark"}')
  check('a byte-order mark is not mistaken for damage', artifacts.setOff(true, OPTS).changed === true &&
    JSON.parse(fs.readFileSync(settingsFile, 'utf8')).theme === 'dark')

  console.log('\n-- one account\'s login is never saved under another (audit #1, #2) --')
  {
    const secrets = require('../lib/secrets.js')
    const H2 = path.join(TMP, 'home2')
    const R2 = path.join(TMP, 'root2')
    fs.mkdirSync(H2, { recursive: true })
    fs.mkdirSync(R2, { recursive: true })
    const O2 = { home: H2 }
    const P2 = profiles.paths(O2)
    const live = (email, uuid, rt) => {
      fs.mkdirSync(P2.claudeDir, { recursive: true })
      credstore.write(null, { claudeAiOauth: { accessToken: 'AT-' + rt, refreshToken: rt, expiresAt: Date.now() + 3600e3 } }, O2)
      let prev = { projects: { '/w': { allowedTools: ['Bash'] } }, mcpServers: { s: { command: 'x' } } }
      try { prev = JSON.parse(fs.readFileSync(P2.claudeJson, 'utf8')) || prev } catch {  }
      fs.writeFileSync(P2.claudeJson, JSON.stringify({ ...prev, oauthAccount: { emailAddress: email, organizationName: 'Org', accountUuid: uuid }, userID: 'u-' + uuid }, null, 2))
    }
    const saveRaw = (name, payload) => fs.writeFileSync(path.join(profiles.profilesDir(R2), name + '.enc'),
      secrets.protect(Buffer.from(JSON.stringify({ capturedAt: new Date().toISOString(), ...payload }))))
    const rtOf = (n) => profiles.readPayload(R2, n).credentials.claudeAiOauth.refreshToken
    const liveRt = () => credstore.read(null, O2).claudeAiOauth.refreshToken
    const code = (fn) => { try { fn(); return null } catch (e) { return e.code || e.message } }

    live('one@x.co', 'uuid-1', 'RT-1'); profiles.capture(R2, 'one', O2)
    live('two@x.co', 'uuid-2', 'RT-2'); profiles.capture(R2, 'two', O2)
    live('one@x.co', 'uuid-1b', 'RT-1B'); profiles.capture(R2, 'one-b', O2)
    check('one email in two organizations: the live one is told apart by its uuid', profiles.activeProfile(R2, O2) === 'one-b', profiles.activeProfile(R2, O2))
    check('saving the live login over a different account is refused',
      code(() => profiles.capture(R2, 'one', O2)) === 'EACCOUNTMISMATCH' && rtOf('one') === 'RT-1')
    check('so is saving it under a second name', code(() => profiles.capture(R2, 'copy', O2)) === 'EACCOUNTMISMATCH' && !profiles.exists(R2, 'copy'))
    check('a duplicate account found by uuid, not just email', profiles.findSameAccount(R2, { accountUuid: 'uuid-2', email: 'x@y.z' }) === 'two')

    const noId = JSON.parse(fs.readFileSync(P2.claudeJson, 'utf8'))
    delete noId.oauthAccount
    fs.writeFileSync(P2.claudeJson, JSON.stringify(noId))
    check('a login without account details is never saved', code(() => profiles.capture(R2, 'one-b', O2)) === 'ENOIDENTITY' && rtOf('one-b') === 'RT-1B')
    live('one@x.co', 'uuid-1b', 'RT-1B')
    profiles.capture(R2, 'one-b', O2)
    check('a saved account is backed up before it is overwritten',
      fs.readdirSync(path.join(R2, 'backups')).some((f) => /^one-b-.*\.enc$/.test(f)))

    saveRaw('bare', { credentials: { claudeAiOauth: { accessToken: 'AT-N', refreshToken: 'RT-N' } }, identity: {} })
    check('an account saved without its details is not switched to', code(() => profiles.apply(R2, 'bare', O2)) === 'ENOIDENTITY' && liveRt() === 'RT-1B')

    for (const [what, text] of [['half-written', '{"projects": {"/w": {'], ['empty', ''], ['null', 'null']]) {
      fs.writeFileSync(P2.claudeJson, text)
      const c = code(() => profiles.apply(R2, 'two', O2))
      check('a ' + what + ' ~/.claude.json stops the switch, and is left exactly as it was',
        c === 'EUNREADABLEJSON' && fs.readFileSync(P2.claudeJson, 'utf8') === text && liveRt() === 'RT-1B', String(c))
    }
    fs.writeFileSync(P2.claudeJson, '﻿' + JSON.stringify({ projects: { '/w': { allowedTools: ['Bash'] } }, mcpServers: { s: {} },
      oauthAccount: { emailAddress: 'one@x.co', accountUuid: 'uuid-1b' }, userID: 'u-1b' }))
    profiles.apply(R2, 'two', O2)
    const afterBom = JSON.parse(fs.readFileSync(P2.claudeJson, 'utf8'))
    check('a byte-order mark is not damage: the switch goes ahead and keeps everything else',
      afterBom.oauthAccount.accountUuid === 'uuid-2' && afterBom.projects['/w'] && afterBom.mcpServers.s && liveRt() === 'RT-2')

    saveRaw('nouid', { credentials: { claudeAiOauth: { accessToken: 'AT-3', refreshToken: 'RT-3' } },
      identity: { oauthAccount: { emailAddress: 'three@x.co', accountUuid: 'uuid-3' } } })
    profiles.apply(R2, 'nouid', O2)
    check('identity keys the account lacks are removed, not left over from the previous one',
      !('userID' in JSON.parse(fs.readFileSync(P2.claudeJson, 'utf8'))))

    live('two@x.co', 'uuid-2', 'RT-2')
    profiles.apply(R2, 'two', O2)
    fs.copyFileSync(path.join(profiles.profilesDir(R2), 'two.enc'), path.join(profiles.profilesDir(R2), 'two-old.enc'))
    profiles.writeMeta(R2, 'two-old', { ...profiles.readMeta(R2, 'two'), capturedAt: '2020-01-01T00:00:00.000Z' })
    check('with one account saved twice, the live one is the copy saved last', profiles.activeProfile(R2, O2) === 'two')
    check('saving the live login into it still works (no dead end)', code(() => profiles.capture(R2, 'two', O2)) === null)
    check('and the duplicate is reported', JSON.stringify(profiles.duplicates(R2)) === '[["two","two-old"]]', JSON.stringify(profiles.duplicates(R2)))
    profiles.remove(R2, 'two-old')

    const stageX = path.join(TMP, 'stage-x')
    fs.mkdirSync(stageX, { recursive: true })
    credstore.write(stageX, { claudeAiOauth: { accessToken: 'AT-X', refreshToken: 'RT-X' } }, O2)
    profiles.importFromDir(R2, 'xen', stageX, { move: true, confirmedEmail: 'x@x.co', fallback: { org: 'Org X' } })
    check('a confirmed sign-in without written details is named by the email the CLI reported',
      profiles.readMeta(R2, 'xen').email === 'x@x.co' && profiles.readPayload(R2, 'xen').identity.oauthAccount.emailAddress === 'x@x.co')

    if (process.platform !== 'win32') {
      fs.chmodSync(P2.claudeJson, 0o600)
      profiles.apply(R2, 'two', O2)
      check('~/.claude.json stays private (0600) after a switch', (fs.statSync(P2.claudeJson).mode & 0o777) === 0o600,
        (fs.statSync(P2.claudeJson).mode & 0o777).toString(8))
      const real = path.join(TMP, 'dotfiles-claude.json')
      fs.renameSync(P2.claudeJson, real)
      fs.symlinkSync(real, P2.claudeJson)
      profiles.apply(R2, 'nouid', O2)
      check('a symlinked ~/.claude.json stays a link, and the file it points to is what changes',
        fs.lstatSync(P2.claudeJson).isSymbolicLink() && JSON.parse(fs.readFileSync(real, 'utf8')).oauthAccount.accountUuid === 'uuid-3')
      fs.rmSync(P2.claudeJson)
      fs.renameSync(real, P2.claudeJson)

      if (!(process.getuid && process.getuid() === 0)) {
        const before = liveRt()
        fs.chmodSync(H2, 0o500)
        let failed = false
        try { profiles.apply(R2, 'two', O2) } catch { failed = true }
        fs.chmodSync(H2, 0o700)
        check('if ~/.claude.json can\'t be written, the previous login is put back', failed && liveRt() === before, liveRt())
      }
    } else {
      const twoRt = profiles.readPayload(R2, 'two').credentials.claudeAiOauth.refreshToken
      if (liveRt() === twoRt) profiles.apply(R2, 'nouid', O2)
      const marker = path.join(TMP, 'holding')
      const holder = require('child_process').spawn(process.execPath, ['-e',
        'const fs = require("fs"); const fd = fs.openSync(' + JSON.stringify(P2.claudeJson) + ', "r");' +
        'fs.writeFileSync(' + JSON.stringify(marker) + ', ""); setTimeout(() => fs.closeSync(fd), 15000)'])
      const fsx = require('../lib/fsx.js')
      for (let i = 0; i < 200 && !fs.existsSync(marker); i++) fsx.sleepSync(25)
      const before = liveRt()
      const cfgBefore = fs.readFileSync(P2.claudeJson, 'utf8')
      let failed = null
      try { profiles.apply(R2, 'two', O2) } catch (e) { failed = e.code || e.message }
      holder.kill()
      check('if ~/.claude.json can\'t be written, the previous login is put back',
        failed === 'EPERM' && before !== twoRt && liveRt() === before && fs.readFileSync(P2.claudeJson, 'utf8') === cfgBefore, String(failed))
    }
  }

  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====')
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(fail ? 1 : 0)
}

main()
