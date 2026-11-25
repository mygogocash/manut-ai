---
name: computer-use
description: >-
  Looks at and works the windows of the apps on this Mac through Manut AI's computer use tools
  (mcp__manut-computer__*): an app window's accessibility tree, a picture of it, clicks, typing into
  a field, key presses and menu items. Prefer a programmatic path (a command, a file, an API, an
  existing CLI) whenever it can do the task; use this only when an app's window is the only way.
  Every action asks the person first on a card in the chat and runs once.
---

# Manut AI computer use

Adapted from Orca's `orca-computer-use` skill (stablyai/orca, MIT). Use these tools to look at and work a window of
an app on this Mac when the person asked for something only that window can do. Prefer a programmatic path (shell,
files, git, HTTP, an existing CLI) whenever it can complete the task.

## The person decides

- Looking at an app asks the person the first time in each chat ("Let the agent look at TextEdit in this chat?").
  After their yes you may look at that app again in this chat without asking.
- Every action (`click`, `set_value`, `press_key`, `choose_menu_item`) shows the person a card that says exactly what
  will happen and where, and runs only after their Allow once, once. One call is one action: there is no way to send
  several under one yes, so do not try to combine them.
- If the person says no, the action did not happen. Do not ask for the same action again unless they ask you to.
- Do not send messages, submit forms, buy, pay, delete, post or change settings unless the person asked for exactly
  that. If an app shows private things, read only what the task needs.
- Some places are never reachable: Manut AI's own windows, System Settings, Keychain Access and Passwords, the Mac's
  password, Touch ID and permission prompts, the lock screen, and what any password field holds. Nothing works while
  the screen is locked. Do not try to get round any of this; tell the person what you could not do.

## Core loop: look, act, look

```text
list_windows {}
get_app_state {"app": "com.apple.TextEdit"}
click {"app": "com.apple.TextEdit", "element_index": 12}
get_app_state {"app": "com.apple.TextEdit"}
```

- `list_windows` lists the apps with windows (by name and bundle identifier). Window titles show only for apps the
  person let this chat look at.
- `get_app_state` reads one window (the frontmost unless you pass `window`, its number from `list_windows`) as a tree
  of numbered elements: `[12] button “Save”`, `[3] text field “Name”: Mint`, `(disabled)` when it cannot be used.
  Pass `"picture": true` to also get a picture of the window when the tree is not enough (needs Screen capture on).
- Element numbers belong to the latest `get_app_state` of that app. They go stale after any change: a click, typing,
  navigation, a new window or the app re-drawing. After every action, call `get_app_state` again before choosing the
  next number. Never guess a number.
- A tree is cut at 400 elements; the last line says so.

## Actions

```text
click {"app": "TextEdit", "element_index": 12}
set_value {"app": "TextEdit", "element_index": 3, "value": "Mint Shop"}
press_key {"app": "TextEdit", "key": "Return"}
press_key {"app": "TextEdit", "key": "Cmd+S"}
choose_menu_item {"app": "TextEdit", "menu": ["File", "Save…"]}
```

- Prefer `set_value` for a text field and `click` for a button, check box or tab: they act on the element itself.
- `set_value` puts the text in place of everything the field holds, and reads it back. For an empty field the
  person's card says "Type into"; for one that holds anything it says "Replace everything in" the field, with how many
  characters it holds. To add to what a field holds, pass the whole new text. The result says whether the field now
  holds exactly that text; if not, look before going on rather than typing again. If the field's text changed after
  the person's yes, nothing is typed: look again and ask again.
- `press_key` sends one key with its modifiers to the app's focused window: Return, Tab, Escape, the arrows, Home, End,
  Page Up, Page Down, Delete, letters, digits and punctuation. Shortcuts that quit the app (Cmd+Q), log out, lock the
  screen, open Force Quit or empty the Trash are never sent: reach the goal another way, such as the window's own
  button or menu item.
- `choose_menu_item` takes the path of titles from the menu bar down, exactly as the menus show them. Never the Apple
  menu.
- An action's result says what was done. If it says nothing was done (the control changed or went, a different window
  came to the front, the app quit), look again and, if the task still needs it, ask again.

## Browsers

For Safari, Chrome and similar, set the address field with `set_value`, then `press_key` Return. Do not assume typing
went to the address bar. Web pages' text fields may not take the text the way native ones do: check with
`get_app_state` after each field.

## When something fails

- "No running app with a window is called ...": call `list_windows` and use the bundle identifier it gives.
- "has not let this chat look at": the person said no, or a rule in their settings skipped the card. Ask them.
- "Manut AI has no yes from the person for this action": the action did not run. Ask for it again only if the person
  wants it.
- "never looks at or works": the target is off limits. Stop and tell the person.
- "locked": wait for the person to unlock the Mac.
- "Accessibility" or "Screen capture" is off: the person turns them on in Manut AI's Settings › Computer.
