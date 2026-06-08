import { createWorker } from 'tesseract.js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '20mb',
    },
  },
};

// SKU pattern: 2+ uppercase letters/digits, at least one hyphen, 2+ chars after
// Matches patterns like SLV-HBL-LXL, HT-SN-MGN, BFG-LG, GFL-SM, etc.
const SKU_PATTERN = /\b([A-Z0-9]{2,}-[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})*)\b/g;

function extractSkus(text) {
  const upper = text.toUpperCase();
  const matches = [...upper.matchAll(SKU_PATTERN)];
  const skus = [...new Set(matches.map((m) => m[1]))];

  // Filter out common false positives
  const stopWords = new Set(['HTTP', 'HTTPS', 'UTF-8', 'PNG', 'JPG']);
  return skus.filter((s) => !stopWords.has(s));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { images } = req.body;
  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'No images provided' });
  }

  let worker;
  try {
    worker = await createWorker('eng');

    const allSkus = new Set();

    for (const image of images) {
      // tesseract.js accepts base64 data URLs directly
      const { data } = await worker.recognize(image);
      const skus = extractSkus(data.text);
      skus.forEach((s) => allSkus.add(s));
    }

    return res.status(200).json({ skus: [...allSkus] });
  } catch (err) {
    console.error('OCR error', err);
    return res.status(500).json({ error: err.message });
  } finally {
    if (worker) await worker.terminate();
  }
}
