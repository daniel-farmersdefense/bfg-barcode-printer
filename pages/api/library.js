import { put, list, del } from '@vercel/blob';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '100mb',
    },
  },
};

function parseFilename(filename) {
  const base = filename.replace(/\.png$/i, '');
  const parts = base.match(/^(.*?)\(([^)]+)\)\(([^)]+)\)$/);
  if (parts) {
    return { name: parts[1].trim(), sku: parts[2].trim(), size: parts[3].trim() };
  }
  const fallback = base.match(/^(.*?)\(([^)]+)\)$/);
  if (fallback) {
    return { name: fallback[1].trim(), sku: fallback[2].trim(), size: '' };
  }
  return { name: base, sku: base, size: '' };
}

export default async function handler(req, res) {
  // GET — return current library list
  if (req.method === 'GET') {
    try {
      const { blobs } = await list({ prefix: 'barcodes/' });
      const items = blobs.map((blob) => {
        const filename = blob.pathname.replace('barcodes/', '');
        const parsed = parseFilename(filename);
        return {
          filename,
          dataUrl: blob.url,
          sku: parsed.sku,
          name: parsed.name,
          size: parsed.size,
        };
      });
      items.sort((a, b) => a.sku.localeCompare(b.sku));
      return res.status(200).json({ items });
    } catch (err) {
      console.error('Library list error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — upload one or more PNG files
  if (req.method === 'POST') {
    const { files } = req.body; // [{filename, dataUrl}]
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }
    try {
      const results = [];
      for (const { filename, dataUrl } of files) {
        const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        const blob = await put(`barcodes/${filename}`, buffer, {
          access: 'public',
          contentType: 'image/png',
          addRandomSuffix: false,
          allowOverwrite: true,
        });
        results.push({ filename, url: blob.url });
      }
      return res.status(200).json({ uploaded: results.length });
    } catch (err) {
      console.error('Library upload error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE — remove a single file
  if (req.method === 'DELETE') {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    try {
      await del(url);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
