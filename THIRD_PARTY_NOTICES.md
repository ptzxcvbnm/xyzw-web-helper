# Third-party notices

## Push-level page and BOSS names

`src/views/PushLevel.vue` adapts the account selector, group controls, torch controls,
battle cards, and log layout from
[w1249178256/xyzw_web_helper — PushingLevels.vue](https://github.com/w1249178256/xyzw_web_helper/blob/main/src/views/PushingLevels.vue)
(source blob `054fa2d50a7c710a6f1d32f2a7bcc7a6338f9108`, retrieved 2026-10-31).

`src/utils/pushLevelBossNames.js` contains the upstream
[boss_names.js](https://github.com/w1249178256/xyzw_web_helper/blob/main/src/views/boss_names.js)
(source blob `4f837ee3b28850aaec5492c549ae909896fd02c5`).

Copyright (c) 2024 XYZW Team and upstream contributors. Licensed under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), as in the
upstream LICENSE and this project's LICENSE. Adaptations remain under the same license.

Changes: replaced browser battle loops with server task APIs, connected the existing
offline simulation accelerator, added server countdowns and log history, batch
controls, scoped account access, and retained tasks when leaving the page.
