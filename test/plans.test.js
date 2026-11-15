const profiles = require('../lib/profiles.js')
const usage = require('../lib/usage.js')

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  <- ' + extra : '')) }
}

const login = (subscriptionType, rateLimitTier) => ({ claudeAiOauth: { subscriptionType, rateLimitTier } })

console.log('-- the plan, from the login and the identity --')
check('Max 20x', profiles.planOf({}, login('max', 'default_claude_max_20x')) === 'Max 20x')
check('Max 5x', profiles.planOf({}, login('max', 'default_claude_max_5x')) === 'Max 5x')
check('a Team seat with 5x', profiles.planOf({ seatTier: 'team_tier_1' }, login('team', 'default_claude_max_5x')) === 'Team 5x')
check('Pro', profiles.planOf({}, login('pro', 'default_claude_ai')) === 'Pro')
check('the identity alone, when the login doesn\'t say',
  profiles.planOf({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' }, {}) === 'Max 20x' &&
  profiles.planOf({ organizationType: 'claude_team', userRateLimitTier: 'default_claude_max_5x' }, null) === 'Team 5x')
check('nothing known, nothing made up', profiles.planOf(null, null) === null &&
  profiles.planOf({ organizationType: 'something_new' }, login(undefined, undefined)) === null)

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
