'use strict'

// This is the complete allow-list used by the minimal audited launcher.
// Keep deployment-specific values here instead of hiding them in obfuscated code.
window.__AUDIT_RUNTIME_CONFIG__ = Object.freeze({
  manifestUrl:
    'https://xxz-xyzw.hortorgames.com/login/manifest?platform=hortor&version=0.32.0-android',
  resourceOrigin: 'https://xxz-xyzw-res.hortorgames.com',
  gameOrigin: 'https://xxz-xyzw.hortorgames.com',
  battleOrigin: 'https://xxz-xyzw-service-battle.hortorgames.com',
  switchOrigin: 'https://comb-platform.hortorgames.com',
  encryptedScriptKey: '0Aed5E79bbEa69f8',
  legacyPluginsEnabled: false,
  readableAccountLoginEnabled: true,
  accountStorageEnabled: true,
  ignoredStartupScripts: [
    'assets/launcher/common/libs/platform/hortor/HSDK.turnpass.min.b480c.js'
  ],
  mode: 'remote-readonly-bootstrap'
})

