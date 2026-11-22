const WHATS_NEW = {
  '1.4.0': [
    { icon: 'signin', step: 'cards', title: 'Sign in on the page',
      text: 'Adding an account or signing in again no longer opens a terminal. The page does it, with a box for pasting a code.' },
    { icon: 'pin', step: 'pinbtn', title: 'Pinning logins',
      text: 'Give an account a second login for its pinned chats and folders, so they never sign out your other chats.' },
    { icon: 'clock', step: 'plan', title: 'Days left on every login',
      text: 'A thin line round each card and the status bar show how long logins last, about 30 days, with a reminder before one ends.' },
    { icon: 'pin', step: 'pins', title: 'Pin a chat, not just a folder',
      text: 'Give a single chat its own account. Pinning a folder no longer needs a reload.' },
    { icon: 'plant-ultra', step: 'plan', title: 'Plans by their new names',
      text: 'Free, Pro, Max, Ultra and Team, as a badge on each card. Team seats show Team Max or Team Pro.' },
    { icon: 'swap', step: 'switch', title: 'A heads-up before changing organization',
      text: 'Switching to an account in another organization asks first, since chats there can’t reuse Claude’s earlier thinking.' },
    { icon: 'gear', step: 'settings', title: 'Settings and Check everything',
      text: 'Tinted cards, what each card shows, the status bar and more, plus a check that everything works, from the ⚙ menu.' },
  ],
}

function compare(a, b) {
  const x = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const y = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

function welcomeFor(seen, version, hasAccounts, whatsNew) {
  const table = whatsNew || WHATS_NEW
  if (!seen) {
    if (!hasAccounts) return { kind: 'install', version }
    seen = '0.0.0'
  }
  if (compare(seen, version) >= 0) return null
  const versions = Object.keys(table).filter((v) => compare(v, seen) > 0 && compare(v, version) <= 0).sort((a, b) => compare(b, a))
  const items = versions.flatMap((v) => table[v])
  return items.length ? { kind: 'update', version, items } : null
}

module.exports = { welcomeFor, compare, WHATS_NEW }
