# Computer use

Item 82, the owner's "also support this feature as well" (25 Nov 2026, with a screenshot of Orca's Computer Use page).
The person's agent can look at and work the windows of any app on this Mac when asked. Settings › Computer shows
whether macOS has given Manut AI Accessibility and screen capture, opens the right pane of System Settings for each and
says when all is ready. Every action that changes something asks first, on the chat's own card, and runs once.

Code: `apps/desktop/src-tauri/src/computer/` (`mod.rs` the page's two commands, `room.rs` every rule, `mac.rs` the Mac,
`mcp.rs` the MCP server, `hub.rs` the socket and the files handed to Claude Code, `tap.rs` the card, `keys.rs` key
presses, `snap.rs` the snapshot key of item 104, `SKILL.md` the skill), `apps/desktop/src/computer/computer.ts`,
`apps/desktop/src/settings/ComputerPage.tsx` and `apps/desktop/src/chat/cards/computerCard.ts`; for the snapshot,
`apps/desktop/src/computer/snapshot.ts`, `SnapshotNotice.tsx` and `apps/desktop/src/settings/SnapshotRows.tsx`.

## What a person sees

- **Settings › Computer.** One line: ready, or what is missing ("Not ready: turn on Accessibility and Screen capture",
  "Almost ready: ... Turn on Screen capture so it can also see pictures of them"), with Re-check. Accessibility and
  Screen capture, each Allowed or Off, one line on what it is for and an Open button for its pane of System Settings ›
  Privacy & Security. What the agent may look at and do, and what never. For a copy not signed with a Developer ID (0.1.1),
  that macOS forgets both permissions after each update. The page reads again when the window comes back to the front.
  In a browser, and on Windows and Linux, it says computer use is on the Mac only for now.
