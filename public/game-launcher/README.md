# Single-window game launcher

Adapted from https://github.com/ptzxcvbnm/man-god at
`d9cce6c3ff08a649e98e1a0aa672bb91f898bedd`.

Entry: `/admin/game-login` in the authenticated Vue application. Static runtime:
`/game-launcher/game.html`. Vite copies this directory into the production build.

The standalone document loads Cocos 2.4.9 and current remote game bundles.
The parent page owns exactly one iframe and destroys it on close or navigation.
The outer page lists the current user's imported assistant accounts. It obtains
the selected account's BIN through the existing authenticated token API, then
sends it to that iframe using an exact-origin postMessage handshake. The child
checks both origin and sender and accepts one account per document. Credentials
stay in memory and are never put in URLs or saved by the login bridge. The child
replies only with status events. Restart retrieves the selected account again.
Accounts without a stored BIN must be reimported through Token management.
The game uses the `slot-1` storage namespace for its own runtime data.

Local adaptations:
- Removed quarantine scripts, script-manager startup and third-party HTTP origin.
- Removed the in-game account popup, separate account list and import controls.
- Reused assistant BIN/QR imports instead of maintaining a second account store.
- Retained reference audio muting and platform compatibility shims.
- Kept all resource paths relative to this directory.

This iframe is same-origin. Storage namespacing prevents accidental key collisions;
it is not a security boundary against scripts. Game resources still execute from
the configured Hortor CDN. The game HTML scopes its Cocos CSP exception to itself.

Manual login is independent of assistant task management. Stop automation for the
same role before logging in; closing the game does not resume backend tasks.
The initial standalone bridge was validated with a user-provided BIN on 2026-09-10.
For the external bridge, run `node --test test/game-launcher-login.test.mjs` and
`npm run build`. The tests cover delayed credentials, origin/sender validation,
duplicate handshakes, invalid credentials and authentication rejection.
