# Installing Familiar

Familiar is pre-alpha. The builds are test builds, attached to draft releases for the team and not signed yet.
This page covers installing the desktop app, its first start, what it keeps where, and how to remove it.

## Windows

1. Run `Familiar_<version>_x64-setup.exe`.
2. Windows SmartScreen warns, because the installer is not signed yet (FAM-18). Choose "More info", then
   "Run anyway". Signing comes before the public alpha.
3. The installer installs for your user only and needs no administrator rights. The program goes to
   `%LOCALAPPDATA%\Familiar` (`Familiar.exe` and the core, `familiar-core.exe`). A newer build installs over an
   older one and keeps your settings.

## Linux

Two packages, built on Ubuntu 22.04 so they also run on older systems:

- Debian and Ubuntu: `sudo apt install ./Familiar_<version>_amd64.deb`.
- Anything else: `chmod +x Familiar_<version>_amd64.AppImage` and start it.

The tray icon needs a desktop with AppIndicator support. Linux desktops do not report clicks on the icon, so its
menu is the way in.

## First start

A new player gets the setup assistant: it finds WoW Forever (or you choose its `_forever_` folder), installs the
addon, and lets you choose the brain. Familiar starts when you finish or skip it. Settings from before the
desktop app count as set up already, and the assistant does not open.

Then start WoW, or type `/reload` if it runs. The addon only loads files that existed when WoW started: after a
first install, quit WoW completely and start it again.

## What Familiar keeps, and where

| What                                    | Windows                                                                                    | Linux                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Settings (`settings.json`)              | `%APPDATA%\Familiar`                                                                       | `~/.config/familiar` (or `$XDG_CONFIG_HOME/familiar`)                |
| Logs (`logs/familiar-<time>.jsonl`)     | `logs` next to the settings                                                                | `logs` next to the settings                                          |
| ChatGPT sign-in (`chatgpt.json`)        | next to the settings                                                                       | next to the settings                                                 |
| API keys, SSH passwords and passphrases | Windows Credential Manager                                                                 | the Secret Service (GNOME Keyring, KWallet)                          |
| Start with the system, when on          | a `Familiar` value under `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` | `~/.config/autostart/Familiar.desktop` (or under `$XDG_CONFIG_HOME`) |
| The addon                               | `Interface\AddOns` of your WoW Forever client                                              | `Interface/AddOns` of your WoW Forever client                        |

- **Settings:** keys you enter in the app never go into this file. An API key written into it by hand, or by
  an older version, stays there until the settings are next saved; then it moves into the keychain, if the
  system has one. The Settings page names such a key, and the app shows the file's path.
- **Logs:** they hold what Familiar did, including the text of your questions, the tools the brain used and how
  long it took. They never leave your PC. The Logs page shows them, and the Settings page opens their folder.
- **ChatGPT sign-in:** only your user can read the file. Signing out in the app removes the saved sign-in
  tokens; the file itself stays, with the account it was, until you delete the settings folder.
- **Keychain:** entries of the service `Familiar`, named `api-key/<provider>`, `ssh-password/<computer>` and
  `ssh-passphrase/<computer>`.
- **Start with the system:** off unless you turn it on, on the Settings page. On Windows, Familiar then starts in
  the tray without its window, and turning it off in Windows' "Startup apps" is respected: Familiar never turns
  it back on by itself. On Linux it starts with its window, because whether a tray icon can be shown is not
  known at login.
- **Addon:** the `Familiar` folder plus 256 small helper addons `Familiar_L000` to `Familiar_L255`, which carry
  the messages from the game to the core ([ADR 0005](adr/0005-transport-addons-txt-lane-and-font-bank.md)).

Nothing is sent anywhere except to the brain you chose (rule 6 in [AGENTS.md](../AGENTS.md)).

## Removing Familiar

1. **The addon.** On the Game page, choose "Uninstall addon…". This removes the addon and its helpers from the
   client. Quit WoW first: files in use cannot be removed.
2. **The program.**
   - Windows: Settings › Apps › Familiar › Uninstall.
   - Debian and Ubuntu: `sudo apt remove familiar`.
   - AppImage: delete the file.
3. **What stays.** Your settings, logs and ChatGPT sign-in stay in the settings folder, and your keys stay in
   the keychain, so a later install finds them again. To remove them too:
   - Delete the settings folder from the table above.
   - Remove the `Familiar` entries from the keychain: on Windows in the Credential Manager under "Windows
     Credentials"; on Linux in "Passwords and Keys" (Seahorse) or KWalletManager.
   - Turn off "Start with the system" on the Settings page before uninstalling, or delete the entry from the
     table above.