- **In a chat** (Buddy's, and Kit's chat through Claude Code), once Accessibility is on: asked to do something in an
  app, the agent lists the apps, and its first look at an app is a card ("Let your agent look at TextEdit in this
  chat?"). After Allow once it reads that app's windows freely in this chat. Each click, typing, key press or menu choice
  is a card in the person's language that names the app, the window, the control and the exact text, keys or menu
  item, with No and Allow once only. A click or typing card also says that the control's name is the one the app gives
  it (a web page names its own controls) and, with Screen capture on, shows a small picture of the control as it is at
  the ask.

## What the platform gives

Checked on 25 Nov 2026 on this Mac (macOS 27.2, Apple silicon) against Apple's documentation, the macOS 26 SDK's
headers and the Mac's own files. Nothing was read from another app's window, no permission was asked and no prompt shown.

| What | Fact | Source |
| --- | --- | --- |
| Accessibility, read | `AXIsProcessTrusted()` "Returns whether the current process is a trusted accessibility client"; only `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt` informs the user | [AXIsProcessTrusted](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted), `HIServices/AXUIElement.h` |
| Screen capture, read | `CGPreflightScreenCaptureAccess()` "Returns whether the current process already has permission to capture the contents of the screen, without prompting the user"; `CGRequestScreenCaptureAccess` is the one that prompts | [CGPreflightScreenCaptureAccess](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()), `CoreGraphics/CGWindow.h` |
| The two panes | `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` and `?Privacy_ScreenCapture`. Apple publishes no list of these addresses; they are the ones Orca opens | Orca `main.swift` (`openAccessibilitySettings`, `openScreenRecordingSettings`), `src/main/ipc/developer-permissions` |
| The panes' names on this Mac | Privacy & Security lists Accessibility as "Device Control and Data Access" (ja デバイスの制御とデータへのアクセス, ko 기기 제어 및 데이터 접근, zh 设备控制和数据访问) and screen capture as "Screen & System Audio Recording" | `SecurityPrivacyExtension.appex/.../Localizable.loctable` (`ACCESSIBILITY`, `SCREENANDAUDIOCAPTURE`), TCC.framework's `Localizable.loctable` |
| Usage lines | Apple's list of protected-resource `Info.plist` keys has none for Accessibility or screen capture (Orca's helper sets `NSAccessibilityUsageDescription` and `NSScreenCaptureUsageDescription`, which Apple does not document) | [Protected resources](https://developer.apple.com/documentation/bundleresources/protected-resources) |
| Entitlements | The hardened runtime's resource-access entitlements are audio input, camera, location, address book, calendars, photos and Apple Events: none for either | [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime) |
| A grant and the signature | macOS records a grant against the code's designated requirement; an ad hoc signature's is tied to that very build, so each update is asked again; a Developer ID build keeps the grant | [TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) (as for voice, `docs/voice.md`) |
| Signed or not, read | The requirement `anchor apple generic` holds only for code signed by a certificate Apple issued (Developer ID, App Store) | `SecCodeCheckValidity` through `security-framework` 3.7's `SecCode::for_self` |
| Locked | `CGSessionCopyCurrentDictionary()`; `kCGSSessionOnConsoleKey` false is another session in front; the undocumented `CGSSessionScreenIsLocked` is the lock and sleep (Orca's check). No dictionary counts as locked here | `CoreGraphics/CGSession.h`, Orca `SessionLockProbe.swift` |
| Windows, trees, actions | `AXUIElementCreateApplication`, `AXUIElementCopyAttributeValue` (`AXWindows`, `AXChildren`, `AXRole`, `AXSubrole`, `AXTitle`, `AXDescription`, `AXPlaceholderValue`, `AXValue`, `AXEnabled`, `AXFocusedWindow`, `AXMenuBar`), `AXUIElementPerformAction` (`AXPress`), `AXUIElementSetAttributeValue` (`AXValue`), a password field's role `AXSecureTextField`; `CGEventCreateKeyboardEvent`, `CGEventSetFlags`, `CGEventPostToPid`; key codes from `HIToolbox/Events.h` | the SDK's headers |
| Pictures | `CGWindowListCreateImage` with the window alone, its frame left out, one pixel a point, made a PNG by ImageIO; deprecated for ScreenCaptureKit and still Orca's default engine | `CGWindow.h`, Orca `main.swift` `captureImage` |
| Sensitive apps | Bundle identifiers read from this Mac's own `Info.plist` files: System Settings `com.apple.systempreferences`, Keychain Access `com.apple.keychainaccess`, Passwords `com.apple.Passwords`, the login window, SecurityAgent, Touch ID's prompt, TCC's prompt service, the Accessibility prompt and the others in `room.rs` `REFUSED` | `/System/...` |
| A program's bundle identifier | `NSRunningApplication`'s `runningApplicationWithProcessIdentifier:` and `bundleIdentifier` ("the `CFBundleIdentifier` of the application, or nil if the application does not have an `Info.plist`"); it tracks "only user applications", so the `Info.plist` of the bundle a program runs from (`<name>.<kind>/Contents/MacOS/`) is read when it has none. SecurityAgent runs from `SecurityAgent.bundle` (`com.apple.SecurityAgent`) and the Touch ID and password prompt from `coreautha.bundle` (`com.apple.LocalAuthentication.UIAgent`) | AppKit's `NSRunningApplication.h`, the two bundles' `Info.plist` on this Mac |
| Who a program runs as | `proc_pidinfo` with `PROC_PIDTBSDINFO`: `pbi_uid` and `pbi_ruid` | `sys/proc_info.h`, `libproc.h` |
| Keyboard layouts | `TISCopyCurrentKeyboardLayoutInputSource`, `TISCreateInputSourceList`, `kTISPropertyUnicodeKeyLayoutData` ("refers to the 'uchr' keyboard layout data"), "you must call TextInputSources API on the main thread"; `UCKeyTranslate` with `LMGetKbdType`, `kUCKeyActionDown`, `kUCKeyTranslateNoDeadKeysMask`, modifier state "((EventRecord.modifiers) >> 8) & 0xFF" (`cmdKey` = 1 << 8) | `HIToolbox/TextInputSources.h`, `HIToolbox/Events.h`, `CarbonCore/UnicodeUtilities.h` |
| Where keys go, what a page is | `AXFocusedUIElement` and `AXFocusedWindow`; `AXURL` ("A CFURLRef ... Required for elements that represent a disk or network item") and `AXDocument` | `HIServices/AXAttributeConstants.h` |

## What was lifted from Orca

Orca (`stablyai/orca`, MIT, at `a634526a`): a skill tells the agent to call `orca computer <command>`, a CLI that reaches
Orca's runtime, which drives a signed Swift helper app with its own two permissions. Manut AI keeps the command surface
and the guidance and does the native part in its own process, so the permissions are Manut AI's:

- The six commands, as MCP tools: `list_windows`, `get_app_state` (the tree of numbered elements, and the picture),
  `click`, `set_value`, `press_key`, `choose_menu_item`.
- The skill (`computer/SKILL.md`), adapted from `skill-guides/orca-computer-use.md`: prefer a programmatic path, look,
  act, look again, element numbers go stale, the shortcuts never sent, what to do on each error.
- The refused shortcuts (Cmd+Q, Cmd+Shift+Q, Ctrl+Cmd+Q, Cmd+Option+Escape, Cmd+Shift+Delete) and their spelling
  (`computer-blocked-key-combos.ts`), without Orca's `--allow-system-shortcut`.
- The lock check, the window number (`_AXUIElementGetWindow` looked up at run time), the picture's options, which
  windows count (normal level, 48 points each way, not see-through), and the two pane addresses.

Written here: the MCP server (`mcp.rs`, MCP revision 2025-06-18), the socket and the per-chat rooms (`hub.rs`), every
rule of what may be looked at and done (`room.rs`), the card (`tap.rs`), the Settings page and the card's words.

## How it reaches the agent

A Claude Code chat that starts while Accessibility is on is given `--mcp-config '<JSON>'` (the server's configuration as
a string: Claude Code's `--mcp-config` takes "JSON files or strings", and 2.1.332 parses each value as JSON before it
tries it as a file) and `--plugin-dir ~/.manut/computer/plugin` (the skill, for that session only; nothing is written in
the person's Claude Code folders). The configuration starts this same program as `manut --computer-mcp`, which relays
each call over the socket `~/.manut/computer/app-<pid>.sock` (in a 0700 folder) with the chat's token. The shell does
the looking and acting, so a server started any other way, or for a chat that ended, can do nothing.

### Who may call (security review, 25 Nov 2026)

Until then a chat's token was written to `~/.manut/computer/chats/<token>.json`, and the socket served any connection
that held a live token. Every program running as the person could read that file (a repository's dev script, another
chat's agent through its shell tool, a terminal session) and connect with it: it could read the windows of every app the
person had let that chat look at, without a card and through Manut AI's Accessibility and Screen capture grants, so
macOS never asked, and it could spend a yes the person gave for that chat's own call. Now (`hub.rs`, tests
`only_the_server_claude_code_started_for_the_chat_is_served`, `a_program_the_chat_did_not_start_is_refused_even_with_its_token`):

- No file holds a token. The token is still in Claude Code's arguments and its server's environment, which any program
  of the same user can read from the process list; so it only names the chat, and it opens nothing by itself.
- The shell names the process it started for the chat once it runs (`agent_chat.rs` `bind_computer`), and a call is
  served only when the kernel says the program at the other end of the connection (`LOCAL_PEERPID` and
  `LOCAL_PEERTOKEN` from `sys/un.h`) has that process among its parents (`proc_pidinfo`, at most 16 steps up) and runs
  Manut AI's own program (`proc_pidpath_audittoken` from `libproc.h`, read before and after the walk). Before the
  process is named, nothing is served.
- Parents, not "the parent": a `claude` on the person's `PATH` can be a wrapper that stays Claude Code's parent instead
  of replacing itself (one on this Mac does), and then the process the shell started is the server's grandparent.
- The first caller holds the room (item 89, security review of 26 Nov 2026; `hub.rs` `holds_room`, test
  `a_chats_room_answers_only_its_first_caller_while_that_caller_lives`). A program the chat's own Claude Code starts (a
  hook in the person's own `~/.claude/settings.json`, which another program of theirs may have written) passes both
  checks above once it runs Manut AI's program with the token. So the first caller that reaches a chat's room is pinned by
  the pid and audit token the kernel reported, and every other caller for that chat is refused ("answers only the first
  server that reached this chat") while that first one lives, which the kernel says by its token still naming a running
  process. Once it has ended or run another program (Claude Code starting its server again), the next caller that passes
  the checks takes its place. A new chat starts with an empty room.
- What is still let in: a program under that chat's own Claude Code that calls before the chat's server first does, or
  after the server ended. It reaches only that chat's room: the apps the person let that chat look at and the yeses they
  gave on that chat's cards, each for exactly one call, and the chat's own server is then the one refused. A project's own
  files can no longer add such a hook (chats start with `--setting-sources user`, see docs/code-editor.md, "What a
  project's own files cannot do"). Another chat, a terminal or anything started outside the chat is refused whatever it
  holds.
- Checked on this Mac with the real kernel (`the_kernel_names_the_caller_and_a_token_read_before_an_exec_names_nothing`):
  the peer's process and parent read right, and the kernel gives a peer's audit token as the process is when asked, so
  a token read before an exec names nothing after it. Starting Claude Code for real is a step for the owner (below).

## The bounds, and their tests

Reads (`room.rs` tests unless named):

- Only apps the person allowed in this chat: the first look at an app is a card, and the yes lasts until the chat ends
  (`a_look_at_an_app_asks_once_per_chat_and_reads_only_what_was_allowed`). Listing shows other apps by name only, never
  their windows' titles (`listing_is_free_and_shows_window_titles_only_for_apps_allowed_in_this_chat`).
- Never what a password field holds: the Mac code reads a control's role before its value and never asks a secure
  field's value, and the room drops one again (`a_password_field_is_never_read_typed_into_or_clicked`).
- Never Manut AI's own windows (so an agent cannot read or press its own asks), System Settings, Keychain Access,
  Passwords or the prompts (`manut_ai_system_settings_and_the_keychain_are_refused_before_any_card`; in the chat,
  `tap.rs` `a_refused_target_is_denied_with_its_reason_and_never_shown_as_a_card`).
- Manut AI's own asks wherever they show (second security review, 26 Nov 2026). Only this process and its bundle
  identifier were refused, so the web pages that answer an ask (approve a reply, delete the shop's data, join a shop,
  the owner's web app) could be looked at and pressed in an allowed browser, and so could another copy of Manut AI.
  Now (`own_window`, `own_address`, `own_program` in `room.rs`):
  - Another copy of Manut AI is its own windows: a bundle identifier under `xyz.manut.`, a name that is Manut AI's, or
    the program `manut`, as a build that is not a bundle runs it.
  - A window is refused, for a look and for every action, when a page it shows is one of Manut AI's: any page of its
    host (`manut.xyz` and its subdomains, `WEB_ORIGIN`), or a link page (`/approve/`, `/delete/`, `/join/` with a token)
    on any host, read from the window's document (`AXDocument`) and the page of each web area the control is in
    (`AXURL`, read up its parents). The pages forbid framing (`frame-ancestors 'none'`), so a page inside another
    site's page is not a way in.
  - For a browser that gives no address, by the titles those pages set (`apps/web/src/*/strings.ts` `documentTitle`
    and the desktop's `index.html`, which a test reads, so a renamed page is not missed): any window whose title holds
    "Manut AI", "Approve a reply", "Delete your shop's data" or "Join a shop" is refused.
  - A click or typing is checked in the control's window at the ask and again at the run, a key press and a menu item
    in the window that has the keyboard, so a yes given while a tab showed a shop is not used once it shows an approval
    page (`manut_ais_own_windows_and_pages_are_refused_wherever_they_show`, `manut_ais_own_pages_are_known_by_their_address`,
    `every_title_manut_ais_own_pages_set_is_known`).
  - A link that answers an ask by itself approves for whoever opens it, so its token is taken out of every name, value
    and title an agent reads, in any app (`/approve/…`, `an_approval_link_is_never_read_out`). Since the third review
    (26 Nov 2026) each word is read decoded first, since an agent decodes as easily as a browser: percent-encoding in
    either case and nested up to eight times (a redirect's or a tracking link's address), HTML character references
    (`&#47;`, `&#x2F;`, `&sol;`), JSON and script escapes (`\/`, `\u002F`, `\x2f`), a backslash for a slash, a doubled
    slash before the token, and the token itself encoded. A word still encoded after eight rounds is hidden whole. A
    window's address is read decoded the same way (`%61pprove`, `d%65v.manut.xyz`), and one still encoded after eight
    rounds counts as Manut AI's own (`an_encoded_approval_link_is_never_read_out`). Not covered: a link split by
    a line break or spaces, spelled out in words, or shown as a picture.
  - What remains: a browser that gives neither the page's address nor its title; a picture of a window can still show a
    link; and Chromium's `AXURL` on its web areas is read but was not checked against a real Chrome here (a step for
    the owner below).
- The prompts that are not `.app`s (security review, 25 Nov 2026). The bundle identifier used to be read only for a
  program under `.app/Contents/MacOS/`, so SecurityAgent (`SecurityAgent.bundle`) and the Touch ID and password prompt
  (`coreautha.bundle`) read as having none and missed the list. Now it is the system's own (`NSRunningApplication`),
  else the `Info.plist` of any kind of bundle (`mac.rs` `a_prompt_in_any_kind_of_bundle_reads_its_bundle_identifier`),
  and besides the list, any window of a program that does not run as this person, and of one with no bundle identifier
  that is under `/System/` or whose program cannot be read, is refused
  (`macos_prompts_are_refused_whatever_kind_of_bundle_they_are`).
- macOS's helpers, by where they run (second security review, 26 Nov 2026). SecurityAgentHelper (the XPC service in
  `SecurityAgent.bundle` that draws its password sheet, `com.apple.SecurityAgentHelper.arm64`) and
  LocalAuthenticationRemoteService (the Touch ID and password sheet, an XPC service of `LocalAuthenticationUI.framework`)
  run as the person, have bundle identifiers and live under `/System/`, so the rule above let them in. Now any program
  of macOS (under `/System/`, `/usr/` but not `/usr/local/`, `/bin/`, `/sbin/` or `/Library/Apple/`) is let in only
  when it is an app a person opens: an `.app` right in `/System/Applications/`, its `Utilities/`, Safari's app cryptex,
  `/System/Library/CoreServices/Applications/`, or the Finder. Every other kind (XPC services, `.bundle`s, `.appex`es,
  apps nested in frameworks or in other apps, macOS's own agents and alerts such as Notification Center and Control
  Center, programs in `/usr/libexec/`) is refused whatever it is called, and so is a program whose path cannot be read,
  even with a bundle identifier. The two helpers are named in `REFUSED` too
  (`macos_helpers_that_are_not_apps_a_person_opens_are_refused_by_where_they_run`). On this Mac, UserNotificationCenter
  and AuthorizationPromptService declare no agent key in their `Info.plist`, so a rule on agents alone would have missed
  them: that is why the rule names where apps are, not what a helper is.
- At most 400 elements and 30 levels a look; a picture only with Screen capture
  (`a_picture_comes_only_with_screen_capture`).

Writes:

- Every action is a card in the app's words with the exact text, keys or menu item, offering No and Allow once only,
  never "for this session" (`tap.rs` `an_action_is_a_card_in_the_apps_words_and_allow_once_is_its_one_yes`,
  `computer.test.tsx`). Kit's dial never decides one (`ask.test.ts`).
- One yes, one action, for exactly that call, within two minutes; nothing runs without a yes, even when the person's
  own Claude Code rules let the tool run unasked (`each_action_runs_once_after_its_own_yes_and_never_without_one`,
  `tap.rs` `a_no_or_a_withdrawn_ask_leaves_no_yes`). No tool takes a list of actions (`mcp.rs`
  `lists_six_tools_and_none_takes_a_batch`).
- The action touches the very control the card named, checked again: changed, gone, the app quit, or another window in
  front, and nothing is done (`an_action_touches_only_the_control_the_card_named`,
  `a_key_is_pressed_in_the_window_the_card_named_and_never_a_blocked_shortcut`).
- A card's words are the app's own, made safe to read (security review, 25 Nov 2026). Before, a control's name on the
  card was its accessibility label, which a web page in an allowed browser sets itself, and the check just before acting
  compared only the role and that label, which the page can keep while it changes what the control does; and Unicode's
  invisible format characters were kept, so a right-to-left override could make a card read otherwise than what was
  typed or pressed. Now:
  - Every name, title and value shown or compared is stripped of Unicode's format characters (general category Cf, the
    bidi isolates among them; Unicode 18.0's list in `room.rs` `FORMAT`), and text to type or a menu path that holds
    any is refused, so the person reads exactly what is typed (`invisible_format_characters_are_never_shown_and_never_typed`;
    the page strips them again, `computer.test.ts`). An emoji joined with a zero-width joiner, and Persian text with a
    zero-width non-joiner, are refused too; Thai types as written.
  - The card says, in the person's language, that the control's name is the one the app gives it.
  - The control is read again at the moment of the ask, and the yes is bound to its window's number, its place in that
    window's tree and its position and size on screen (`Place`): a control that moved, changed place or window since
    the ask is refused and the agent asks again (`a_yes_is_bound_to_where_the_control_was_at_the_ask`). A page that keeps
    all of these and changes only what a click does is not seen; that is why the card says whose name it is.
  - With Screen capture, the card shows a picture of just that part of the window (`CGWindowListCreateImage` with the
    control's frame), for a control up to 640 by 320 points and 256 KB; a larger one, such as a document's text area,
    has none (`a_card_shows_a_small_picture_of_the_control_with_screen_capture`, `computer.test.tsx`).
- A key is the character it types, on any keyboard (second security review, 26 Nov 2026). Keys were sent by their
  place on a US keyboard (`kVK_ANSI_*`), so on a French (AZERTY) Mac a card that said Cmd+A sent the key that types Q
  there and quit the app, past the blocked shortcuts, and Cmd+X on Dvorak did the same. Now (`keys.rs`, `Chord::code`):
  - Return, Tab, Space, the two deletes, Escape, the arrows, Home, End, Page Up and Page Down keep their codes
    (`Events.h`: "keycodes for keys that are independent of keyboard layout").
  - A letter, digit or punctuation mark is sent by the key that types it on the layout in use
    (`TISCopyCurrentKeyboardLayoutInputSource`, its `kTISPropertyUnicodeKeyLayoutData`, `UCKeyTranslate`), read with
    Command held for a chord with Command: Thai and Russian type QWERTY letters then, which their shortcuts go by.
  - That key is checked against every keyboard layout the person has turned on (`TISCreateInputSourceList`), alone and
    with Command. If any reads it as a shortcut that is never sent, it is refused, naming the layout and what it would
    do: French with ABC turned on reads Cmd+A's key as Cmd+Q, and "Dvorak - QWERTY Command" types Q alone where it
    types X with Command.
  - A character no key types on the layout in use (Cmd+1 on French, a letter alone on Thai) is refused in plain words.
  - The layout is read again just before the key is sent; a layout changed since the yes sends nothing.
  - TextInputSources must be called on the main thread of an app (its header), so the desk reads it there and waits at
    most two seconds; no answer refuses.
  - The tests' layouts (U.S., French, Dvorak, Dvorak - QWERTY Command, Thai) are this Mac's own, read again through the
    same calls (`mac.rs` `the_stand_in_layouts_are_the_ones_this_mac_reads`), and every chord on each of them, with each
    other turned on beside it, is checked (`no_layout_turns_a_chord_into_a_blocked_shortcut`,
    `a_key_is_sent_by_the_key_that_types_it_on_the_layout_in_use`).
  - What remains: macOS can keep a layout per document, and an app typing with another layout turned on than the one
    in use could get another letter than the card's; none of those layouts can turn it into a blocked shortcut.
- A key press is bound to where the keys go (second security review, 26 Nov 2026). It was bound only to the focused
  window's title, and not at all when that title was empty, so a key allowed for one "Untitled" document could land in
  another. Now the ask reads where the app's keys go (`AXFocusedWindow`, `AXFocusedUIElement`): the window's number
  (`_AXUIElementGetWindow`) and title, and the focused control's role, name and place (`Place`, as a click's). The card
  names the window and that control ("Control: text field “Name”"), and the yes holds only while all of them hold: a
  different window (even with the same title or none), the keyboard in another control, or the control moved, and the
  key is not pressed. When the window that has the keyboard cannot be told (no number, or the focused control is in
  another window than the one macOS says has the keyboard), nothing is asked and nothing is sent. A key press into a
  password field is refused like typing into one
  (`a_key_goes_only_to_the_window_that_had_the_keyboard_at_the_ask`).
- Typing says what it replaces (security review, 26 Nov 2026). The Mac puts typed text in place of a field's whole value
  (`AXUIElementSetAttributeValue` with `AXValue`), so a card that read "Type into the text area: Thanks!" turned a page
  of text into "Thanks!". Now what the field holds is read at the ask, as the Mac gives it:
  - An empty field is typed into: "Type into <field> in <app>?".
  - A field that holds anything (a space, an invisible character and a number count) is a different, stronger card:
    "Replace everything in <field> (N characters) in <app>?", with "Replace with: <text>".
  - The yes is bound to exactly what the field held at the ask. If it holds anything else when the action runs (filled
    since a yes to type, or changed since a yes to replace), nothing is typed and the agent asks again, so a yes to type
    never covers replacing (`typing_into_a_field_that_holds_text_says_it_replaces_everything`; the page draws a replace
    card only with its count, `computer.test.ts`, `computerCard.test.ts`).
  - A field whose content cannot be read is not asked about, since the card could not say what typing replaces.
  - Inserting at the caret was not taken. Orca's `type-text` (at `a634526a`, `TextInput.replaceSelection`) reads the
    field's whole value and its `AXSelectedTextRange`, splices the text in and writes the whole value back, skipping
    Chromium, whose writes fire no input events: it still replaces a selection, and the app's text can change between
    the read and the write. So the card could not promise it.
- Nothing while the screen is locked, and a yes waiting then is spent (`nothing_runs_while_the_screen_is_locked`).
- Never the Apple menu (`a_menu_item_is_chosen_by_its_path_and_never_from_the_apple_menu`), never a blocked shortcut
  (`keys.rs`).
- Reading the permissions never prompts: no prompting call is named anywhere in `computer/`
  (`mod.rs` `reading_the_permissions_never_prompts`), and the page has no command that asks (`computer.test.ts`).

## A snapshot of any app (item 104)

The owner's list of 26 Nov 2026 (`docs/t3code-parity.md`): a key pressed anywhere takes the front window's text and
structure and opens a thread with it. It is in the group that "must be designed first because it can act for the
person", so this is the design, written before the code, and what was built from it.

### The design

- **Off until the person turns it on.** Settings › Computer › Snapshot of any app has a switch, off, and a keys box that
  shows a suggestion, ⌃⌥⌘M (Control, Option, Command and M), which the person can take or change by pressing other keys.
  Nothing is registered with macOS while the switch is off, and the suggestion is only shown. The setting is kept in
  `~/.manut/snapshot.json`; a missing or unreadable file, or anything but a saved `true`, reads as off.
- **Keys that take nothing from anyone.** Two or more of Control, Option and Command, Shift if wanted, and one letter or
  digit. Fewer modifiers would take an app's own shortcut (⌘S, ⇧⌘N) away from every app; a function, media or other key
  is refused, so the plugin never starts its event tap (below). Keys macOS answers itself are refused or found taken:
  a short list by name (Lock Screen ⌃⌘Q, Look Up ⌃⌘D, Full Screen ⌃⌘F, the Dock's ⌥⌘D, Hide Others ⌥⌘H, Minimize All
  ⌥⌘M, Close All ⌥⌘W, Zoom ⌥⌘8, Invert Colours ⌃⌥⌘8), and the shortcuts this Mac has turned on, read from macOS
  (`CopySymbolicHotKeys`), the person's own changes in Keyboard › Shortcuts included.
- **Taken says so.** Keys macOS answers, and keys macOS refuses to register, show "Another app or macOS already uses
  ⌃⌥⌘J. Choose other keys." and are not held. What cannot be seen: another app's own hot key. macOS lets several apps
  register the same key and tells each of them (`CarbonEvents.h`), so registering it does not fail; pressing it then
  does both things. The person sees that and picks other keys.
- **What the key reads is a look's, with a look's refusals.** The app that has the keyboard (`AXFocusedApplication`), its
  frontmost window (the first `AXWindows` gives, as a look with no window named), walked by the same desk to at most 400
  elements and 30 levels. Never Manut AI or another copy of it (pressed with Manut AI in front, it says to press the key
  in the app to bring in), System Settings, Keychain Access, Passwords, macOS's prompts and helpers, an app that does not
  run as the person, a window that shows one of Manut AI's pages by its address or title, or what a password field
  holds (named, never read). Nothing while the screen is locked. Nothing on the Mac is changed: a snapshot only reads.
- **Masked before it leaves the shell.** Every name, title and value loses its invisible format characters and control
  characters, a link that answers an ask loses its token (`/approve/…`, `room.rs` `hide_links`), and text that looks
  like a key or a password becomes `••••` through the app's one masker (`src/lib/secrets.json`, the shell's
  `tasks.rs` `mask_secrets`, the rules a phone's view, a skill bundle and Kit's changes are masked with). Each is counted.
  Then the lines are cut: 2,000 characters a value, 200 a name, 8,000 in all.
- **Shown first, never sent.** Pressing the key brings Manut AI to the front and opens a new chat with Home's member
  (Buddy, the runtime's default) whose box holds the snapshot as text the person reads and edits: a line naming the app
  and the window, a line saying Manut AI read it from that window and that it is the app's text, not the person's, and
  gives no permission (as another chat's context says, item 97), how many keys, approval links and password fields were
  hidden, whether it was cut, the window's lines in a fence longer than any backticks in them, and a line that ends it.
  The caret waits after it for the person's ask. Nothing goes to the agent until Send; the only thing the runtime is
  asked for is the new, empty chat. When no chat can be made (no team yet, the runtime away), the block is kept in
  Drafts on Home and a line says so.
- **No permission, no surprise.** Without Accessibility the key reads nothing and Manut AI opens on one line ("To read a
  window, Manut AI needs Accessibility...") with the same Open button Settings › Computer has, which opens the pane and
  grants nothing. macOS is never asked: no prompting call is named in `computer/` (`mod.rs`
  `reading_the_permissions_never_prompts` reads `snap.rs` too, and now refuses `CGEventTapCreate` and
  `CGRequestListenEventAccess` as well). A window that is never read, nothing in front, or a locked screen say so on the
  same line.
- **A picture only if asked.** A second switch, off, adds a picture of the window to the box, and only when Screen
  capture is already allowed (`CGPreflightScreenCaptureAccess`); otherwise the block says no picture was taken. A
  picture is not masked, and the switch's line says so.
- **The page cannot register keys.** The plugin's four commands are given to no page (`capabilities/default.json`), so
  only the shell registers, from the person's change in Settings. The App Store edition, whose sandbox refuses
  accessibility, registers nothing and does not show the rows; nor does Windows or Linux.

### What the platform gives

| What | Fact | Source |
| --- | --- | --- |
| The key | Tauri's global-shortcut plugin 2.4.1 (Apache-2.0 OR MIT) registers through global-hotkey 0.8.0, which on macOS calls Carbon's `RegisterEventHotKey` with no options for a letter or digit, and `CGEventTapCreate` only for a media key | the crates' source, `platform_impl/macos/mod.rs` |
| Several apps, one key | "Hot keys are normally non-exclusive: when the key is pressed, notification events are sent to all registrants for that hotkey"; `eventHotKeyExistsErr` only for the same process, or for two exclusive registrations | `HIToolbox/CarbonEvents.h`, `CarbonEventsCore.h` |
| macOS's own shortcuts | `CopySymbolicHotKeys` returns "the system-wide symbolic hotkeys that are defined in the Keyboard preferences pane" with `kHISymbolicHotKeyCode`, `kHISymbolicHotKeyModifiers` (Carbon's bits) and `kHISymbolicHotKeyEnabled`; "It does not include customized application-specific command keys"; not thread safe. This Mac listed 234 on 27 Nov 2026, ⌘⇧3 as key 20 with 768 | `HIToolbox/CarbonEvents.h`, read on this Mac |
| The app in front | The system-wide element's `AXFocusedApplication` and `AXUIElementGetPid`; a Carbon hot key does not bring Manut AI to the front, so it is the app the person was in | `HIServices/AXAttributeConstants.h`, `AXUIElement.h` |
| Key places | A hot key is a key's place (`kVK_ANSI_M` is 0x2E), the same place on every layout; the stand-in U.S. layout's table holds the same codes | `HIToolbox/Events.h`, `stand.rs` |

### Its tests

`snap.rs`: `the_key_is_off_by_default_and_nothing_is_registered_until_it_is_turned_on`,
`turning_it_on_registers_the_keys_and_off_lets_them_go`, `keys_another_app_holds_say_they_are_taken`,
`keys_macos_answers_itself_are_taken_and_never_registered`, `only_two_modifiers_and_a_letter_or_digit_can_be_the_key`,
`elsewhere_nothing_is_registered`, `one_snapshot_at_a_time`, `a_snapshot_reads_the_front_window_as_a_look_does`,
`without_accessibility_nothing_is_read_and_the_page_is_told_what_is_needed`, `refused_windows_are_never_read`,
`secrets_and_approval_links_are_masked_and_counted`, `a_snapshot_is_bounded_in_size_and_depth`,
`a_picture_only_when_asked_and_screen_capture_is_allowed`, `the_page_is_given_none_of_the_plugins_commands`,
`what_was_taken_reaches_the_page_in_its_own_names`; `mac.rs` `this_macs_own_shortcuts_are_read_without_asking`. The page:
`src/computer/snapshot.test.ts` (the block in four languages, the fence, reading the shell's answer, opening it through
the app's own store with nothing but the new chat asked of the runtime), `src/settings/SnapshotRows.test.tsx`, and
`e2e/app-snapshot.spec.ts` (the stand-in event opens the new chat with the block in its box, nothing is sent until Send
and then the edited block goes once; a picture joins the box as a file; without Accessibility the line and its Open
button and no chat; Settings' switch, keys and taken line). The key itself and a real window are the owner's steps below.

## What the app declares

Nothing new: no usage line exists for either permission and no entitlement covers either (above), so `Info.plist` and
`Entitlements.plist` are as voice left them (`mod.rs` `declares_nothing_new_for_computer_use`). An unsigned or ad hoc
build can be given both permissions by the person in System Settings; macOS ties them to that build, so after each
update both must be turned off and on again, and the page says so. A Developer ID build keeps them.

## What only a person at the Mac can check

On the Mac app built from this branch:

1. Settings › Computer: both read Off and the line says what is missing; nothing prompts.
2. Press Open beside Accessibility: System Settings opens on Privacy & Security's Accessibility list ("Device Control
   and Data Access" on macOS 27). Turn Manut AI on (add it with + if it is not listed). Come back: the page reads Allowed.
   Do the same for Screen capture ("Screen & System Audio Recording"); macOS may ask to quit and reopen Manut AI.
3. The line reads "Computer use is ready". The note about the Developer ID shows on 0.1.1.
4. Start a new Buddy chat and say "Open TextEdit's front window and tell me what it says" with a TextEdit document
   open. A card asks to look at TextEdit; Allow once. The answer quotes the document. (This is the first run of the
   socket's caller check with a real Claude Code: if every call says it did not come from the chat's server, the
   chat's server is not under the process Manut AI started, and that is a bug to report.) Then, from Terminal, run
   `ls ~/.manut/computer`: there is no `chats` folder.
5. With an empty TextEdit document, ask "Type Hello into the TextEdit document": a card titled "Type into text area in
   TextEdit?" names the window, the text area and "Hello", and says the control's name is the one TextEdit gives it.
   Press No: nothing is typed, and the agent does not ask again by itself. Ask again and Allow once: Hello appears once.
   Then ask "Type Thanks into the document": the card now reads "Replace everything in text area (5 characters) in
   TextEdit?" with "Replace with: Thanks". Before answering, type a letter into the document yourself, then Allow once:
   nothing is typed and the agent says the field changed. Ask it to click a button in a small dialog: with Screen capture on, the
   card shows a small picture of that button. Move the window after the card shows and before Allow once: the click is
   refused as moved, and the agent asks again.
6. Ask for Cmd+S in TextEdit: a card says "Press Cmd+S in TextEdit?"; Allow once saves. Ask for Cmd+Q: refused, no card.
   Turn on the French layout in System Settings › Keyboard › Text Input, select it, and ask for Cmd+A in a TextEdit
   document: Allow once selects all and TextEdit stays open. Ask for Cmd+1: refused, naming the layout.
7. Ask it to look at System Settings, Keychain Access, or Manut AI itself: refused, no card. Open an approval link from
   the pilot in Safari and in Chrome, allow the agent to look at each browser, and ask it to look at that tab or press
   Approve: refused, no card, in both. Ask it to read a LINE or Mail message that holds such a link: the link reads
   `/approve/…`.
8. With a login form open in Safari, ask it to read the password field: the tree says the field's content is never read.
9. Lock the Mac (Ctrl+Cmd+Q) while the agent works on a request in an app, and unlock: whatever it tried meanwhile says
   the screen was locked and nothing was done.
10. After installing the next unsigned update, open Settings › Computer: expect both Off until turned off and on again.

The snapshot key (item 104), on the Mac app built from this branch:

11. Settings › Computer › Snapshot of any app: the switch reads Off, the keys box ⌃⌥⌘M, and the line "Off. No key is set
    with macOS". With Manut AI in the background, press ⌃⌥⌘M in TextEdit: nothing happens.
12. Turn the switch On: the line reads "On. Press ⌃⌥⌘M in any app." No macOS prompt appears, then or later.
13. With Accessibility Off (Settings › Computer), click into TextEdit and press ⌃⌥⌘M: Manut AI comes to the front with
    one line saying it needs Accessibility and an Open button; Open shows the Accessibility pane. No chat was made.
14. With Accessibility on, open a TextEdit document holding a few lines and `ghp_` followed by 36 letters and digits,
    click into it and press ⌃⌥⌘M: Manut AI comes to the front on a new chat with Buddy whose box starts "From TextEdit,
    window ...", says one key was hidden, and shows the document's lines with `••••` in place of the key. Nothing is
    sent: edit it, add a question, press Send, and only then does Buddy answer.
15. Press ⌃⌥⌘M with System Settings, Keychain Access or Manut AI itself in front: a line says it is never read, or to
    press the key in the app to bring in; no chat. Open an approval link from the pilot in Safari and press it there:
    refused the same way.
16. In the keys box press ⌃⌘S or another shortcut System Settings › Keyboard › Keyboard Shortcuts lists as on: the line
    says another app or macOS uses it. Press ⌘M: it asks for two of Control, Option and Command.
17. Turn on Picture of the window with Screen capture allowed and press the key over TextEdit: the box also holds a
    picture of the window. With Screen capture off, the block says no picture was taken.
18. Turn the switch Off: ⌃⌥⌘M does nothing again in any app. Quit and reopen Manut AI with it On: the key works without
    opening Settings.

## Needs the owner

- **The suggested keys.** ⌃⌥⌘M is the suggestion (no shortcut macOS answers on this Mac, and three modifiers keep it out
  of apps' menus). Another default is a one-line change (`snap.rs` `SUGGESTED`).

- **A Developer ID signature** (item 63's Apple secrets), so both permissions survive updates.
- **Which agents get it.** Only Claude Code chats (Buddy's and Kit's) have it: their asks are cards the shell sees.
  Codex and the ACP agents' chats, and terminal sessions, have no computer use yet.
- **Picture engine.** `CGWindowListCreateImage` is deprecated in favour of ScreenCaptureKit, a Swift-first API; if a later
  macOS stops answering it, pictures need a small Swift part.
