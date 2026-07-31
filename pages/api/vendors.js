import { createClient } from '@supabase/supabase-js';

const BUCKET = 'barcodes';
const FILE = '__vendors.json';

const SEED = [
  { customerName: 'ACE Hardware', vendorCode: '62716' },
  { customerName: 'Do It Best', vendorCode: '0026' },
];

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  return createClient(url, key);
}

async function readVendors(supabase) {
  const { data, error } = await supabase.storage.from(BUCKET).download(FILE);
  if (error) return [...SEED];
  try {
    const text = await data.text();
    const parsed = JSON.parse(text);
    return parsed.length > 0 ? parsed : [...SEED];
  } catch {
    return [...SEED];
  }
}

async function writeVendors(supabase, vendors) {
  const buf = Buffer.from(JSON.stringify(vendors, null, 2));
  const { error } = await supabase.storage.from(BUCKET).upload(FILE, buf, {
    contentType: 'application/json',
    upsert: true,
  });
  if (error) throw error;
}

export default async function handler(req, res) {
  let supabase;
  try { supabase = getSupabase(); } catch (e) { return res.status(500).json({ error: e.message }); }

  if (req.method === 'GET') {
    const vendors = await readVendors(supabase);
    return res.status(200).json({ vendors });
  }

  if (req.method === 'POST') {
    const { customerName, vendorCode } = req.body || {};
    if (!customerName || !vendorCode) return res.status(400).json({ error: 'customerName and vendorCode required' });
    const vendors = await readVendors(supabase);
    const idx = vendors.findIndex((v) => v.customerName.toLowerCase() === customerName.toLowerCase());
    if (idx >= 0) vendors[idx] = { customerName, vendorCode };
    else vendors.push({ customerName, vendorCode });
    vendors.sort((a, b) => a.customerName.localeCompare(b.customerName));
    await writeVendors(supabase, vendors);
    return res.status(200).json({ vendors });
  }

  if (req.method === 'DELETE') {
    const { customerName } = req.body || {};
    if (!customerName) return res.status(400).json({ error: 'customerName required' });
    const vendors = await readVendors(supabase);
    const filtered = vendors.filter((v) => v.customerName.toLowerCase() !== customerName.toLowerCase());
    await writeVendors(supabase, filtered);
    return res.status(200).json({ vendors: filtered });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
