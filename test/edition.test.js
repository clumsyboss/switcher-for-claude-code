require('./fake-security')

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const edition = require('../lib/edition')
const build = require('../build.js')

const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
const PREFIX = 'claudeswitcher.'

let passed = 0
let failed = 0
function check(what, ok) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what) }
}

console.log('\n-- the release set is real --')
const allIds = base.contributes.commands.map((c) => c.command.slice(PREFIX.length))
check('every release command exists in package.json',
  edition.MAIN_COMMANDS.every((id) => allIds.includes(id)))
check('no duplicates in the release set',
  new Set(edition.MAIN_COMMANDS).size === edition.MAIN_COMMANDS.length)
check('every title override names a release command',
  Object.keys(edition.MAIN_TITLES).every((id) => edition.MAIN_COMMANDS.includes(id)))
check('every release setting exists',
  edition.MAIN_SETTINGS.every((k) => k in base.contributes.configuration.properties))

console.log('\n-- the release palette is the six actions, nothing more --')
const hidden = new Set((base.contributes.menus.commandPalette || [])
  .filter((m) => m.when === 'false').map((m) => m.command.slice(PREFIX.length)))
const visible = edition.MAIN_COMMANDS.filter((id) => !hidden.has(id))
check('visible: ' + visible.join(', '),
  visible.slice().sort().join(',') ===
    ['openAccounts', 'globalSwitch', 'globalAdd', 'pinFolder', 'refreshAllAccounts', 'showStatus'].sort().join(','))
for (const id of ['openAccounts', 'globalSwitch', 'globalAdd', 'pinFolder', 'refreshAllAccounts', 'showStatus']) {
  check(id + ' ships in the release', edition.includes(edition.MAIN, id))
}
check('the hidden ones are still registered, for clicks and buttons',
  ['switchTo', 'refreshUsage', 'relogin', 'windowLogin', 'openAccountsTab'].every((id) => edition.includes(edition.MAIN, id)))

console.log('\n-- what the clean-up removed is gone from both --')
for (const id of ['usePerWindowAccounts', 'useMachineWideAccount', 'openWindowAs', 'newTerminalAs', 'newChatAs',
  'remoteControl', 'backup', 'restore', 'switchAccount', 'addAccount', 'removeAccount', 'globalRemove',
  'globalImport', 'renameAccount', 'setAccountIcon', 'saveCurrentLogin', 'openConfigFile', 'forgetWindowLogin']) {
  check(id + ' is not a command any more', !allIds.includes(id))
}
check('the per-window reload setting is gone', !('claudeswitcher.reloadPrompt' in base.contributes.configuration.properties))

console.log('\n-- experimental ships everything --')
check('no command is filtered out',
  allIds.every((id) => edition.includes(edition.EXPERIMENTAL, id)))
check('commandsFor(experimental) means "no filter"',
  edition.commandsFor(edition.EXPERIMENTAL) === null)

console.log('\n-- generated manifests --')
const mainPkg = build.manifestFor(edition.MAIN, base)
const expPkg = build.manifestFor(edition.EXPERIMENTAL, base)

check('release manifest has exactly the release commands',
  mainPkg.contributes.commands.length === edition.MAIN_COMMANDS.length)
check('release manifest declares its edition', mainPkg.claudeswitcher.edition === 'main')
check('experimental manifest declares its edition', expPkg.claudeswitcher.edition === 'experimental')
check('experimental manifest keeps every command',
  expPkg.contributes.commands.length === base.contributes.commands.length)
check('the two share one extension id, so installing one replaces the other',
  mainPkg.name === expPkg.name && mainPkg.name === base.name)
check('display names differ', mainPkg.displayName !== expPkg.displayName)
check('the release is not labelled experimental', !/experimental/i.test(mainPkg.displayName))
check('release keeps the settings it uses',
  Object.keys(mainPkg.contributes.configuration.properties).sort().join(',') ===
    edition.MAIN_SETTINGS.slice().sort().join(','))
check('both start immediately, so a folder pin lands before Claude Code starts',
  JSON.stringify(mainPkg.activationEvents) === '["*"]' && JSON.stringify(expPkg.activationEvents) === '["*"]')
check('every release command still has a title and category',
  mainPkg.contributes.commands.every((c) => c.title && c.category))
check('both keep the sidebar view and its activity-bar icon',
  [mainPkg, expPkg].every((p) => p.contributes.views.claudeAccounts[0].id === 'claudeswitcher.accountsView' &&
    p.contributes.viewsContainers.activitybar[0].icon === 'media/activity.svg'))
