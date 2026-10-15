export const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN')}`;

export const formatLimit = (value) => (value === -1 ? 'Unlimited' : value.toLocaleString('en-IN'));

export async function api(path, body, { method = body ? 'POST' : 'GET', token } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  // When the API is down, the Vite proxy answers 502 with an empty (non-JSON) body.
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Server error (${res.status}) — is the API running on port 5000?`);
  // `data` carries extra details, e.g. { code: 'limit_reached', limit, used } when a plan limit blocks it.
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
  return data;
}
