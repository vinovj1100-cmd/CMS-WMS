import { randomBytes, scrypt, timingSafeEqual, randomUUID } from "node:crypto"
import { promisify } from "node:util"

import { getConfig } from "./config"

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

const KEY_LENGTH = 64
const SALT_LENGTH = 32
const R = 8
const P = 1

export interface HashedPassword {
  hash: string
  salt: string
}

/**
 * Hashes a password with scrypt (memory-hard, resistant to GPU cracking).
 *
 * The cost parameter N comes from config so it can be raised as hardware
 * improves without a code change. `maxmem` must scale with N or Node throws
 * "memory limit exceeded".
 */
export async function hashPassword(password: string): Promise<HashedPassword> {
  const { scryptN } = getConfig()
  const salt = randomBytes(SALT_LENGTH)
  const derived = await scryptAsync(normalize(password), salt, KEY_LENGTH, {
    N: scryptN,
    r: R,
    p: P,
    maxmem: 256 * scryptN * R,
  })
  return { hash: derived.toString("base64"), salt: salt.toString("base64") }
}

/**
 * Constant-time password verification.
 *
 * Both the length check and the byte comparison are arranged so the function
 * takes the same path regardless of where the mismatch occurs.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
  storedSalt: string,
): Promise<boolean> {
  const { scryptN } = getConfig()

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(storedSalt, "base64")
    expected = Buffer.from(storedHash, "base64")
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  const derived = await scryptAsync(normalize(password), salt, expected.length, {
    N: scryptN,
    r: R,
    p: P,
    maxmem: 256 * scryptN * R,
  })

  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

/**
 * NFKC-normalises and length-caps the password before hashing.
 *
 * scrypt has an internal 128-byte limit; rejecting anything longer up front
 * avoids a silent truncation that would let a 200-byte password verify against
 * a 130-byte one.
 */
function normalize(password: string): string {
  const normalized = password.normalize("NFKC")
  if (normalized.length > 128) {
    throw new PasswordPolicyError("Password exceeds the 128 character limit.")
  }
  return normalized
}

export class PasswordPolicyError extends Error {
  readonly issues: string[]
  constructor(message: string, issues: string[] = []) {
    super(message)
    this.name = "PasswordPolicyError"
    this.issues = issues
  }
}

/**
 * Password policy: minimum 12 characters, at least three of four character
 * classes, and rejects the most common weak patterns.
 */
export function evaluatePasswordStrength(password: string): { ok: boolean; issues: string[]; score: number } {
  const issues: string[] = []
  let score = 0

  if (password.length < 12) issues.push("at least 12 characters")
  else score += 1

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length
  if (classes < 3) issues.push("characters from at least three of: lower, upper, digit, symbol")
  else score += 1

  const common = [
    "password",
    "12345678",
    "qwerty",
    "letmein",
    "welcome",
    "admin",
    "warehouse",
    "changeme",
  ]
  if (common.some((c) => password.toLowerCase().includes(c))) {
    issues.push("must not contain a common password word")
  } else {
    score += 1
  }

  if (/(.)\1{2,}/.test(password)) issues.push("must not repeat the same character 3+ times")
  else score += 1

  if (/^[0-9]+$/.test(password)) issues.push("must not be entirely numeric")

  return { ok: issues.length === 0 && password.length >= 12, issues, score }
}

/** Cryptographically uniform ID. */
export function generateId(prefix?: string): string {
  const id = randomUUID()
  return prefix ? `${prefix}_${id}` : id
}

/** Uniform random token, safe for CSRF and session IDs. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}
