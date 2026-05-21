import { app } from './_lib/bundle.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    const protocol = req.headers['x-forwarded-proto'] ?? 'https';
    const host = req.headers.host ?? 'localhost';
    const url = `${protocol}://${host}${req.url}`;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
      else if (v != null) headers.set(k, String(v));
    }

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
    }

    const request = new Request(url, { method: req.method, headers, body });
    const response = await app.fetch(request);

    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const ab = await response.arrayBuffer();
    res.end(Buffer.from(ab));
  } catch (err) {
    console.error('[api/index] handler error:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
  }
}
