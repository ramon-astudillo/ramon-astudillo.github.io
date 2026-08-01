// Web Crypto helpers: PBKDF2 key derivation + AES-GCM encrypt/decrypt.
// No third-party crypto library — everything here is SubtleCrypto.

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKeyFromPassphrase(passphrase) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(CONFIG.PBKDF2_SALT),
      iterations: CONFIG.PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true, // extractable, so it can be cached in localStorage
    ["encrypt", "decrypt"]
  );
}

async function exportKeyToBase64(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bytesToBase64(new Uint8Array(raw));
}

async function importKeyFromBase64(b64) {
  const raw = base64ToBytes(b64);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
}

// Encrypts a JS object, returns the JSON string to store on Dropbox: {iv, ciphertext}
async function encryptPayload(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(obj));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return JSON.stringify({
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

// Decrypts the {iv, ciphertext} JSON string back into the original JS object.
// Throws if the key is wrong or the data is corrupt (AES-GCM auth tag fails).
async function decryptPayload(key, fileText) {
  const { iv, ciphertext } = JSON.parse(fileText);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
