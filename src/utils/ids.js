import { customAlphabet } from 'nanoid';

// Unambiguous alphabet: no 0/O/1/l/I, so a value can be read aloud or retyped.
const SAFE = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';

/** Stable section identity, kept across edits and reorders. */
export const sectionKey = customAlphabet(SAFE, 10);
/** Public, non-enumerable order handle used in /track/:id and /invoice/:id. */
export const publicId = customAlphabet(SAFE, 14);
/** Domain-verification TXT token. */
export const verificationToken = customAlphabet(SAFE, 24);
/** CSRF cookie value and one-time session handoff tokens. */
export const opaqueToken = customAlphabet(SAFE, 32);

/** Operator-friendly generated password: readable, still 16 chars of entropy. */
export const generatePassword = customAlphabet(SAFE, 16);
