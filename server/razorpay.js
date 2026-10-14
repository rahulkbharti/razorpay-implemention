import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import { safeEqual } from './util.js';

const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.error('Missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env');
  process.exit(1);
}

export const keyId = RAZORPAY_KEY_ID;
export const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });

/** Checks a Checkout signature: HMAC-SHA256 of `payload` with the key secret. */
export function signedByRazorpay(payload, signature) {
  const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(payload).digest('hex');
  return safeEqual(expected, signature);
}
