import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import Head from 'next/head';
import styles from '../styles/Home.module.css';

// SKU pattern — used for direct PDF text extraction
const SKU_PATTERN_CLIENT = /\b([A-Z0-9]{2,}-[A-Z0-9]+(?:-[A-Z0-9]+)*)\b/g;
const STOP_WORDS = new Set(['HTTP', 'HTTPS', 'UTF-8', 'PNG', 'JPG', 'N/A', 'INV', 'SO']);

function isStopWord(sku) {
  if (/^(SO|INV|PO|REF|ORD)-\d+$/.test(sku)) return true;
  if (STOP_WORDS.has(sku)) return true;
  const DESCRIPTION_WORDS = new Set(['SEA-WEED', 'WEAR-HOUSE', 'NET-20', 'NET-45', 'PICK-LIST', 'SHIP-TO', 'BILL-TO', 'WALKER-ST', 'PO-BOX', 'ST-WEAR']);
  if (DESCRIPTION_WORDS.has(sku)) return true;
  if (/^(WALKER|WEAR|HOUSE|PICKING)/.test(sku)) return true;
  return false;
}

function extractSkusFromText(text) {
  const upper = text.toUpperCase();
  const matches = [...upper.matchAll(SKU_PATTERN_CLIENT)]
    .map((m) => m[1])
    .filter((s) => !isStopWord(s));
  const all = [...new Set(matches)];
  return all.filter(
    (sku) => !all.some((other) => other !== sku && other.startsWith(sku + '-'))
  );
}

// ── Packing-slip parser for shipping labels ──────────────────────────────────
function parseShipLines(lines) {
  const after = (idx) => (lines[idx + 1] || '').trim();

  // Ship To block
  let toName = '', toAddress = '', zipCode = '';
  const shipToIdx = lines.findIndex((l) => /^ship\s+to:?$/i.test(l));
  if (shipToIdx >= 0) {
    const addr = [];
    for (let i = shipToIdx + 1; i < Math.min(shipToIdx + 12, lines.length); i++) {
      const l = lines[i];
      if (/^(quote|fulfillment|date|terms|invoice|customer|carrier|tracking|shipment)/i.test(l)) break;
      if (!/^(location\s+id:|dept\s)/i.test(l)) addr.push(l);
    }
    if (addr.length > 0) {
      // First addr line may be "Customer Name 123 Street Rd" combined
      const streetSplit = addr[0].match(/^(.*?)\s+(\d+\s+.+)$/);
      if (streetSplit) {
        toName = streetSplit[1].trim();
        const rest = [streetSplit[2], ...addr.slice(1)];
        const cityLine = rest.find((l) => /\d{5,9}/.test(l)) || '';
        const csz = cityLine.match(/^(.*?)\s+([A-Z]{2})\s+(\d{5,9})/);
        if (csz) {
          toAddress = `${streetSplit[2]}\n${csz[1]} ${csz[2]},\n${csz[3]}\nUSA`;
          zipCode = csz[3];
        } else {
          toAddress = rest.join('\n');
        }
      } else {
        toName = addr[0];
        const cityLine = addr.find((l, i) => i > 0 && /\d{5,9}/.test(l)) || '';
        const csz = cityLine.match(/^(.*?)\s+([A-Z]{2})\s+(\d{5,9})/);
        if (csz) {
          const street = addr[1] || '';
          toAddress = `${street}\n${csz[1]} ${csz[2]},\n${csz[3]}\nUSA`;
          zipCode = csz[3];
        } else {
          toAddress = addr.slice(1).join('\n');
        }
      }
    }
  }

  // Customer Reference → PO #
  const poIdx = lines.findIndex((l) => /^customer\s+reference$/i.test(l));
  const poNumber = poIdx >= 0 ? after(poIdx) : '';

  // Carrier (may be "Carrier:UPS" on one line)
  let carrier = '';
  const carrierLine = lines.find((l) => /^carrier:/i.test(l));
  if (carrierLine) {
    carrier = carrierLine.replace(/^carrier:\s*/i, '').trim();
    if (!carrier) carrier = after(lines.indexOf(carrierLine));
  }

  // Tracking Number → PRO #
  const trackIdx = lines.findIndex((l) => /^tracking\s+number:?$/i.test(l));
  const proNumber = trackIdx >= 0 ? after(trackIdx) : '';

  return { toName, toAddress, zipCode, poNumber, carrier, proNumber };
}

async function extractShipDataFromPdf(file) {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const lines = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) {
      const s = item.str.trim();
      if (s) lines.push(s);
    }
  }
  return parseShipLines(lines);
}

async function extractSkusFromPdf(file) {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let pageText = '';
    let lastNonEmpty = '';
    for (const item of content.items) {
      const s = item.str;
      if (!s) continue;
      const glue = lastNonEmpty.endsWith('-') || s.startsWith('-');
      if (glue) {
        pageText += s;
      } else {
        pageText += (pageText ? ' ' : '') + s;
      }
      lastNonEmpty = s;
    }
    const fixed = pageText.replace(/-\s+([A-Z0-9])/g, '-$1');
    fullText += fixed + '\n';
  }
  return extractSkusFromText(fullText);
}

function parseFilename(filename) {
  const base = filename.replace(/\.png$/i, '');
  const parts = base.match(/^(.*?)\(([^)]+)\)\(([^)]+)\)$/);
  if (parts) return { name: parts[1].trim(), sku: parts[2].trim(), size: parts[3].trim() };
  const fallback = base.match(/^(.*?)\(([^)]+)\)$/);
  if (fallback) return { name: fallback[1].trim(), sku: fallback[2].trim(), size: '' };
  return { name: base, sku: base, size: '' };
}

