import { list, del } from '@vercel/blob';

// GET    -> { photos: [{url, pathname, uploadedAt}] }  (newest first)
// DELETE { url }  with header x-admin-key  -> { ok: true }
export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const { blobs } = await list({ prefix: 'wall/', limit: 1000 });
      const photos = blobs
        .map((b) => ({ url: b.url, pathname: b.pathname, uploadedAt: b.uploadedAt }))
        .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ photos });
    } catch (e) { res.status(500).json({ error: 'List failed' }); }
    return;
  }
  if (req.method === 'DELETE') {
    const key = req.headers['x-admin-key'];
    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try {
      const url = (req.body && req.body.url) || '';
      if (!url) { res.status(400).json({ error: 'No url' }); return; }
      await del(url);
      res.status(200).json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Delete failed' }); }
    return;
  }
  res.status(405).json({ error: 'Method not allowed' });
}
