# Foreman

An agent-first macOS IDE built on the Claude Agent SDK. The primary object is an
**agent session**, not a file tree.

Requires macOS 26+ (`minimumSystemVersion` in `package.json`) — the window uses
`NSGlassEffectView` via `electron-liquid-glass`.

## Running it

| | Command | What you get |
|---|---|---|
| **Dev** | `npm run dev` | Hot reload, DevTools, CDP on `:9222`. Runs as **Foreman Dev**. |
| **Preview** | `npm run start` | The built output, unpackaged. Sanity-check a build without a DMG. |
| **Package** | `npm run dist` | `release/Foreman-<v>-arm64.dmg` + `release/mac-arm64/Foreman.app` |
| **Release** | `npm run dist:release` | Same, plus notarization. Needs credentials — see below. |

**You can run the dev build and the installed app at the same time.** That is
what `app.setName('Foreman Dev')` in `src/main/index.ts` is for: `app.getName()`
would otherwise be `foreman` in dev and `Foreman` when packaged, and APFS is
case-insensitive by default, so both would resolve to one
`~/Library/Application Support` directory. Sharing it means sharing one Chromium
profile — the second process to start can't take the LevelDB lock, its
localStorage silently stops persisting, and both would write the same
`userData/worktrees`. With the split:

```
~/Library/Application Support/foreman      # the installed app
~/Library/Application Support/Foreman Dev  # npm run dev
```

Agent transcripts are **not** in either — those live in `~/.claude/projects/`,
keyed by project path, and are shared by both. Resuming a session started in the
dev build from the installed app works, and is usually what you want.

`foreman <path>` or `FOREMAN_OPEN=<path> npm run dev` opens a project directly.

### Before committing

```sh
npm run typecheck   # both tsconfigs: main/preload and renderer
npm run check       # porcelain, policy, derive, transcript self-checks
```

The `check:*` scripts are assert-based files run by bare node. That is why
`policy.mts`, `porcelain.mts`, `transcript.mts` and `derive.mts` import no
Electron and no SDK — keep it that way or they stop being loadable. Note the
root `package.json` is `"type": "commonjs"`, so `.mts` is what gets ESM plus
type-stripping under plain node.

## Signing and notarization

Signing is configured; **notarization is not, and needs one certificate you do
not currently have.**

`npm run dist` signs with whatever identity is in the keychain, so the app runs
on this machine. It is `spctl: rejected` anywhere else, because an *Apple
Development* certificate is not a distribution certificate:

```
$ security find-identity -v -p codesigning
  1) Apple Development: GABRIEL CAMPILLO (AR6G3Q24VH)
```

### What you need

1. **A Developer ID Application certificate**, on the **Eat Picky Corp** team.

   ```sh
   security find-identity -v -p codesigning
   #  1) … "Apple Development: GABRIEL CAMPILLO (AR6G3Q24VH)"
   #  2) … "Developer ID Application: Eat Picky Corp (UR28366SA6)"   ← this one
   ```

   Xcode → Settings → Accounts → Manage Certificates → **+**. If the menu offers
   only *Apple Development* / *Apple Distribution* / *Mac Installer
   Distribution*, **you have the wrong team selected** — that list is per-team,
   and Developer ID lives on the organization team, not on a personal one. Pick
   Eat Picky Corp in the team list first. (Creating one also requires the
   Account Holder role, and a team is capped at 5.)

2. **Team ID `UR28366SA6`.** Confusingly this is the same team as the *Apple
   Development* certificate — its `OU` field is the team, and the team is Eat
   Picky Corp. What is **not** the team id is the parenthesised string in that
   cert's common name (`AR6G3Q24VH`); that is the certificate's own identifier,
   and passing it fails notarization.

   ```sh
   security find-certificate -c "Developer ID Application" -p \
     | openssl x509 -noout -subject | tr ',' '\n' | grep OU
   ```

3. **An app-specific password**, from appleid.apple.com → Sign-In and Security →
   App-Specific Passwords.

### Then

Store the credentials in the keychain once, rather than putting a password in
your environment and shell history:

```sh
xcrun notarytool store-credentials foreman \
  --apple-id 'you@example.com' --team-id UR28366SA6     # prompts for the password

APPLE_KEYCHAIN_PROFILE=foreman npm run dist:release
```

`electron-builder` reads `APPLE_KEYCHAIN_PROFILE`, and also accepts
`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or an App Store
Connect API key via `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`.

With two identities in the keychain, `electron-builder` picks Developer ID
Application on its own for a non-MAS `mac` target — there is nothing to
configure. Force it with `CSC_NAME="Developer ID Application: Eat Picky Corp"`
if you ever need to.

> A `.p12` export is only a transport format. Once
> `security find-identity` lists the identity, the keychain has both halves and
> the file is a loose copy of your private signing key — delete it.

Expect it to be slow: notarization uploads the whole DMG, and the bundled
`claude` binary alone is ~256 MB.

Verify:

```sh
codesign -dv --verbose=4 release/mac-arm64/Foreman.app   # Authority: Developer ID Application
spctl -a -vvv -t exec    release/mac-arm64/Foreman.app   # accepted
xcrun stapler validate   release/mac-arm64/Foreman.app   # ticket stapled
```

### Why the split between `dist` and `dist:release`

`notarize` is deliberately **not** in `package.json`'s build config. It lives
only on `dist:release`, as `-c.mac.notarize=true`, so the everyday `npm run
dist` cannot break when credentials are absent. `package.json` can't hold
comments, hence this paragraph.

### Why the entitlements look permissive

`build/entitlements.mac.plist` is commented per key, but the load-bearing one is
`disable-library-validation`. This app loads `node-pty` and
`electron-liquid-glass` out of `app.asar.unpacked` and spawns the SDK's separate
`claude` executable from there; none are signed by this team, and library
validation rejects all three. Verified: under hardened runtime that binary signs
(`flags=0x10000(runtime)`) and still executes.

`asarUnpack` exists because `spawn()` is not asar-aware — a path inside
`app.asar` dies with `ENOTDIR`. `claudeExecutable()` in `src/main/agent/session.ts`
rewrites the SDK's self-resolved path to the unpacked copy.

## Layout

```
src/main/index.ts          app lifecycle, transparent window, liquid glass
src/main/bridge.ts         send() to renderer — breaks the index<->manager cycle
src/main/agent/session.ts  Session: query handle, SDK message -> ChatItem, controls
src/main/agent/manager.ts  Map<id, Session>, create/resume/close, worktrees
src/main/agent/worktrees.ts  git worktree isolation for parallel agents
src/main/agent/snapshots.ts  PreToolUse + PostToolUse diff capture, revert, commit
src/preload/index.ts       contextBridge surface
src/renderer/src/          zustand store, components, theme.css (all colour tokens)
```

Main normalises raw SDK messages into `ChatItem`s before they cross IPC, so the
renderer never imports the SDK.
