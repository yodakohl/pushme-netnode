export async function publishEvent(baseUrl, apiKey, payload) {
  if (!apiKey) {
    throw new Error('Missing PUSHME_API_KEY');
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/bot/publish`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`PushMe publish failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

