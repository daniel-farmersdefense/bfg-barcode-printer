export const config = {
  api: {
    bodyParser: {
      sizeLimit: '20mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { images } = req.body;
  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'No images provided' });
  }

  // OCR via tesseract for image files
  const { createWorker } = await import('tesseract.js');
  const SKU_PATTERN = /\b([A-Z0-9]{2,}-[A-Z0-9]+(?:-[A-Z0-9]+)*)\b/g;
  const STOP_WORDS = new Set(['HTTP', 'HTTPS', 'UTF-8', 'PNG', 'JPG']);

  function extractSkus(text) {
    const upper = text.toUpperCase();
    const matches = [...upper.matchAll(SKU_PATTERN)];
    return [...new Set(matches.map((m) => m[1]).filter((s) => !STOP_WORDS.has(s)))];
  }

  let worker;
  try {
    worker = await createWorker('eng');
    const allSkus = new Set();
    for (const image of images) {
      const { data } = await worker.recognize(image);
      extractSkus(data.text).forEach((s) => allSkus.add(s));
    }
    return res.status(200).json({ skus: [...allSkus] });
  } catch (err) {
    console.error('OCR error', err);
    return res.status(500).json({ error: err.message });
  } finally {
    if (worker) await worker.terminate();
  }
}
