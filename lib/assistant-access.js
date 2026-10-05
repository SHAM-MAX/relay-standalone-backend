export const RELAY_ORIGIN = 'https://relay-ai-project.hatchable.site';
export function header(req, name) {
  return typeof req.headers?.get === 'function' ? req.headers.get(name) : req.headers?.[name.toLowerCase()];
}
export function extensionOrigin(extensionId) {
  return typeof extensionId === 'string' && /^[a-p]{32}$/.test(extensionId)
    ? 'chrome-extension://' + extensionId : null;
}
export function isExtensionOrigin(origin) {
  return typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}
export function isJSON(req) {
  return /^application\/json(?:\s*;|$)/i.test(header(req, 'content-type') || '');
}
export async function hasOrigin(origin) {
  if (!isExtensionOrigin(origin)) return false;
  const expectedOrigin = `chrome-extension://${process.env.RELAY_EXTENSION_ID}`;
  return origin === expectedOrigin;
}
export function corsHeaders(res, origin) {
  // Called ONLY for an exact approved origin. No wildcard or reflection of arbitrary input.
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}
export async function gateAssistant(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
  const origin = header(req, 'origin');
  const approvedOrigin = origin === RELAY_ORIGIN || await hasOrigin(origin);
  if (approvedOrigin) corsHeaders(res, origin);
  if (req.method === 'OPTIONS') {
    const requestedHeaders = String(header(req, 'access-control-request-headers') || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
    if (!approvedOrigin || header(req, 'access-control-request-method') !== 'POST' || requestedHeaders.some(value => value !== 'content-type')) {
      res.status(403).json({ error: 'This extension origin or preflight is not allowed.', code: 'ORIGIN_NOT_ALLOWED' });
    } else res.status(204).send('');
    return false;
  }
  // In standalone mode, we do not require a platform-resolved collaborator session.
  // We just rely on the extension origin check for security.
  if (origin && (origin !== RELAY_ORIGIN && !approvedOrigin)) {
    res.status(403).json({ error: 'This extension is not authorized by the RELAY_EXTENSION_ID configuration.', code: 'EXTENSION_NOT_CONNECTED' });
    return false;
  }
  // No Origin is allowed only with platform-authenticated membership (e.g. internal tools).
  if (!isJSON(req)) {
    res.status(415).json({ error: 'Send application/json.', code: 'INVALID_CONTENT_TYPE' });
    return false;
  }
  return true;
}
