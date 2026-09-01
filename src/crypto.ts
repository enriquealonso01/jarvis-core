import crypto from "node:crypto";
import fs from "node:fs";

const GCM_NONCE_LEN = 12;
const GCM_TAG_LEN = 16;

export function loadMasterKey(path = process.env.MASTER_KEY_PATH ?? "/var/lib/jarvis/keys/master.key"): Buffer {
  const key = fs.readFileSync(path);
  if (key.length !== 32) {
    throw new Error("master.key must be 32 bytes");
  }
  return key;
}

export function encryptGcm(key: Buffer, plaintext: Buffer): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = crypto.randomBytes(GCM_NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext: Buffer.concat([body, tag]) };
}

export function decryptGcm(key: Buffer, nonce: Buffer, ciphertext: Buffer): Buffer {
  if (ciphertext.length < GCM_TAG_LEN) {
    throw new Error("ciphertext too short");
  }
  const tag = ciphertext.subarray(ciphertext.length - GCM_TAG_LEN);
  const body = ciphertext.subarray(0, ciphertext.length - GCM_TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function wrapDek(master: Buffer, dek: Buffer): Buffer {
  const { nonce, ciphertext } = encryptGcm(master, dek);
  return Buffer.concat([nonce, ciphertext]);
}

export function unwrapDek(master: Buffer, wrapped: Buffer): Buffer {
  const nonce = wrapped.subarray(0, GCM_NONCE_LEN);
  const ciphertext = wrapped.subarray(GCM_NONCE_LEN);
  return decryptGcm(master, nonce, ciphertext);
}

export function newDek(): Buffer {
  return crypto.randomBytes(32);
}
