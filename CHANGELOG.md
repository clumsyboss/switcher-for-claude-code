# Changelog

## 1.5.2

- **Auto-continue no longer acts on its own on a chat that stopped a while ago.** Only a chat it finds stopped within 10 minutes is switched for or continued without asking. A chat that has been stopped longer, found when you turn auto-continue on or change its settings, open a window or wake the PC, is asked about once, saying since when it has been stopped; when its limit has already reset, the offer is **Continue Here**, on the account it is on, not a switch. Before, two chats stopped hours earlier could be switched for and continued as soon as the settings changed.
- **The 5-hour limit is called the 5-hour limit.** Claude Code's notice "You've hit your 5-hour limit" was read as a model's weekly limit, so auto-continue said "weekly model limit" and could take the wrong reset time.
- **A wait to continue on another account no longer switches for nothing.** When its time comes, a chat that has carried on since (you continued it yourself, for example) is left alone, with no switch. And when the account you're on by then has room, the chat continues there instead of switching you away from it.
- **An automatic switch says why.** When auto-continue switches accounts it now says which chat it switched for and when that chat stopped, for example: Switched to Work to continue "Fix the build", which stopped at its 5-hour limit at 12:51 PM.
- **Every switch is noted with who asked for it** (the page, a notice, auto-continue, the early switch and so on) in the Switcher's log and in its record of switches, so a switch you didn't expect can be traced.

## 1.5.1

- **Tells you when a newer version is out.** Once a day the Switcher asks GitHub for its latest release and, when there's a newer one, says so at the top of the Accounts page and with a small mark in the status bar, with **Update**, **What's new** and **Later**. It sends nothing about you (GitHub sees your internet address and the time, as for any website); **Later** keeps one version quiet for 7 days; turn it off with the **Check for Updates** setting in each editor.
- **Says what's new after an update,** once, at the top of the Accounts page.

## 1.5.0

- **A list view for many accounts.** One line per account, with a labelled bar for each limit and an **Active** marker. Switch between cards and list on the page's tools line.
- **Search, filter and sort.** The tools line finds an account by name, email or organisation, filters the list, and sorts it by name, usage, reset time or your own order.
- **Groups by organisation.** Accounts can be grouped under their organisation; an organisation with a single account goes under **Others**.
- **Your own order.** Drag accounts into the order you want. The status bar's hover and the account pickers follow it too, and accounts added later go at the end.
- **The layout follows the page's width,** from a narrow sidebar to a wide tab.
- **Usage says how old it is,** so a figure from a while ago doesn't pass for a fresh one.
- **Extra usage** shows how much of the month's extra spending an account has used, and **use-it-or-lose-it** notes say when an account's limit resets with room left that would go to waste. Close a note and it stays closed until there's something new to say.
- **Near-limit colours.** Bars turn amber close to a limit and red at it.
- **"Has room again".** When an account you aren't using was at its 5-hour or weekly limit and that limit resets, the Switcher says so once, with **Switch**: on the Accounts page when it is open, otherwise as a VS Code notice in one window. Nothing is said when usage tracking is off.
- **Unpinning a chat asks first and reopens it,** as pinning does. Before, an open chat kept running on the pinned account's login until you reopened it by hand, while its usage showed under your active account. Now **Unpin and reopen** moves it back at once (a chat that is replying moves when the reply finishes); a tab is only closed when the Switcher is sure it is that chat. While a chat still runs on another account's pinning login, its usage counts on that account's card and for auto-continue, and the active account shows only its own figures, marked **(old)** when the Switcher couldn't read newer ones. The status bar still shows the active account's meter for a chat that was unpinned but hasn't been reopened yet.
- **Artifacts off now stops all publishing to claude.ai.** Off also blocks the Claude Docs connector and Claude Code's other tools that put things on claude.ai (sharing an onboarding guide, publishing a plugin, design sync, creating cloud routines). It adds deny rules to `~/.claude/settings.json` and later removes only the ones it added, also when the Switcher is uninstalled.
- **Uninstalling cleans up in other editors too.** Cursor, Windsurf, VSCodium and other editors built on VS Code get their wrapper setting removed as well. With the Switcher in two editors, the shared Claude Code settings are cleaned only when the last copy is uninstalled.
- **Pinning logins are no longer Beta.** The Beta tag is gone from the page and its dialogs.
- The **Show plan and organization** setting is gone: the page always shows them.

## 1.4.2

