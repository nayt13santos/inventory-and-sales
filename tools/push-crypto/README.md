# Web Push signing bundle

`npm ci && npm run build` reproducibly builds `apps-script/PushCrypto.gs` from
the pinned noble-curves dependency and lockfile. The generated bundle is
committed so Apps Script deployment needs no package installation. Keep the
license files with the source. No production key is part of this repository.

This exposes P-256 public-key derivation and deterministic RFC6979 ES256
signing for VAPID (RFC8292). Generate the one-time private key using a secure
OS random source, then initialize it through the authenticated `configurePush`
action. It lives only in Script Properties; repeated setup never rotates it.

The sender uses payloadless Web Push (RFC8030). The service worker then fetches
the latest notice with its individual read-only capability. There is no custom
message encryption, no runtime pseudo-random generator, and no API write token
stored in the service worker or sent to browser push services.

Reference: https://www.rfc-editor.org/rfc/rfc8292
