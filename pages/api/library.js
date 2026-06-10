import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '100mb',
    },
  },
};

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in environment variables');
  return createClient(url, key);
}

function parseFilename(filename) {
  const base = filename.replace(/\.png$/i, '');
  const parts = base.match(/^(.*?)\(([^)]+)\)\(([^)]+)\)$/);
  if (parts) return { name: parts[1].trim(), sku: parts[2].trim(), size: parts[3].trim() };
  const fallback = base.match(/^(.*?)\(([^)]+)\)$/);
  if (fallback) return { name: fallback[1].trim(), sku: fallback[2].trim(), size: '' };
  return { name: base, sku: base, size: '' };
}

const BUCKET = 'barcodes';

export default async function handler(req, res) {
  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // GET — list all barcodes
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase.storage.from(BUCKET).list('', { limit: 1000 });
      if (error) throw error;

      const items = (data || [])
        .filter((f) => f.name.toLowerCase().endsWith('.png'))
        .map((f) => {
          const parsed = parseFilename(f.name);
          const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(f.name);
          return {
            filename: f.name,
            dataUrl: urlData.publicUrl,
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

  // POST — upload files
  if (req.method === 'POST') {
    const { files } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }
    try {
      for (const { filename, dataUrl } of files) {
        const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        const { error } = await supabase.storage
          .from(BUCKET)
          .upload(filename, buffer, {
            contentType: 'image/png',
            upsert: true,
          });
        if (error) throw error;
      }
      return res.status(200).json({ uploaded: files.length });
    } catch (err) {
      console.error('Library upload error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE — remove a file
  if (req.method === 'DELETE') {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'Missing filename' });
    try {
      const { error } = await supabase.storage.from(BUCKET).remove([filename]);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
