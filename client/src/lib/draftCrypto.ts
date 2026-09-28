/**
 * draftCrypto — at-rest encryption for sensitive IndexedDB form drafts
 * =====================================================================
 * KYC drafts persisted to IndexedDB contain highly sensitive identifiers
 * (NIN, BVN). This module encrypts those fields with AES-256-GCM using a
 * per-device key before they touch disk, and decrypts them on draft restore.
 *
 * Key management:
 *  - A 256-bit AES-GCM key is generated once per device via WebCrypto and
 *    stored as a JWK in localStorage ("np_draft_key_v1").
 *  - The key never leaves the device and is never sent to the server.
 *  - If the key is lost (storage cleared), old drafts simply fail to decrypt
 *    and the affected fields are dropped rather than exposed.
 *
 * Wire format for an encrypted field:
 *   { __enc: 1, iv: <base64>, data: <base64> }
 */
const KEY_STORAGE = "np_draft_key_v1";
const ENC_MARKER = "__enc";

let cachedKey: Promise<CryptoKey> | null = null;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Load or generate the per-device AES-GCM key. */
async function getDeviceKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = (async () => {
      const stored = localStorage.getItem(KEY_STORAGE);
      if (stored) {
        try {
          return await crypto.subtle.importKey(
            "jwk",
            JSON.parse(stored),
            { name: "AES-GCM" },
            false,
            ["encrypt", "decrypt"]
          );
        } catch {
          localStorage.removeItem(KEY_STORAGE);
        }
      }
      const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
      );
      const jwk = await crypto.subtle.exportKey("jwk", key);
      localStorage.setItem(KEY_STORAGE, JSON.stringify(jwk));
      // Re-import as non-extractable for ongoing use
      return crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
      );
    })();
  }
  return cachedKey;
}

export async function encryptField(plaintext: string): Promise<Record<string, unknown>> {
  const key = await getDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { [ENC_MARKER]: 1, iv: toBase64(iv), data: toBase64(new Uint8Array(cipher)) };
}

function isEncryptedField(value: unknown): value is { __enc: 1; iv: string; data: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[ENC_MARKER] === 1 &&
    typeof (value as Record<string, unknown>).iv === "string" &&
    typeof (value as Record<string, unknown>).data === "string"
  );
}

export async function decryptField(payload: { iv: string; data: string }): Promise<string> {
  const key = await getDeviceKey();
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(payload.iv) as BufferSource },
    key,
    fromBase64(payload.data) as BufferSource
  );
  return new TextDecoder().decode(plain);
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined),
    obj
  );
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = cursor[keys[i]];
    if (!next || typeof next !== "object") return;
    cursor = next as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]] = value;
}

/**
 * Returns a copy of `data` with each dot-path in `paths` AES-GCM encrypted.
 * Non-string or missing values are left untouched.
 */
export async function encryptDraftFields(
  data: Record<string, unknown>,
  paths: string[]
): Promise<Record<string, unknown>> {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(data));
  for (const path of paths) {
    const value = getPath(copy, path);
    if (typeof value === "string" && value.length > 0) {
      setPath(copy, path, await encryptField(value));
    }
  }
  return copy;
}

/**
 * Returns a copy of `data` with each dot-path in `paths` decrypted.
 * Fields that fail to decrypt (e.g. key rotated) are removed rather than
 * surfaced as garbage.
 */
export async function decryptDraftFields(
  data: Record<string, unknown>,
  paths: string[]
): Promise<Record<string, unknown>> {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(data));
  for (const path of paths) {
    const value = getPath(copy, path);
    if (isEncryptedField(value)) {
      try {
        setPath(copy, path, await decryptField(value));
      } catch {
        setPath(copy, path, undefined);
      }
    }
  }
  return copy;
}
