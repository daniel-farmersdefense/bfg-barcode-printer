import crypto from 'crypto';

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { message } = req.body;
  const privateKey = process.env.QZ_PRIVATE_KEY;

  if (!privateKey) {
    return res.status(500).json({ error: 'QZ_PRIVATE_KEY not configured' });
  }

  try {
    const sign = crypto.createSign('SHA512');
    sign.update(message);
    const signature = sign.sign(privateKey.replace(/\\n/g, '\n'), 'base64');
    return res.status(200).json({ signature });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