function matchSku(sku, library) {
  if (!library.length) return null;
  const normalize = (s) => s.toUpperCase().trim();
  const exact = library.find((e) => normalize(e.sku) === normalize(sku));
  if (exact) return exact;
  const segs = (s) => normalize(s).split(/[-_ ]+/).filter(Boolean);
  const querySegs = segs(sku);
  let bestEntry = null;
  let bestScore = -Infinity;
  for (const entry of library) {
    const entrySegs = segs(entry.sku);
    // First segment must match — different product families never share barcodes
    if (!querySegs[0] || !entrySegs[0] || querySegs[0] !== entrySegs[0]) continue;
    let positionalMatches = 0;
    const maxLen = Math.max(querySegs.length, entrySegs.length);
    for (let i = 0; i < maxLen; i++) {
      if (querySegs[i] && entrySegs[i] && querySegs[i] === entrySegs[i]) {
        positionalMatches++;
      }
    }
    const mismatches = maxLen - positionalMatches;
    const score = positionalMatches - mismatches * 0.5;
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }
  // Require at least 2 positional matches to avoid single-segment coincidences
  if (bestScore >= 1.5) return bestEntry;
  return null;
}

// Fixed barcode label dimensions: 2" × 1.5"
const LABEL_W_PX = 192; // 2in at 96dpi
const LABEL_H_PX = 144; // 1.5in at 96dpi

// SVG sign label — auto-stretches each line to fill the width
// unitsPerBox: optional number shown in bottom-right corner box
function SignPreview({ text, width = 576, height = 384, unitsPerBox = '', date = '' }) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const showUnits = String(unitsPerBox).trim() !== '' || String(date).trim() !== '';

  // Bottom strip height — fixed at 20% of total height when showing units
  const stripH = showUnits ? Math.round(height * 0.20) : 0;
  const textH = height - stripH;
  const lineH = textH / lines.length;
  const fontSize = Math.round(lineH * 0.80);
  const pad = Math.round(width * 0.03);

  // Units box: sits in the bottom strip, right-aligned
  const boxW = Math.round(width * 0.28);
  const boxH = Math.round(stripH * 0.80);
  const boxX = width - boxW - Math.round(width * 0.02);
  const boxY = textH + Math.round((stripH - boxH) / 2);
  const boxFontSize = Math.round(boxH * 0.62);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', background: 'white' }}
      overflow="hidden"
    >
      {/* Main text lines */}
      {lines.map((line, i) => (
        <text
          key={i}
          x={width / 2}
          y={Math.round((i + 0.5) * lineH)}
          textAnchor="middle"
          dominantBaseline="central"
          fontWeight="900"
          fontFamily="Arial Black, Arial, sans-serif"
          fontSize={fontSize}
          textLength={width - pad * 2}
          lengthAdjust="spacingAndGlyphs"
          fill="black"
        >
          {line || ' '}
        </text>
      ))}

      {/* Divider line above bottom strip */}
      {showUnits && (
        <line x1={0} y1={textH} x2={width} y2={textH} stroke="#ccc" strokeWidth={1} />
      )}

      {/* Date — bottom left */}
      {showUnits && (
        <text
          x={Math.round(width * 0.03)}
          y={boxY + boxH / 2}
          textAnchor="start"
          dominantBaseline="central"
          fontWeight="700"
          fontFamily="Arial, sans-serif"
          fontSize={boxFontSize}
          fill="black"
        >
          {String(date).trim()}
        </text>
      )}

      {/* Units box — bottom right */}
      {showUnits && (
        <>
          <rect x={boxX} y={boxY} width={boxW} height={boxH} rx={5} ry={5} fill="white" stroke="black" strokeWidth={3} />
          <text
            x={boxX + boxW / 2}
            y={boxY + boxH / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontWeight="900"
            fontFamily="Arial Black, Arial, sans-serif"
            fontSize={boxFontSize}
            fill="black"
          >
            {String(unitsPerBox).trim()}
          </text>
        </>
      )}
    </svg>
  );
}

// ── Shipping label components ─────────────────────────────────────────────────
function ShipBarcode({ value, height = 50 }) {
  const ref = useRef();
  useEffect(() => {
    if (!ref.current || !value) return;
    import('jsbarcode').then(({ default: JsBarcode }) => {
      try {
        JsBarcode(ref.current, value, {
          format: 'CODE128',
          width: 2,
          height,
          displayValue: false,
          margin: 2,
        });
      } catch (_) {}
    });
  }, [value, height]);
  if (!value) return null;
  return <svg ref={ref} style={{ maxWidth: '100%', display: 'block', margin: '0 auto' }} />;
}

const SHIP_FROM = {
  name: "Farmer's Defense",
  street: '201 Walker St',
  city: 'Watsonville',
  stateZip: 'CA 95076',
  country: 'USA',
};

