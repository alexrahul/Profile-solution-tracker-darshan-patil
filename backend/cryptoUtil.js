import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

function encryptionKey() {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
  const buf = Buffer.from(key, "base64");
  if (buf.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return buf;
}

export function encryptToken(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptToken(payload) {
  if (!payload) return null;
  const [ivB64, authTagB64, cipherB64] = String(payload).split(":");
  if (!ivB64 || !authTagB64 || !cipherB64) throw new Error("Invalid encrypted token payload");

  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(cipherB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}
