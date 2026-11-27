require('./fake-security')
const profiles = require('../lib/profiles.js')
const usage = require('../lib/usage.js')

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  <- ' + extra : '')) }
}

const login = (subscriptionType, rateLimitTier) => ({ claudeAiOauth: { subscriptionType, rateLimitTier } })

console.log('-- the plan, from the login and the identity --')
check('Ultra: what the login still calls Max with a 20x tier', profiles.planOf({}, login('max', 'default_claude_max_20x')) === 'Ultra')
check('Max: Max with a 5x tier, or none', profiles.planOf({}, login('max', 'default_claude_max_5x')) === 'Max' &&
  profiles.planOf({}, login('max', undefined)) === 'Max')
check('Team Max, Team Pro and plain Team, by the usage tier of the seat',
  profiles.planOf({ seatTier: 'team_tier_1' }, login('team', 'default_claude_max_5x')) === 'Team Max' &&
  profiles.planOf({}, login('team', 'default_claude_ai')) === 'Team Pro' &&
  profiles.planOf({}, login('team', 'default_claude_pro')) === 'Team Pro' &&
  profiles.planOf({}, login('team', undefined)) === 'Team')
check('Pro and Free',
  profiles.planOf({}, login('pro', 'default_claude_ai')) === 'Pro' && profiles.planOf({}, login('free', undefined)) === 'Free')
check('the identity alone, when the login doesn\'t say',
  profiles.planOf({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' }, {}) === 'Ultra' &&
  profiles.planOf({ organizationType: 'claude_team', userRateLimitTier: 'default_claude_max_5x' }, null) === 'Team Max')
check('nothing known, nothing made up', profiles.planOf(null, null) === null &&
  profiles.planOf({ organizationType: 'something_new' }, login(undefined, undefined)) === null)
check('a plan an earlier version recorded shows by today\'s name', profiles.planName('Max 20x') === 'Ultra' &&
  profiles.planName('Max 5x') === 'Max' && profiles.planName('Team 5x') === 'Team Pro' && profiles.planName('Team') === 'Team' && profiles.planName('Pro') === 'Pro' &&
  profiles.planName(null) === null)

console.log('\n-- when a login has to be signed in again --')
const day = 86400000
const at = Date.UTC(2026, 10, 16, 12)
check('read from the login itself, and nothing else about it', profiles.loginExpiresAt({ claudeAiOauth: { refreshToken: 'secret', refreshTokenExpiresAt: at } }) === at &&
  profiles.loginExpiresAt({ claudeAiOauth: {} }) === null && profiles.loginExpiresAt(null) === null)
check('as days in brackets: 29D, 1D, 0D on its last day, then expired',
  usage.loginDaysText(at + 29.5 * day, at) === '29D' && usage.loginDaysText(at + 1.2 * day, at) === '1D' &&
  usage.loginDaysText(at + 3600e3, at) === '0D' && usage.loginDaysText(at - 1, at) === 'expired' && usage.loginDaysText(null, at) === null)

const fs = require('fs')
const os = require('os')
const path = require('path')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-plans-'))
usage.writeLiveCache(ROOT, null, { limits: [] }, at + 10 * day)
check('the live login\'s date is shared with its figures, for every window', usage.readLiveLoginExpiry(ROOT, null) === at + 10 * day &&
  usage.readLiveCache(ROOT, null) !== undefined)
usage.writeLiveCache(ROOT, null, { limits: [] })
check('and figures read without it simply have none', usage.readLiveLoginExpiry(ROOT, null) === null)
fs.rmSync(ROOT, { recursive: true, force: true })

console.log('\n-- the status bar text --')
const limit = (kind, percent, model) => ({ kind, percent, resets_at: null, scope: model ? { model: { display_name: model } } : null })
const shaped = (limits) => usage.shape({ fetchedAtMs: 1, utilization: { limits } })
const team = shaped([limit('session', 25), limit('weekly_all', 87), limit('weekly_scoped', 52, 'Fable')])
check('with a 5-hour limit: session | Fable | weekly', usage.compactText(team) === '25% | 52% | 87%', usage.compactText(team))
const idle = shaped([limit('session', 0), limit('weekly_all', 61), limit('weekly_scoped', 10, 'Fable')])
check('an idle account still has its 5-hour limit, at 0%', usage.compactText(idle) === '0% | 10% | 61%', usage.compactText(idle))
const noFive = shaped([limit('weekly_all', 98), limit('weekly_scoped', 62, 'Fable')])
check('with no 5-hour limit: Fable | weekly, without an empty slot', usage.compactText(noFive) === '62% | 98%', usage.compactText(noFive))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