function ShipLabelPreview({ data, cartonNum = 1, cartonTotal = 1, forPrint = false }) {
  const { toName = '', toAddress = '', carrier = '', proNumber = '', poNumber = '', vendorCode = '', zipCode = '' } = data || {};
  const scale = forPrint ? 1 : 0.62;
  const w = Math.round(384 * scale);
  const h = Math.round(576 * scale);
  const fs = (n) => Math.round(n * scale);
  const pad = Math.round(8 * scale);
  const border = '1px solid #000';
  const cell = { padding: pad, boxSizing: 'border-box' };

  return (
    <div className={forPrint ? 'ship-print-label' : ''} style={{
      width: forPrint ? '4in' : w,
      height: forPrint ? '6in' : h,
      border,
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: forPrint ? 11 : fs(11),
      background: 'white',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      boxSizing: 'border-box',
    }}>
      {/* Row 1: From | To */}
      <div style={{ display: 'flex', borderBottom: border, flexShrink: 0 }}>
        <div style={{ ...cell, flex: 1, borderRight: border, lineHeight: 1.4 }}>
          <div style={{ fontWeight: 'bold' }}>From:</div>
          <div>{SHIP_FROM.name}</div>
          <div>{SHIP_FROM.street}</div>
          <div>{SHIP_FROM.city}</div>
          <div>{SHIP_FROM.stateZip}</div>
          <div>{SHIP_FROM.country}</div>
        </div>
        <div style={{ ...cell, flex: 1, lineHeight: 1.4 }}>
          <div style={{ fontWeight: 'bold' }}>To:</div>
          <div style={{ fontWeight: 600 }}>{toName}</div>
          <div style={{ whiteSpace: 'pre-line', fontSize: forPrint ? 10 : fs(10) }}>{toAddress}</div>
        </div>
      </div>

      {/* Row 2: SHIP TO POST barcode | Carrier / PRO # */}
      <div style={{ display: 'flex', borderBottom: border, flexShrink: 0 }}>
        <div style={{ ...cell, flex: 1, borderRight: border }}>
          <div style={{ fontSize: forPrint ? 9 : fs(9) }}>SHIP TO POST</div>
          <ShipBarcode value={zipCode ? `420${zipCode}` : ''} height={forPrint ? 50 : fs(50)} />
          {zipCode && <div style={{ fontSize: forPrint ? 9 : fs(9), textAlign: 'center' }}>(420) {zipCode}</div>}
        </div>
        <div style={{ ...cell, flex: 1 }}>
          {carrier && <div style={{ fontWeight: 'bold' }}>Carrier: {carrier}</div>}
          {proNumber && <div style={{ fontWeight: 'bold' }}>PRO #: {proNumber}</div>}
        </div>
      </div>

      {/* Row 3: Contents / PO # / Vendor # */}
      <div style={{ ...cell, borderBottom: border, flexShrink: 0 }}>
        <div style={{ fontWeight: 'bold' }}>Contents:</div>
        {poNumber && <div style={{ fontWeight: 'bold' }}>PO #: {poNumber}</div>}
        {vendorCode && <div style={{ fontWeight: 'bold' }}>Vendor #: {vendorCode}</div>}
        <div style={{ minHeight: forPrint ? 40 : fs(40) }} />
      </div>

      {/* Row 4: Cartons */}
      <div style={{ display: 'flex', flex: 1 }}>
        <div style={{ ...cell, flex: 1, borderRight: border }} />
        <div style={{ ...cell, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontSize: forPrint ? 9 : fs(9) }}>Cartons #:</div>
          <div>Carton{cartonNum} of {cartonTotal}</div>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [activeTab, setActiveTab] = useState('library');

  // Library state — loaded from server (shared across all users)
  const [library, setLibrary] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const folderInputRef = useRef();

  // Sign tab state
  const [signText, setSignText] = useState('');
  const [signQty, setSignQty] = useState(1);
  const [signUnits, setSignUnits] = useState('');
  const [signDate, setSignDate] = useState(() =>
    new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
  );
  const [printMode, setPrintMode] = useState('barcodes'); // 'barcodes' | 'sign' | 'ship'

  // Vendor codes
  const [vendors, setVendors] = useState([]);

  // Ship label state
  const [shipData, setShipData] = useState({ toName: '', toAddress: '', zipCode: '', poNumber: '', carrier: '', proNumber: '', vendorCode: '' });
  const [shipCartons, setShipCartons] = useState(1);
  const [shipScanning, setShipScanning] = useState(false);
  const [shipError, setShipError] = useState('');
  const [shipDropActive, setShipDropActive] = useState(false);
  const [vendorName, setVendorName] = useState('');
  const [vendorCode, setVendorCode] = useState('');
  const [vendorSaving, setVendorSaving] = useState(false);
  const shipFileInputRef = useRef();

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Fetch shared library and vendors on mount
  useEffect(() => {
    fetchLibrary();
    fetchVendors();
  }, []);

  async function fetchVendors() {
    try {
      const res = await fetch('/api/vendors');
      const data = await res.json();
      if (res.ok) setVendors(data.vendors || []);
    } catch (_) {}
  }

  async function handleShipPdf(file) {
    setShipScanning(true);
    setShipError('');
    try {
      const [extracted, vendorRes] = await Promise.all([
        extractShipDataFromPdf(file),
        fetch('/api/vendors'),
      ]);
      const vData = vendorRes.ok ? await vendorRes.json() : { vendors: [] };
      const freshVendors = vData.vendors || [];
      setVendors(freshVendors);

      // Match by any significant word (3+ chars) from the vendor name appearing in the customer name
      const words = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 2);
      const customerWords = new Set(words(extracted.toName || ''));
      const matched = freshVendors.find((v) => words(v.customerName).some((vw) => customerWords.has(vw)));
      setShipData({ ...extracted, vendorCode: matched ? matched.vendorCode : '' });
    } catch (err) {
      setShipError(`Could not read PDF: ${err.message}`);
    } finally {
      setShipScanning(false);
    }
  }

  async function saveVendor() {
    if (!vendorName.trim() || !vendorCode.trim()) return;
    setVendorSaving(true);
    try {
      const res = await fetch('/api/vendors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerName: vendorName.trim(), vendorCode: vendorCode.trim() }),
      });
      const data = await res.json();
      if (res.ok) { setVendors(data.vendors || []); setVendorName(''); setVendorCode(''); }
    } catch (_) {}
    setVendorSaving(false);
  }

  async function deleteVendor(customerName) {
    try {
      const res = await fetch('/api/vendors', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerName }),
      });
      const data = await res.json();
      if (res.ok) setVendors(data.vendors || []);
    } catch (_) {}
  }

  async function fetchLibrary() {
    setLibraryLoading(true);
    setLibraryError('');
    try {
      const res = await fetch('/api/library');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load library');
      setLibrary(data.items || []);
    } catch (err) {
      setLibraryError(err.message);
    } finally {
      setLibraryLoading(false);
    }
  }

  // Upload folder to shared server storage
  const handleFolderSelect = useCallback(async (e) => {
    const files = Array.from(e.target.files).filter((f) =>
      f.name.toLowerCase().endsWith('.png')
    );
    if (!files.length) return;

    setUploading(true);
    setUploadProgress(`Uploading 0 / ${files.length}…`);
    setLibraryError('');

    try {
      // Read all files as dataUrls
      const fileData = await Promise.all(
        files.map(
          (file) =>
            new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = (ev) =>
                resolve({ filename: file.name, dataUrl: ev.target.result });
              reader.readAsDataURL(file);
            })
        )
      );

      // Upload in batches of 10 to avoid huge request bodies
      const BATCH = 10;
      let done = 0;
      for (let i = 0; i < fileData.length; i += BATCH) {
        const batch = fileData.slice(i, i + BATCH);
        const res = await fetch('/api/library', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: batch }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        done += batch.length;
        setUploadProgress(`Uploaded ${done} / ${files.length}…`);
      }

      setUploadProgress('');
      // Refresh library so all users see the new files
      await fetchLibrary();
    } catch (err) {
      setLibraryError(err.message);
      setUploadProgress('');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }, []);

  // Order state
  const [skus, setSkus] = useState([]);
  const [screenshots, setScreenshots] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanQueue, setScanQueue] = useState([]);
  const [manualSku, setManualSku] = useState('');
  const [dropActive, setDropActive] = useState(false);
  const orderDropRef = useRef();
  const orderFileInputRef = useRef();

  const handleOrderDrop = useCallback(
    async (e) => {
      e.preventDefault();
      setDropActive(false);
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith('image/') || f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
      );
      if (!files.length) return;
      await processOrderImages(files);
    },
    [skus]
  );

  const handleOrderFileInput = useCallback(
    async (e) => {
      const files = Array.from(e.target.files).filter((f) =>
        f.type.startsWith('image/') || f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
      );
      if (!files.length) return;
      await processOrderImages(files);
      e.target.value = '';
    },
    [skus]
  );

  async function processOrderImages(files) {
    const pdfSkus = [];
    const imageFiles = [];
    for (const f of files) {
      if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        try {
          setScanQueue((prev) => [...prev, f.name]);
          setScanning(true);
          setScanError('');
          const extracted = await extractSkusFromPdf(f);
          pdfSkus.push(...extracted);
          setScreenshots((prev) => [...prev, { name: f.name, dataUrl: null }]);
          setScanQueue((prev) => prev.filter((n) => n !== f.name));
          if (extracted.length === 0) {
            setScanError(`No SKUs found in "${f.name}". Try adding them manually.`);
          }
        } catch (err) {
          setScanError(`Could not read PDF "${f.name}": ${err.message}`);
          setScanQueue((prev) => prev.filter((n) => n !== f.name));
        }
      } else {
        imageFiles.push(f);
      }
    }
    if (pdfSkus.length > 0) {
      setSkus((prev) => {
        const merged = [...prev];
        for (const sku of pdfSkus) {
          if (!merged.some((s) => s.toLowerCase() === sku.toLowerCase())) merged.push(sku);
        }
        return merged;
      });
      setScanning(false);
    }
    const expanded = [];
    for (const f of imageFiles) {
      await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          expanded.push({ name: f.name, dataUrl: ev.target.result });
          resolve();
        };
        reader.readAsDataURL(f);
      });
    }
    if (expanded.length === 0) { setScanning(false); return; }
    setScreenshots((prev) => [...prev, ...expanded]);
    setScanQueue((prev) => [...prev, ...expanded.map((s) => s.name)]);
    setScanning(true);
    setScanError('');
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: expanded.map((s) => s.dataUrl) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Scan failed');
      const newSkus = data.skus ?? [];
      if (newSkus.length === 0) setScanError('No SKUs found. Try adding them manually below.');
      setSkus((prev) => {
        const merged = [...prev];
        for (const sku of newSkus) {
          if (!merged.some((s) => s.toLowerCase() === sku.toLowerCase())) merged.push(sku);
        }
        return merged;
      });
    } catch (err) {
      setScanError(`Error: ${err.message}`);
    } finally {
      setScanQueue((prev) => prev.filter((n) => !expanded.some((s) => s.name === n)));
      setScanning(false);
    }
  }

  function addManualSku() {
    const trimmed = manualSku.trim().toUpperCase();
    if (!trimmed) return;
    setSkus((prev) => {
      if (prev.some((s) => s.toLowerCase() === trimmed.toLowerCase())) return prev;
      return [...prev, trimmed];
    });
    setManualSku('');
  }

  function removeSku(sku) { setSkus((prev) => prev.filter((s) => s !== sku)); }
  function removeScreenshot(idx) { setScreenshots((prev) => prev.filter((_, i) => i !== idx)); }

  const matchedLabels = skus.map((sku) => ({ sku, match: matchSku(sku, library) }));

  function handlePrint(mode = 'barcodes') {
    // Inject/update @page size so each print mode uses the right paper dimensions
    let styleEl = document.getElementById('dynamic-print-page');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'dynamic-print-page';
      document.head.appendChild(styleEl);
    }
    if (mode === 'sign') {
      styleEl.textContent = '@media print { @page { size: 6in 4in; margin: 0; } }';
    } else if (mode === 'ship') {
      styleEl.textContent = '@media print { @page { size: 4in 6in; margin: 0; } }';
    } else {
      styleEl.textContent = '@media print { @page { size: 2in 1.5in; margin: 0; } }';
    }
    setPrintMode(mode);
    // Give React one tick to update the portal before printing
    setTimeout(() => window.print(), 60);
  }

  // Print portal — renders at body level, shown only during print
  const printContent = (
    <div id="print-portal" style={{ display: 'none', margin: 0, padding: 0, background: 'white' }}>
      {printMode === 'ship' ? (
        Array.from({ length: shipCartons }, (_, i) => (
          <ShipLabelPreview key={i} data={shipData} cartonNum={i + 1} cartonTotal={shipCartons} forPrint />
        ))
      ) : printMode === 'sign' ? (
        Array.from({ length: signQty }, (_, i) => (
          <div key={i} className="sign-print-label">
            <SignPreview text={signText} width={576} height={384} unitsPerBox={signUnits} date={signDate} />
          </div>
        ))
      ) : (
        matchedLabels.map(({ sku, match }) => (
          <div key={sku} className="print-label">
            {match ? (
              <>
                <img src={match.dataUrl} alt={match.sku} className="print-label-img" />
                <div className="print-label-sku">{match.sku}</div>
                {match.name && <div className="print-label-name">{match.name}</div>}
                {match.size && <div className="print-label-name">{match.size}</div>}
              </>
            ) : (
              <>
                <div className="print-label-warn">⚠ No barcode found</div>
                <div className="print-label-sku">{sku}</div>
              </>
            )}
          </div>
        ))
      )}
    </div>
  );

  return (
    <>
      <Head>
        <title>BFG Barcode Printer</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className={styles.container}>
        <header className={`${styles.header} ${styles.noPrint}`}>
          <span className={styles.headerTitle}>BFG Barcode Printer</span>
          <span className={styles.headerSub}>Warehouse Label Tool</span>
        </header>

        <nav className={`${styles.tabs} ${styles.noPrint}`}>
          {[
            { id: 'library', label: `Library${library.length ? ` (${library.length})` : ''}` },
            { id: 'order', label: `Order${skus.length ? ` (${skus.length})` : ''}` },
            { id: 'print', label: `Print${matchedLabels.length ? ` (${matchedLabels.length})` : ''}` },
            { id: 'sign', label: 'Sign Label' },
            { id: 'ship', label: 'Ship Label' },
          ].map((t) => (
            <button
              key={t.id}
              className={`${styles.tab} ${activeTab === t.id ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className={`${styles.content} ${styles.noPrint}`}>

          {/* ══════════ LIBRARY TAB ══════════ */}
          {activeTab === 'library' && (
            <div>
              <div className={styles.card}>
                <div className={styles.cardTitle}>Shared Barcode Library</div>
                <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 14 }}>
                  Upload PNG barcode files — visible to everyone on all workstations.<br />
                  Filenames must follow:{' '}
                  <code style={{ fontFamily: 'var(--font-mono)', background: '#f1f0ed', padding: '2px 6px', borderRadius: 3, fontSize: 12 }}>
                    Product Name(SKU-CODE)(SIZE).png
                  </code>
                </p>
                <input
                  ref={folderInputRef}
                  type="file"
                  accept=".png"
                  multiple
                  webkitdirectory=""
                  style={{ display: 'none' }}
                  onChange={handleFolderSelect}
                />
                <div className={styles.row}>
                  <button
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => folderInputRef.current?.click()}
                    disabled={uploading}
                  >
                    {uploading ? 'Uploading…' : 'Upload Folder'}
                  </button>
                  <button
                    className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`}
                    onClick={fetchLibrary}
                    disabled={libraryLoading}
                    title="Reload library from server"
                  >
                    {libraryLoading ? '…' : '↻ Refresh'}
                  </button>
                  {library.length > 0 && (
                    <span className={`${styles.badge} ${styles.badgeGreen}`}>
                      {library.length} barcodes
                    </span>
                  )}
                </div>
                {uploadProgress && (
                  <div style={{ marginTop: 10, fontSize: 13, color: 'var(--color-accent)' }}>
                    {uploadProgress}
                  </div>
                )}
                {libraryError && (
                  <div style={{ marginTop: 10, padding: '10px 14px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 5, fontSize: 13, color: '#991b1b' }}>
                    {libraryError}
                  </div>
                )}
              </div>

              {libraryLoading && (
                <div className={styles.emptyState}>
                  <div className={styles.spinner} style={{ margin: '0 auto 12px' }} />
                  <div className={styles.emptyStateText}>Loading library…</div>
                </div>
              )}

              {!libraryLoading && library.length > 0 && (
                <div className={styles.card}>
                  <div className={styles.cardTitle}>Loaded Barcodes</div>
                  <div className={styles.libraryGrid}>
                    {library.map((entry) => (
                      <div key={entry.filename} className={styles.libraryItem}>
                        <img src={entry.dataUrl} alt={entry.sku} className={styles.libraryBarcode} />
                        <div className={styles.libraryItemSku}>{entry.sku}</div>
                        {entry.size && <div className={styles.libraryItemName}>{entry.size}</div>}
                        {entry.name && <div className={styles.libraryItemName}>{entry.name}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!libraryLoading && library.length === 0 && !libraryError && (
                <div className={styles.emptyState}>
                  <div className={styles.emptyStateTitle}>No barcodes in library</div>
                  <div className={styles.emptyStateText}>
                    Upload a folder of PNG barcode files to get started. Everyone will see them.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══════════ ORDER TAB ══════════ */}
          {activeTab === 'order' && (
            <div>
              <div className={styles.card}>
                <div className={styles.cardTitle}>Drop Order Files</div>
                <div
                  className={`${styles.dropZone} ${dropActive ? styles.dropZoneActive : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDropActive(true); }}
                  onDragLeave={() => setDropActive(false)}
                  onDrop={handleOrderDrop}
                  onClick={() => orderFileInputRef.current?.click()}
                >
                  <div className={styles.dropZoneText}>
                    {scanning ? 'Scanning…' : 'Drop order screenshots / PDFs here or click to browse'}
                  </div>
                  <div className={styles.dropZoneHint}>
                    Recommended: PDF pick lists — SKUs extracted automatically
                  </div>
                  {scanning && <div className={styles.spinner} style={{ margin: '10px auto 0' }} />}
                </div>
                <input
                  ref={orderFileInputRef}
                  type="file"
                  accept="image/*,.pdf"
                  multiple
                  style={{ display: 'none' }}
                  onChange={handleOrderFileInput}
                />

                {scanQueue.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    {scanQueue.map((name) => (
                      <div key={name} className={styles.scanQueueItem}>
                        <div className={styles.spinner} />
                        <span className={styles.scanQueueItemName}>{name}</span>
                        <span className={`${styles.badge} ${styles.badgeBlue}`}>scanning</span>
                      </div>
                    ))}
                  </div>
                )}

                {scanError && (
                  <div style={{ marginTop: 12, padding: '10px 14px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 5, fontSize: 13, color: '#991b1b' }}>
                    {scanError}
                  </div>
                )}

                {screenshots.length > 0 && (
                  <div>
                    <div className={styles.divider} />
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                      {screenshots.length} file{screenshots.length !== 1 ? 's' : ''} processed
                    </div>
                    <div className={styles.screenshotList}>
                      {screenshots.map((s, idx) => (
                        <div key={idx} className={styles.screenshotThumb}>
                          {s.dataUrl && <img src={s.dataUrl} alt={s.name} />}
                          {!s.dataUrl && <span style={{ fontSize: 11, padding: 4 }}>{s.name}</span>}
                          <button className={styles.screenshotThumbRemove} onClick={() => removeScreenshot(idx)} title="Remove">×</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className={styles.card}>
                <div className={styles.cardTitle}>Manual SKU Entry</div>
                <div className={styles.manualInput}>
                  <input
                    type="text"
                    className={styles.input}
                    placeholder="Type a SKU and press Enter or Add"
                    value={manualSku}
                    onChange={(e) => setManualSku(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addManualSku()}
                  />
                  <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={addManualSku}>Add</button>
                </div>
              </div>

              <div className={styles.card}>
                <div className={styles.row} style={{ marginBottom: 4 }}>
                  <div className={styles.cardTitle} style={{ margin: 0 }}>Extracted SKUs</div>
                  <div className={styles.spacer} />
                  {skus.length > 0 && (
                    <button className={`${styles.btn} ${styles.btnDanger} ${styles.btnSm}`} onClick={() => setSkus([])}>
                      Clear All
                    </button>
                  )}
                </div>
                {skus.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--color-text-muted)', paddingTop: 8 }}>
                    No SKUs yet. Drop files or type manually above.
                  </div>
                ) : (
                  <div className={styles.skuList}>
                    {skus.map((sku) => {
                      const match = matchSku(sku, library);
                      return (
                        <span key={sku} className={styles.skuChip}>
                          {sku}
                          {match ? (
                            <span className={`${styles.badge} ${styles.badgeGreen}`} style={{ fontSize: 10, padding: '1px 5px' }}>✓</span>
                          ) : library.length > 0 ? (
                            <span className={`${styles.badge} ${styles.badgeRed}`} style={{ fontSize: 10, padding: '1px 5px' }}>?</span>
                          ) : null}
                          <button className={styles.skuChipRemove} onClick={() => removeSku(sku)} title="Remove">×</button>
                        </span>
                      );
                    })}
                  </div>
                )}
                {skus.length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setActiveTab('print')}>
                      Go to Print →
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ══════════ PRINT TAB ══════════ */}
          {activeTab === 'print' && (
            <div>
              <div className={`${styles.card} ${styles.noPrint}`}>
                <div className={styles.row} style={{ alignItems: 'center', gap: 16 }}>
                  <div>
                    <div className={styles.cardTitle} style={{ margin: 0 }}>Print Labels</div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                      Label size: 2" × 1.5" (fixed)
                    </div>
                  </div>
                  <div className={styles.spacer} />
                  <button
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={handlePrint}
                    disabled={matchedLabels.length === 0}
                  >
                    Print Labels
                  </button>
                </div>
                {matchedLabels.length > 0 && (
                  <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-muted)' }}>
                    {matchedLabels.filter((l) => l.match).length} of {matchedLabels.length} SKUs matched
                    {matchedLabels.some((l) => !l.match) && (
                      <span style={{ color: 'var(--color-danger)', marginLeft: 8 }}>
                        — {matchedLabels.filter((l) => !l.match).length} unmatched (yellow background)
                      </span>
                    )}
                  </div>
                )}
              </div>

              {matchedLabels.length === 0 ? (
                <div className={`${styles.emptyState} ${styles.noPrint}`}>
                  <div className={styles.emptyStateTitle}>No SKUs to print</div>
                  <div className={styles.emptyStateText}>Go to the Order tab and extract some SKUs first.</div>
                  <button className={`${styles.btn} ${styles.btnPrimary}`} style={{ marginTop: 16 }} onClick={() => setActiveTab('order')}>
                    Go to Order
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {matchedLabels.map(({ sku, match }) => (
                    <div
                      key={sku}
                      className={`${styles.label} ${!match ? styles.labelNoMatch : ''}`}
                      style={{ width: LABEL_W_PX, height: LABEL_H_PX }}
                    >
                      {match ? (
                        <>
                          <img src={match.dataUrl} alt={match.sku} className={styles.labelBarcode} />
                          <div className={styles.labelSku}>{match.sku}</div>
                          {match.name && <div className={styles.labelName}>{match.name}</div>}
                          {match.size && <div className={styles.labelName}>{match.size}</div>}
                        </>
                      ) : (
                        <>
                          <div className={styles.labelNoMatchText}>⚠ No barcode found</div>
                          <div className={styles.labelSku} style={{ marginTop: 6 }}>{sku}</div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* ══════════ SIGN LABEL TAB ══════════ */}
          {activeTab === 'sign' && (
            <div>
              <div className={styles.card}>
                <div className={styles.cardTitle}>Shelf Sign Label</div>
                <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 14 }}>
                  Type what you want on the label. Each line prints as its own row — text auto-sizes to fill the label.
                  Prints on a <strong>4" × 6" landscape</strong> label.
                </p>
                <textarea
                  className={styles.input}
                  rows={3}
                  placeholder={'MON\nor\nUVH-W-MON\nMEDIUM'}
                  value={signText}
                  onChange={(e) => setSignText(e.target.value.toUpperCase())}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, letterSpacing: 1, resize: 'vertical', textTransform: 'uppercase' }}
                />
                <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <label style={{ fontSize: 13, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                      # of Labels
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={signQty}
                      onChange={(e) => setSignQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
                      className={styles.input}
                      style={{ width: 70, textAlign: 'center', fontSize: 16, fontWeight: 700 }}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <label style={{ fontSize: 13, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>Date</label>
                    <input
                      type="text"
                      value={signDate}
                      onChange={(e) => setSignDate(e.target.value)}
                      className={styles.input}
                      style={{ width: 110, textAlign: 'center', fontSize: 13, fontWeight: 600 }}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <label style={{ fontSize: 13, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                      Units / Box
                    </label>
                    <input
                      type="text"
                      placeholder="70"
                      value={signUnits}
                      onChange={(e) => setSignUnits(e.target.value)}
                      className={styles.input}
                      style={{ width: 80, textAlign: 'center', fontSize: 16, fontWeight: 700 }}
                    />
                  </div>
                  <button
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => handlePrint('sign')}
                    disabled={!signText.trim()}
                  >
                    Print {signQty > 1 ? `${signQty} Labels` : 'Label'}
                  </button>
                  {signText.trim() && (
                    <button
                      className={`${styles.btn} ${styles.btnDanger} ${styles.btnSm}`}
                      onClick={() => setSignText('')}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Live preview */}
              {signText.trim() && (
                <div className={styles.card}>
                  <div className={styles.cardTitle}>Preview — 4" × 6" Landscape</div>
                  <div style={{
                    border: '2px solid var(--color-border)',
                    borderRadius: 6,
                    overflow: 'hidden',
                    display: 'inline-block',
                    width: '100%',
                    maxWidth: 480,
                  }}>
                    <SignPreview text={signText} width={480} height={320} unitsPerBox={signUnits} date={signDate} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══════════ SHIP LABEL TAB ══════════ */}
          {activeTab === 'ship' && (
            <div>
              <div className={styles.card}>
                <div className={styles.cardTitle}>Outgoing Shipment Label</div>
                <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 14 }}>
                  Drop the packing slip PDF — fields are extracted automatically. Adjust anything before printing.
                </p>

                {/* Drop zone */}
                <div
                  className={`${styles.dropZone} ${shipDropActive ? styles.dropZoneActive : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setShipDropActive(true); }}
                  onDragLeave={() => setShipDropActive(false)}
                  onDrop={async (e) => {
                    e.preventDefault(); setShipDropActive(false);
                    const file = Array.from(e.dataTransfer.files).find((f) => f.name.toLowerCase().endsWith('.pdf'));
                    if (file) await handleShipPdf(file);
                  }}
                  onClick={() => shipFileInputRef.current?.click()}
                >
                  <div className={styles.dropZoneText}>
                    {shipScanning ? 'Reading packing slip…' : 'Drop packing slip PDF here or click to browse'}
                  </div>
                  {shipScanning && <div className={styles.spinner} style={{ margin: '10px auto 0' }} />}
                </div>
                <input ref={shipFileInputRef} type="file" accept=".pdf" style={{ display: 'none' }}
                  onChange={async (e) => {
                    const file = e.target.files[0];
                    if (file) await handleShipPdf(file);
                    e.target.value = '';
                  }}
                />
                {shipError && (
                  <div style={{ marginTop: 10, padding: '10px 14px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 5, fontSize: 13, color: '#991b1b' }}>
                    {shipError}
                  </div>
                )}
              </div>

              {/* Editable fields */}
              <div className={styles.card}>
                <div className={styles.cardTitle}>Label Fields</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {[
                    { label: 'To (Customer Name)', key: 'toName' },
                    { label: 'PO #', key: 'poNumber' },
                    { label: 'Carrier', key: 'carrier' },
                    { label: 'PRO # / Tracking', key: 'proNumber' },
                    { label: 'Zip Code (for barcode)', key: 'zipCode' },
                    { label: 'Vendor #', key: 'vendorCode' },
                  ].map(({ label, key }) => (
                    <div key={key}>
                      <label style={{ fontSize: 12, color: 'var(--color-text-muted)', display: 'block', marginBottom: 4 }}>{label}</label>
                      <input
                        type="text"
                        className={styles.input}
                        value={shipData[key] || ''}
                        onChange={(e) => setShipData((d) => ({ ...d, [key]: e.target.value }))}
                        style={{ width: '100%' }}
                      />
                    </div>
                  ))}
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={{ fontSize: 12, color: 'var(--color-text-muted)', display: 'block', marginBottom: 4 }}>To (Address)</label>
                    <textarea
                      className={styles.input}
                      rows={4}
                      value={shipData.toAddress || ''}
                      onChange={(e) => setShipData((d) => ({ ...d, toAddress: e.target.value }))}
                      style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                    />
                  </div>
                </div>

                {/* Cartons + Print */}
                <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <label style={{ fontSize: 13, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}># of Cartons</label>
                    <input
                      type="number" min={1} max={99}
                      value={shipCartons}
                      onChange={(e) => setShipCartons(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
                      className={styles.input}
                      style={{ width: 70, textAlign: 'center', fontSize: 16, fontWeight: 700 }}
                    />
                  </div>
                  <button
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => handlePrint('ship')}
                    disabled={!shipData.toName && !shipData.poNumber}
                  >
                    Print {shipCartons > 1 ? `${shipCartons} Labels` : 'Label'}
                  </button>
                  <button
                    className={`${styles.btn} ${styles.btnDanger} ${styles.btnSm}`}
                    onClick={() => { setShipData({ toName: '', toAddress: '', zipCode: '', poNumber: '', carrier: '', proNumber: '', vendorCode: '' }); setShipCartons(1); }}
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* Live preview */}
              {(shipData.toName || shipData.poNumber) && (
                <div className={styles.card}>
                  <div className={styles.cardTitle}>Preview — 4" × 6" Label (Carton 1 of {shipCartons})</div>
                  <div style={{ display: 'inline-block', border: '2px solid var(--color-border)', borderRadius: 4, overflow: 'hidden' }}>
                    <ShipLabelPreview data={shipData} cartonNum={1} cartonTotal={shipCartons} />
                  </div>
                </div>
              )}

              {/* Vendor code management */}
              <div className={styles.card}>
                <div className={styles.cardTitle}>Vendor Codes</div>
                <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 14 }}>
                  When a packing slip is loaded, the customer name is matched here to auto-fill the Vendor # field.
                </p>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  <input
                    type="text" placeholder="Customer name (e.g. ACE Hardware)"
                    className={styles.input}
                    value={vendorName}
                    onChange={(e) => setVendorName(e.target.value)}
                    style={{ flex: 2, minWidth: 160 }}
                  />
                  <input
                    type="text" placeholder="Vendor #"
                    className={styles.input}
                    value={vendorCode}
                    onChange={(e) => setVendorCode(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveVendor()}
                    style={{ flex: 1, minWidth: 80 }}
                  />
                  <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={saveVendor} disabled={vendorSaving || !vendorName.trim() || !vendorCode.trim()}>
                    {vendorSaving ? 'Saving…' : 'Save'}
                  </button>
                </div>
                {vendors.length > 0 && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                        <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--color-text-muted)', fontWeight: 600 }}>Customer</th>
                        <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--color-text-muted)', fontWeight: 600 }}>Vendor #</th>
                        <th style={{ width: 40 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {vendors.map((v) => (
                        <tr key={v.customerName} style={{ borderBottom: '1px solid var(--color-border)' }}>
                          <td style={{ padding: '6px 8px' }}>{v.customerName}</td>
                          <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{v.vendorCode}</td>
                          <td style={{ padding: '6px 8px' }}>
                            <button className={`${styles.btn} ${styles.btnDanger} ${styles.btnSm}`} onClick={() => deleteVendor(v.customerName)}>×</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

        </div>
      </div>

      {mounted && createPortal(printContent, document.body)}
    </>
  );
}
