import crypto from "node:crypto";

const CASTLE_SUFFIX = "T!BgJB";

function deriveKey(apiKeyB64: string): Buffer {
  const apiKeyBytes = Buffer.from(apiKeyB64, "base64");
  const suffixBytes = Buffer.from(CASTLE_SUFFIX, "ascii");
  let keyMaterial = Buffer.concat([apiKeyBytes, suffixBytes]);

  if (keyMaterial.length < 16) {
    const padding = Buffer.alloc(16 - keyMaterial.length, 0);
    keyMaterial = Buffer.concat([keyMaterial, padding]);
  } else if (keyMaterial.length > 16) {
    keyMaterial = keyMaterial.subarray(0, 16);
  }

  return keyMaterial;
}

export function decryptData(encryptedB64: string, apiKeyB64: string): string | null {
  try {
    const aesKey = deriveKey(apiKeyB64);
    const iv = aesKey;
    const encryptedData = Buffer.from(encryptedB64.trim(), "base64");
    const decipher = crypto.createDecipheriv("aes-128-cbc", aesKey, iv);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}
