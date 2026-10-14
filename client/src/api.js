export const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN')}`;

export async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  // When the API is down, the Vite proxy answers 502 with an empty (non-JSON) body.
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Server error (${res.status}) — is the API running on port 5000?`);
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
}
