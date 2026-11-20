import { hash, verify } from "@node-rs/argon2";

/**
 * Unicode NFKC normalization (NIST SP 800-63B): the same password typed on
 * two keyboards ("é" as one code point or as "e" + accent) gives the same
 * hash. It changes nothing for ASCII passwords, so existing hashes still verify.
 */
export function normalizePassword(plain: string): string {
  return plain.normalize("NFKC");
}

export async function hashPassword(plain: string): Promise<string> {
  return hash(normalizePassword(plain));
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  return verify(hashed, normalizePassword(plain));
}
