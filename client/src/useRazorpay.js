const SRC = 'https://checkout.razorpay.com/v1/checkout.js';
let loader;

/** Loads Razorpay Checkout once and resolves with window.Razorpay. */
export function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loader) return loader;

  loader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SRC;
    script.async = true;
    script.onload = () => resolve(window.Razorpay);
    script.onerror = () => {
      loader = undefined;
      reject(new Error('Failed to load Razorpay Checkout'));
    };
    document.body.appendChild(script);
  });
  return loader;
}

/**
 * Opens Checkout. Resolves with the success response (to send to the server for
 * verification), or with null if the customer closes it without paying.
 */
export async function openCheckout(options, onFailedAttempt) {
  const Razorpay = await loadRazorpay();
  return new Promise((resolve) => {
    const rzp = new Razorpay({ ...options, handler: resolve, modal: { ondismiss: () => resolve(null) } });
    // Checkout stays open after a failed attempt so the customer can retry — keep waiting.
    rzp.on('payment.failed', (r) => onFailedAttempt?.(r.error?.description || 'Payment failed'));
    rzp.open();
  });
}
