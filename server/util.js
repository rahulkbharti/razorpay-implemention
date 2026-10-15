import crypto from 'node:crypto';

/** An error whose message (and details, e.g. a machine-readable code) is safe to show the client. */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** A database id from user input, or null if it isn't one. */
export function toId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}
