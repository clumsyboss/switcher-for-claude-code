# Changelog

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
