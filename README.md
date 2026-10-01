# Claude Account Switcher

Switch between your Claude accounts in VS Code without going through the
browser login every time. See every account's 5-hour and weekly limits at a
glance, and pin a folder to its own account.

Everything stays on your machine. No server, no telemetry, no account data
leaves the laptop.

Works on **Windows, macOS and Linux**. Saved logins are encrypted at rest using
whatever credential store the platform provides. See [Security](#security) for details.

---

## Install

Download `claude-account-switcher-main-<version>.vsix` from the
[latest release](https://github.com/clumsyboss/switcher-for-claude-code/releases), then:

```powershell
code --install-extension claude-account-switcher-main-<version>.vsix
```

Reload VS Code. You should see your Claude account name in the bottom-right
status bar, next to a usage meter.

> If it shows an orange background, your current login hasn't been saved yet.
> Step 1 below takes care of that.

## First run

Open the **Claude Accounts** page: click the Claude Accounts icon in the
activity bar, or run **Claude Accounts: Open Accounts** from the Command
Palette (`Ctrl+Shift+P`).

1. **Save the account you already use.** The page says your current login isn't
   saved yet; click **Save it** and give it a short name. Nothing about your
   login changes; it is just recorded so you can come back to it.
2. **Add your other accounts.** Click **Add account** → name it → a terminal
   opens and a browser tab asks you to sign in.
   - Use a **private/incognito window** if your browser is already signed in to
     a different Claude account. Otherwise it will silently reuse that one, and
     the extension will tell you it is a duplicate.
   - Paste the code back into the terminal. The extension notices on its own and
     adds the account for you. There's no button to click.
3. **Switch.** Click **Switch** on an account's card, or click the account name
   in the status bar and pick one.

## The Accounts page

One card per saved account: its email, its 5-hour and weekly use with when each
resets, and everything you can do with it. The live account is the one with
the green outline. An account with pinned folders shows a pin and a count next
to its **⋯** menu; click it to see which folders.

| I want to… | On the page |
|---|---|
| Switch account | **Switch** on its card |
| Add an account | **Add account** |
| Refresh everyone's figures | **Update usage** |
| Rename it, or change its colour or status bar icon | **⋯ → Edit name & icon** |
| Turn Remote Control off for one account | The **Remote Control** switch on its card |
| Sign in again after a login expires | **Sign in again** on the card (or **⋯ → Sign in again**) |
| Remove an account from the switcher | **⋯ → Forget account** (your Claude account itself is untouched) |
| Pin a folder to an account | **Pin a folder…** under Folder pins |
| Unpin a folder | **Unpin** next to it |

It opens as an **editor tab**, like a file. It also lives in its own **sidebar
view**, in a compact one-column layout. Both are always available; the
`claudeswitcher.accountsView` setting picks which one **Open Accounts** shows.
The links at the bottom of the page move between the two.

The page follows your VS Code theme (light, dark or high contrast) and uses
VS Code's own icons. It loads nothing from the network, and every button goes back to the
extension, which checks it before doing anything.

## The status bar

| I want to… | Do this |
|---|---|
| See which account is live | Look at the bottom right |
| Switch account for every window that isn't pinned | Click the account name |
| See my limits | Look at the three percentages |
| See every account's limits | Hover the percentages |
| Update every account now | Click the percentages |
| Something is wrong | **Claude Accounts: Show Status**, then share the output |

The Command Palette has six commands, all under **Claude Accounts**: Open
Accounts, Switch Account, Add Account…, Pin Folder to Account…, Update Usage
and Show Status.

### The usage meter

```
📊 36% | 53% | 57%
   │     │     └── weekly, all models
   │     └──────── weekly, model-scoped (e.g. Fable)
   └────────────── session (5 hour)
```

It turns orange at 80% and red at 95%. The figures come from Claude Code's own
cache. Clicking updates every account's figures, this one straight from Anthropic.

### Every account at a glance

Hover the percentages for a table of every saved account. It shows how much of
each limit is used, with the time left until it resets in brackets, and the
weekly Fable limit as a percentage. The tick marks the account this window uses.

```
  | | Account   | 5-hour       | Weekly       | Fable |
  |✓| Work      | 70% (2h 12m) | 88% (3d 4h)  |   41% |
  | | Personal  |  4% (4h 48m) | 12% (5d 1h)  |    3% |
  | | Side      | 0% (reset)   |  5% (1d 16h) |    2% |
```

Click a name to switch to that account globally (pinned folders are unaffected).
"(reset)" means that limit has reset since the figure was taken, so 0% is the
real number now.

**How the figures stay live.** A saved account's login expires 8 hours after it
was last renewed. To keep reading usage for accounts you are not using, the
extension renews each saved login in the background once it has less than an
hour left, the same way Claude Code renews its own. Usage is read at most every
15 minutes per account, and not at all while Anthropic is rate-limiting it.

**What it will never do:**

- **Renew the account Claude Code is using.** Claude Code renews that one
  itself, and the saved copy holds a token it has already replaced. If the
  extension cannot tell which account is live, it renews nothing that round.
- **Race another window or a switch.** Every VS Code window shares one account
  store; a lock file makes sure only one renews an account at a time, and a
  switch waits for a renewal in progress to finish.
- **Lose a renewed login.** The new token is read back and checked before the
  old one is discarded.
- **Retry a rejected login.** If Anthropic refuses a saved login, the account
  shows *login expired* and is left alone until you sign it in again.

Turn the whole thing off with the `claudeswitcher.trackAllAccounts` setting;
that stops every background renewal and usage check.

## What switching does and does not touch

This is the part worth understanding, because an earlier design got it wrong.

Claude Code keeps **everything** in one directory: your credentials *and* every
conversation, your project settings, memory and todos. So the switcher keeps
that one directory exactly where it is (`~/.claude`) and swaps only the two
things that identify you: the credentials and the identity block.

**Untouched by a switch:** chat history, the sidebar conversation list, memory,
`CLAUDE.md`, project settings, todos, MCP servers, hooks.

**Changed by a switch:** who you are billed as, and which usage limits apply.

One caveat: **chats that are already open keep the previous account** until you
reopen them. The extension offers a window reload after each switch, which is
the reliable way to move everything across.

## Folder pins: a different account per window

Pin a folder to an account and every window of that folder runs Claude Code as
that account, while all your other windows keep following the switcher. The
chat list is the same everywhere, so a chat started under one account can be
continued under another.

**Claude Accounts: Pin Folder to Account…** (or **Pin a folder…** on the page)
asks which folder:

- **This folder** pins the open folder, then offers to reload the window.
- **Another folder…** pins a folder you pick and opens it in a new window.
- **Unpin this folder** puts it back on the switcher's account after a reload.

The first time an account is pinned, it needs a one-time browser sign-in of its
own, a *window login*. The extension asks for it when it is needed. A pinned
window shows **📌 account** in the status bar; clicking it manages the pin.

Unpinning keeps the window login, so pinning the folder again later needs no
sign-in. To remove a window login, use **⋯ → Forget window login** on the
account's card.

How it works:

```
~/.claude/                          your chats · the one shared history
~/.claude-switcher/windows/<name>/  used only by windows pinned to <name>
    .credentials.json   its window login: its own session, never the switcher's saved copy
    .claude.json        its identity, seeded once with your project trust and MCP servers
    settings.json       a copy of ~/.claude/settings.json, with this account's Remote Control choice
    projects/ sessions/ file-history/ tasks/ todos/ plans/ agents/ commands/
                        links into ~/.claude (junctions on Windows, symlinks elsewhere)
```

- Claude Code runs inside the extension host of each window and reads
  `CLAUDE_CONFIG_DIR` from it. This extension starts first and sets the variable
  for a pinned folder before Claude Code starts.
- If VS Code restores the Claude panel, Claude Code can start a moment earlier.
  Its chats still use the pinned account: the variable is read again for every
  chat process. Only a little startup state, such as its IDE connection file,
  stays on the default. **Show Status** reports when that happened.
- A window login is a **separate sign-in** from the account the switcher saved.
  They never share a refresh token, so renewing one can never sign the other
  out. The background tracker and the startup login import never touch window
  logins.
- Signing in as the wrong account (the browser reused another session) is
  caught: the login is discarded, not saved.
- Forgetting a window login removes its links first, then the folder. Your
  history is never reached through a link; tests prove it with a canary chat.

Known limits:

- Changing a folder's pin takes a window reload; a prompt running in that
  window at that moment is interrupted.
- Don't keep the same chat open in two windows pinned to different accounts:
  both would write to it.
- Project trust and MCP servers are copied once, when the window login is set
  up. Changes made later in a pinned window stay with that account.
- `claude` typed into a plain terminal in a pinned window still uses the
  switcher's account.

## Remote Control per account

Each card has a **Remote Control** switch. Turning it off for an account sets
`disableRemoteControl` in `~/.claude/settings.json` whenever that account is
live, and windows pinned to it get the same through their own `settings.json`.
Chats already running keep their current connection until they are restarted.

## Where your data lives

```
~/.claude/                          Claude Code's own directory · all your chats
~/.claude-switcher/
  registry.json                     account list, display names, icons, pins, active account
  profiles/
    <name>.enc                      encrypted credentials (see Security)
    <name>.meta.json                email, org, when it was saved
  accounts/<name>/                  scratch space used during a login, then emptied
  windows/<name>/                   an account's window login, for pinned folders
  usage/                            the last live usage figures per account
  locks/                            short-lived locks, so windows never renew at once
```

`registry.json` is plain JSON and safe to edit by hand; the extension watches it
and reloads.

**On macOS, Claude Code does not keep its live login in a file.** It uses the
login Keychain item `Claude Code-credentials`, and falls back to
`~/.claude/.credentials.json` only when the Keychain has nothing. The switcher
reads and writes that same item, so a switch looks to Claude Code exactly like a
fresh sign-in. **Show Status** prints where it is looking.

### Security

Saved logins are encrypted at rest. The key never leaves your OS credential
store, so a copied `.enc` file is inert on another machine or user account:

| | Credential store | Encryption |
|---|---|---|
| **Windows** | DPAPI, `CurrentUser` scope | DPAPI |
| **macOS** | login Keychain | AES-256-GCM |
| **Linux** | libsecret, else a `0600` key file | AES-256-GCM |

Run **Show Status** to see which one your machine is using.

The Linux file fallback is the weakest of the three: anything that can read
your home directory can read that key. It is only used when `secret-tool` is
not installed.

- Account directories are restricted to your user: ACL inheritance stripped on
  Windows, `chmod 700` elsewhere.
- A refresh token is never duplicated: a login is *moved* into the encrypted
  profile, and the plaintext copy is deleted only after the encrypted one has
  been read back and verified.
- Decryption is authenticated, so a tampered profile fails loudly rather than
  producing garbage.
- The extension never logs, prints or transmits token material.

**Profiles do not travel between machines.** That is the point of tying them to
the OS store, and a refresh token is replaced each time it is used, so a copy
would stop working anyway. To use an account on a second machine, add it there
and sign in again.

## Troubleshooting

**"Switched … but it reports signed out"** · That account's refresh token
expired (they last a few weeks). Click **Sign in again** on its card.

**A chat is still using the old account** · It was already open. Reload the
window.

**"Anthropic is rate-limiting usage checks" (HTTP 429)** · The usage endpoint
limits how often one account's usage can be read, and Claude Code's own panel
reads it too, every time you focus it. Right after a switch several of those
land at once. It clears by itself, usually within minutes; the meter keeps
showing the last good figures meanwhile, and the extension stops asking until
the server says it may, so clicking again does not make it worse.

**"The macOS login Keychain is locked"** · Unlock it (log out and back in, or
open Keychain Access) and try again. The extension refuses to guess while the
Keychain is locked, rather than switching to a stale login.

**macOS asks whether `security` may use a keychain item** · Choose **Always
Allow**. That is the system tool the extension uses to read and write the
login, the same one Claude Code itself uses.

**The account name has an orange background** · The live login isn't saved as a
profile. Click **Save it** on the Accounts page, or you will lose it the next
time you switch away.

**A pinned window says it is using the global account** · Its account has no
window login yet. Click **Sign In Now** on the message.

**`claude` not found** · The extension checks the usual install locations for
your platform (`AppData\Roaming\npm\...` on Windows; `~/.local/bin`,
`/opt/homebrew/bin`, `/usr/local/bin` elsewhere), then falls back to `where` /
`which`. Install Claude Code, or put it on `PATH`.

**Anything else** · Run **Claude Accounts: Show Status** and send the output
from the "Claude Account Switcher" output channel. It contains no token
material.

## Upgrading from an earlier version

The old command list is folded into the Accounts page. Renaming, icons, Remote
Control, sign-in-again and removing an account are now on each account's card.
Removed:

- **Backup / Restore.** A backup couldn't move an account to another laptop
  (the encryption is tied to the machine, and the refresh token inside it is
  replaced each time it is used). Add the account on the other laptop instead.
- **Per-window and machine-wide modes**, **Open New Window as Account**, **New
  Terminal as Account** and **New Chat as Account**. Folder pins replace them.
  A machine left in one of the old modes is put back on the switcher the first
  time the new version starts, and any machine-wide `CLAUDE_CONFIG_DIR` they
  set is cleared.

Your saved accounts, names, icons, pins and window logins carry over as they
are.

---

## For contributors

Two editions are built from this one source tree:

| | What it ships |
|---|---|
| **main** | The release: everything that is finished and works. |
| **experimental** | The release, plus whatever is being tried out before it ships. See [docs/experimental.md](docs/experimental.md). |

New features go into experimental first. Once they have been tested, they move
into the release by adding their command ids to `MAIN_COMMANDS` (or, for a
switch on the page, its name to `MAIN_FEATURES`) in [lib/edition.js](lib/edition.js). The two editions share an extension id, so
installing one replaces the other, so you can never end up with two status bars
fighting over the same account store.

```powershell
npm test              # 543 tests, no network, no touching your real ~/.claude
npm run stage         # build both editions into dist/ without packaging
npm run package       # both .vsix files into dist/
npm run package:main  # just the release
```

To develop, open this folder in VS Code and press `F5`. Running from source is
always the **experimental** edition. `test/edition.test.js` fails if the two
builds drift apart, and `test/page.test.js` holds the Accounts page to its
rules: no network, no unescaped text, and no transition longer than 250ms.
