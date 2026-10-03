// VAPID ES256 uses deterministic RFC6979 signing. No random source is needed
// at runtime; the private key is generated once with Node's crypto module.
import { p256 } from '@noble/curves/nist.js';
export function publicKey(key) { return p256.getPublicKey(key, false); }
export function sign(message, key) {
  return p256.sign(message, key, { prehash: true, format: 'compact', extraEntropy: false });
}
