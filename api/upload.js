import { put } from '@vercel/blob';

// POST { image: "data:image/jpeg;base64,...." }  ->  { url }
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const body = req.body || {};
    const dataUrl = typeof body.image === 'string' ? body.image : '';
    if (!dataUrl.startsWith('data:image/')) { res.status(400).json({ error: 'No image' }); return; }
    const base64 = dataUrl.split(',')[1] || '';
    const buf = Buffer.from(base64, 'base64');
    if (buf.length < 1000 || buf.length > 6 * 1024 * 1024) { res.status(413).json({ error: 'Bad size' }); return; }
    const name = `wall/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const blob = await put(name, buf, { access: 'public', contentType: 'image/jpeg', addRandomSuffix: false });
    res.status(200).json({ url: blob.url });
  } catch (e) {
    res.status(500).json({ error: 'Upload failed' });
  }
}