- **A pinned chat renewing its login no longer loses the account's pinning login.** Every few hours a pinned chat renews its login, which moves the login's end date by a few thousandths of a second. 1.4.0 and 1.4.1 took that for a new sign-in as your active account: the account lost its pinning login, its pinned chats started on the active account, and a warning offered to use the login for the active account or discard it. A renewal is now just a renewal: nothing is asked, and the pinning login keeps its pinned chats and folders going. The same goes for a renewal of your main login, and of a login that is waiting for your answer.
- **A pinning login set aside by that mistake can come back.** If one is still waiting for your answer, Switcher now recognises it in almost every case, and the question offers **Keep it as** the account's **pinning login** or **Discard it** instead of giving it to your active account. In the rare case it can't tell, it still asks the earlier question: if that names an account you didn't sign in as in that chat, choose **Discard it**.
- **Your active account's details stay right in Claude Code's settings.** A pinned chat's renewal can write some of the pinned account's details there; Switcher now puts the active account's back, as it already did after a `/login` in a pinned chat.
- **Auto-continue: a late Cancel no longer stops a chat that was already continued.** The "It will continue … at" notice can stay in VS Code's corner after the wait is over; tapping its **Cancel** then does nothing.
- **A new setting, Show login validity around each card** (in the page's settings menu, on by default). Turn it off to drop the thin line around each card that shows how long its login has left; the active account's card then gets a thin green line all the way round instead.

## 1.4.1

- **Keep alive works again,** and so do **▶** (start a 5-hour session) and auto-continue's note to a chat. Current Claude Code waits for typed input when it's started in the background, so each of these runs failed with a "no stdin data received" warning. They now tell Claude Code at once that no input is coming, and that warning is never reported as the error.
- **Accounts saved by 1.3 show their days left.** Their login's end date is read from their own saved login at startup, so their card gets its days-left line.
- **macOS:** a `/login` in Claude Code is noticed even when the Keychain doesn't say when the login changed.
- **A pinned chat that stops at its account's limit stays on that account.** Auto-continue saw only pinned folders, so a pinned chat at its limit could switch your active account for nothing, since the chat stays on its own account. Now it never switches the active account for it, and waits for that account's own reset ("It will continue … at 5:40 PM"). Moving a pinned chat to an account with room is planned for 1.5.
- **A pinned chat waiting to move** shows "Moves to … when this reply finishes" on a strip of its own under the chat's title, with **Reopen now** right after the words. In a narrow sidebar it no longer squeezes into a column beside the buttons.
- **For contributors:** the tests pass on a real Mac and on GitHub's Windows and macOS machines. They no longer depend on how fast the machine runs.

## 1.4.0

- **Sign in on the page.** **Add account** and **Sign in again** no longer open a terminal. The page shows the browser sign-in with a link, a copy button and a **Paste code** box, and **Cancel** stops it. A new account asks for a name (optional), colour and icon first, and the name can come from the email. Signing in as an account that's already saved renews it and says how many days it now has.
- **Pinning logins (Beta).** An account can have a second login of its own, used only by its pinned chats and folders, so they never sign out your other chats. After adding an account the page asks **Add a second login?**; **⋯ → Add account for pinning** adds one later. Words used throughout: **active account**, **main login**, **pinning login**.
- **Days left on every login.** Logins last about 30 days. The status bar shows them after the usage figures, such as `16d · pin 23d`, amber under 5 days and red once ended, and a thin line round each card shows the main login's time (grey until half its days are gone, then amber, then red), with the exact days in its hover. The old `Work (29D)` after the account's name is gone. Reminders come 3 days before a login ends and on its last day; **Not now** asks again a day later.
- **A quiet last-day swap.** When the main login is on its last day, the pinning login outlasts it, and nothing on either is in the middle of a reply, the two swap places, so pinning carries on. If the main login ends first, the pinning login takes over as main as soon as no chat on that account is replying, and the account then needs a new pinning login.
- **`/login` in Claude Code is picked up.** In an ordinary chat it renews a saved account by itself, and inside a pinned chat it renews that account's pinning login. A different account there is held: it stops being the pinning login at once, and the page asks whether to move it to its own account or discard it. The chats on it reopen first, each when its reply finishes, then the login is moved or discarded. If VS Code reloads before you answer, it asks again.
- **Plans by Anthropic's names:** Free, Pro, Max, Ultra and Team. Team seats show Team Max or Team Pro. Ultra is what logins still call Max 20x.
- **A new Accounts page.** Cards tinted with each account's colour, the plan as a badge with its own plant, softer corners, a soft blue glow on the active account, and a round blue pin button on every card with a count of what's pinned. Usage rows read **5h Session**, **Fable** and **Weekly**.
- **Pin a chat (Beta).** **Pin chat** gives one chat its own account, while the rest of the window follows your switches. A chat that's replying moves when the reply finishes, or at once with **Reopen now**, after a warning.
- **Pinned chats and folders use the account's pinning login,** not pin keys. They keep your usual settings, skills, plugins and MCP servers. Pin keys are no longer used.
- **Remote Control and Artifacts per account** also apply to pinned chats, but only to switch them off: an account can't turn them on where they're off everywhere else.
- **Upgrading from 1.3.** At the first start, each 1.3 window login that still works becomes that account's pinning login (if the account has none yet), and the old window folders are removed. Your own files from them (`CLAUDE.md`, skills, output styles, history and changed settings) are kept in backups. A window that is still open is left for a later start. This now also works when a plugin left read-only files in a window folder, and one folder that can't be removed no longer stops the others.
- **Compact view.** A button left of **Pin chat** tightens the page. Each card's top becomes one line: a smaller picture, with the email moved into the name's tooltip. The usage bars and the toggles sit closer, and the padding is smaller. Text stays the same size. The change animates, or switches at once if reduced motion is on. The choice is remembered.
- **A narrow sidebar** shortens the Pin buttons to **Chat** and **Folder**, then Beta to **B**, before anything wraps. Screen readers still hear the whole name.
- **"Account added for pinning!" ends with Done,** which just closes it. Pin from the card or the Pin buttons. Closing a pop-up with ✕ or Escape keeps its box as you left it.
- **Pinning a chat that has no title yet** uses the name its tab shows, which is your latest message. So **Pin and reopen** finds the chat and reopens it, and if two open chats share that name, neither is closed and a notice asks you to reopen the right one yourself.
- **Known limits of pinning.** In a pinned chat, `/status` and the chat itself name the **active** account, because they read the shared Claude Code settings. Requests use the pinned account's login, so usage and limits count there. MCP servers set up in Claude Code are in every chat, and their sign-ins are kept with each login, so a pinned chat may ask you to sign in to a server once. Remote Control and Artifacts follow the active account where it has them off; per-account control in pinned chats is planned for 1.5.
- **Pinning a folder no longer needs a reload.** New chats use the pinned account at once, in every window on that folder.
- **Check everything.** **⚙ → Check everything** looks over every login, the pin wrapper and every pin, with a fix button for each problem. A fresh install also gets a three-step first-run checklist.
- **Forget account removes everything it had.** It also removes the account's pinning login and unpins its chats and folders.
- **Uninstalling cleans up.** The switcher's wrapper setting is removed from VS Code's settings when the extension is uninstalled.
- **macOS:** pinning logins use the Keychain, one item each.
- **No more VS Code pop-ups.** Questions open in the Accounts page, and notices show there while it's open, in VS Code's corner otherwise. Lists and text boxes no longer use VS Code's top bar.
- **A heads-up before changing organization.** Switching to an account in another organization asks first, since chats that continue there can't reuse Claude's earlier thinking or cache. You can turn the question off.
- **Settings on the page.** The ⚙ menu chooses what cards show (colour tint, chat context, plan, the Remote Control and Artifacts switches), what the status bar shows, and more. Each is also a VS Code setting.
- **A welcome and a short tour** for new installs, and **What's new** after an update. Take the tour again any time from the ⚙ menu.
- **The Accounts tab stays open** when the window reloads.
- **A new icon** for the Marketplace, the sidebar and the Accounts tab.

## 1.3.1

- **Each account's plan** shows next to its email: Max 20x, Team 5x, Pro and so on.
- **Plans with no 5-hour limit** show Fable and weekly instead. The card has a Fable bar where the 5-hour bar was, the status bar shows two figures (Fable, then weekly), and **▶** and **Keep alive** are hidden, since there's no 5-hour window to start.
- **Renaming an account moves it.** Accounts are listed in the order of the names you see, ignoring case.
- **Works with only the Claude Code extension installed.** Without a separate install of Claude Code's command-line tool, the copy inside the Claude Code extension is used, so signing in and starting sessions work.

## 1.3.0

- **Auto-continue after limits.** A new section on the Accounts page reads as one sentence: "When a chat hits its limit, [what to do] using [which account]". Be asked from a notification, wait for the limit to reset and continue, switch to another account and continue, or do nothing. The stopped chat picks up by itself, live in the panel.
- **Switch early,** at 50 to 90% of the 5-hour limit, before anything stops. The weekly limit triggers it at 95%.
- **Keep alive.** **⋯ → Keep alive** starts an account's next 5-hour window as soon as the last one ends.
- **Usage every 2 minutes** for the live account, straight from Anthropic. Every open window shares that one reading.
- **Accounts move between PCs, both ways.** **⋯ → Move to another PC…** seals an account's login into a passphrase-protected file, and **Add account → Import from a move file** brings it in on the other PC.
- **No reload after a switch.** Open chats use the new account from their next message.
- The context dots no longer show a chat as compacting when it's only busy close to its limit.
- **New extension id,** `clumsyboss.account-switcher-claude-code`, for the VS Code Marketplace. An older copy installed under the old id is offered for removal.

## 1.2.0

- **See how full your chats are.** A row of dots shows how much of this window's chat context is used, and each account's card shows its most recent chat as a faint grid.
- **Start a 5-hour session early** with the **▶** on an account's card, without switching to it.
- **A login for another PC.** **⋯ → Make a login for another PC…** seals a separate login into a passphrase-protected file.
- **Safer switching.** A switch never saves one account's login under another's name, stops before changing anything when it can't read what it needs, and puts the previous login back if it fails part-way.
- `registry.json` is never written over while it has an error, and windows working at the same time no longer lose each other's changes.
- Files keep their permissions and links, and the macOS Keychain is handled more carefully.

## 1.1.0

The first public release.

- **The Claude Accounts page**, as an editor tab or in its own sidebar view: every saved account with its 5-hour and weekly use, one-click switching, and a name, colour and icon for each.
- **Usage in the status bar,** with every account's limits in its hover.
- **Folder pins:** a folder can have its own account, while every window shares the same chat history.
- **Remote Control and Artifacts per account.**
- **Figures that stay live:** saved logins are renewed quietly in the background.
