import crypto from "crypto";

const TRANSFORMATION = "aes-128-cbc";

export function decryptAES(inputHex: string, key: string, iv: string): string {
  const keyBuf = Buffer.from(key, "utf8");
  const ivBuf = Buffer.from(iv, "utf8");
  const encryptedBuf = Buffer.from(hexToByteArray(inputHex));
  const decipher = crypto.createDecipheriv(TRANSFORMATION, keyBuf, ivBuf);
  const decrypted = Buffer.concat([
    decipher.update(encryptedBuf),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

function hexToByteArray(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Hex string must have even length");
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return arr;
}
