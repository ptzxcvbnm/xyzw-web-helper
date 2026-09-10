# Single-window game launcher

Adapted from https://github.com/ptzxcvbnm/man-god at
`d9cce6c3ff08a649e98e1a0aa672bb91f898bedd`.

Entry: `/admin/game-login` in the authenticated Vue application. Static runtime:
`/game-launcher/game.html`. Vite copies this directory into the production build.

The standalone document loads Cocos 2.4.9 and current remote game bundles.
The parent page owns exactly one iframe and destroys it on close or navigation.
Parent messages contain only startup state; no assistant credentials are passed.
The game uses the `slot-1` browser storage namespace and the reference BIN login
bridge. Selecting an imported account reloads the game to authenticate. With no
account selected, authentication waits and opens the BIN panel.

Local adaptations:
- Removed quarantine scripts, script-manager startup and third-party HTTP origin.
- Hidden QR login because this integration provides BIN login only.
- Retained reference audio muting and platform compatibility shims.
- Kept all resource paths relative to this directory.

This iframe is same-origin. Storage namespacing prevents accidental key collisions;
it is not a security boundary against scripts. Game resources still execute from
the configured Hortor CDN. The game HTML scopes its Cocos CSP exception to itself.

Manual login is independent of assistant task management. Stop automation for the
same role before logging in; closing the game does not resume backend tasks.
Local validation on 2026-09-10: production build, runtime JavaScript syntax,
remote resource loading, and user-provided BIN login reaching `GameRunning`.
No resource-spending game actions were performed. Production is not deployed.
