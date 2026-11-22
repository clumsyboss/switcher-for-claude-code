const MAIN = 'main'
const EXPERIMENTAL = 'experimental'
const EDITIONS = [MAIN, EXPERIMENTAL]

const MAIN_COMMANDS = [
  'openAccounts',
  'globalSwitch',
  'globalAdd',
  'pinFolder',
  'pinChat',
  'refreshAllAccounts',
  'showStatus',
  'switchTo',
  'refreshUsage',
  'relogin',
  'openAccountsTab',
  'startSession',
]

const MAIN_SETTINGS = [
  'claudeswitcher.accountsView',
  'claudeswitcher.trackAllAccounts',
  'claudeswitcher.confirmOrganizationSwitch',
  'claudeswitcher.cards.tint',
  'claudeswitcher.cards.context',
  'claudeswitcher.cards.toggles',
  'claudeswitcher.statusBar.usage',
  'claudeswitcher.statusBar.loginDays',
  'claudeswitcher.usageIcon',
  'claudeswitcher.root',
]

const MAIN_TITLES = {}

const FEATURES = ['artifacts', 'spareLogin', 'startSession', 'context', 'transfer', 'autoContinue', 'keepAlive']
const MAIN_FEATURES = ['artifacts', 'spareLogin', 'startSession', 'context', 'transfer', 'autoContinue', 'keepAlive']

const MAIN_META = {
  displayName: 'Switcher for Claude Code [Unofficial]',
  description: "Switch between multiple Claude Code accounts in one click. See every account's 5-hour and weekly usage limits, " +
    'auto-continue chats when a limit hits, and pin folders or chats to their own Claude account. Unofficial; not affiliated with Anthropic.',
}

const EXPERIMENTAL_META = {
  displayName: 'Switcher for Claude Code (Experimental) [Unofficial]',
  description: 'The Switcher for Claude Code release, plus features being tried out before they ship.',
}

function isEdition(v) { return EDITIONS.indexOf(v) !== -1 }

function from(context) {
  const pkg = context && context.extension && context.extension.packageJSON
  const v = pkg && pkg.claudeswitcher && pkg.claudeswitcher.edition
  return isEdition(v) ? v : EXPERIMENTAL
}

function commandsFor(edition) {
  return edition === MAIN ? MAIN_COMMANDS.slice() : null
}

function includes(edition, id) {
  const allowed = commandsFor(edition)
  return !allowed || allowed.indexOf(id) !== -1
}

function metaFor(edition) {
  return edition === MAIN ? { ...MAIN_META } : { ...EXPERIMENTAL_META }
}

function hasFeature(edition, feature) {
  if (FEATURES.indexOf(feature) === -1) return false
  return edition === MAIN ? MAIN_FEATURES.indexOf(feature) !== -1 : true
}

module.exports = {
  MAIN, EXPERIMENTAL, EDITIONS,
  MAIN_COMMANDS, MAIN_SETTINGS, MAIN_TITLES, FEATURES, MAIN_FEATURES,
  isEdition, from, commandsFor, includes, metaFor, hasFeature,
}
