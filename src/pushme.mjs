function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || 'https://pushme.site').replace(/\/$/, '');
}

async function parseJsonResponse(response, context) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${context} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

export async function registerBotOrg(baseUrl, payload) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/bot/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  return parseJsonResponse(response, 'PushMe bot registration');
}

export async function previewNetnodeCoverage(baseUrl, payload) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/bot/netnode/coverage-preview`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  return parseJsonResponse(response, 'PushMe netnode coverage preview');
}

export async function publishEvent(baseUrl, apiKey, payload) {
  if (!apiKey) {
    throw new Error('Missing PUSHME_API_KEY');
  }
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/bot/publish`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });
  return parseJsonResponse(response, 'PushMe publish');
}