check('the activity-bar icon is in the package',
  fs.existsSync(path.join(__dirname, '..', 'media', 'activity.svg')))
const ids = (p) => new Set(p.contributes.commands.map((c) => c.command))
check('every menu entry in the release points at a release command',
  Object.values(mainPkg.contributes.menus).every((list) => list.every((m) => ids(mainPkg).has(m.command))))
check('building does not mutate the source manifest',
  JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))) ===
    JSON.stringify(base))

console.log('\n-- a feature added to experimental stays out of the release until promoted --')
const trial = JSON.parse(JSON.stringify(base))
trial.contributes.commands.push({ command: PREFIX + 'tryThis', title: 'Claude Accounts: Try This', category: 'Claude Accounts' })
trial.contributes.menus['view/title'].push({ command: PREFIX + 'tryThis', when: 'view == claudeswitcher.accountsView' })
trial.contributes.configuration.properties['claudeswitcher.tryThis'] = { type: 'boolean', default: false }
const trialMain = build.manifestFor(edition.MAIN, trial)
const trialExp = build.manifestFor(edition.EXPERIMENTAL, trial)
check('experimental gets the new command', ids(trialExp).has(PREFIX + 'tryThis'))
check('the release does not', !ids(trialMain).has(PREFIX + 'tryThis'))
check('nor its menu entry', !trialMain.contributes.menus['view/title'].some((m) => m.command === PREFIX + 'tryThis'))
check('nor its setting', !('claudeswitcher.tryThis' in trialMain.contributes.configuration.properties))
check('experimental keeps both', trialExp.contributes.menus['view/title'].some((m) => m.command === PREFIX + 'tryThis') &&
  'claudeswitcher.tryThis' in trialExp.contributes.configuration.properties)

console.log('\n-- page features: experimental first, then promoted --')
check('every promoted feature is a known one', edition.MAIN_FEATURES.every((f) => edition.FEATURES.includes(f)))
check('experimental shows every feature', edition.FEATURES.every((f) => edition.hasFeature(edition.EXPERIMENTAL, f)))
check('the release shows only promoted ones', edition.FEATURES.every((f) =>
  edition.hasFeature(edition.MAIN, f) === edition.MAIN_FEATURES.includes(f)))
check('the Artifacts switch was promoted into the release in 1.1.0', edition.hasFeature(edition.EXPERIMENTAL, 'artifacts') &&
  edition.hasFeature(edition.MAIN, 'artifacts'))
check('"Make a login for another PC" was promoted into the release in 1.2.0',
  edition.hasFeature(edition.EXPERIMENTAL, 'spareLogin') && edition.hasFeature(edition.MAIN, 'spareLogin'))
check('so was "Start a 5-hour session", with its command', edition.hasFeature(edition.EXPERIMENTAL, 'startSession') &&
  edition.hasFeature(edition.MAIN, 'startSession') && edition.includes(edition.MAIN, 'startSession'))
check('and the chat context display', edition.hasFeature(edition.EXPERIMENTAL, 'context') && edition.hasFeature(edition.MAIN, 'context'))
check('an unknown feature is off everywhere', !edition.hasFeature(edition.EXPERIMENTAL, 'nope') && !edition.hasFeature(edition.MAIN, 'nope'))

console.log('\n-- a promoted command that package.json forgot is caught --')
const stripped = JSON.parse(JSON.stringify(base))
stripped.contributes.commands = stripped.contributes.commands
  .filter((c) => c.command !== PREFIX + 'globalSwitch')
check('manifestFor throws instead of shipping a broken palette', (() => {
  try { build.manifestFor(edition.MAIN, stripped); return false } catch (e) {
    return /globalSwitch/.test(e.message)
  }
})())

console.log('\n-- edition detection --')
check('unknown edition falls back to experimental',
  edition.from({ extension: { packageJSON: { claudeswitcher: { edition: 'nonsense' } } } }) ===
    edition.EXPERIMENTAL)
check('no host context falls back to experimental', edition.from(undefined) === edition.EXPERIMENTAL)
check('bare context falls back to experimental', edition.from({ subscriptions: [] }) === edition.EXPERIMENTAL)
check('a release manifest is detected',
  edition.from({ extension: { packageJSON: mainPkg } }) === edition.MAIN)

console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'edition tests failed')
