import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import Head from 'next/head';
import Fuse from 'fuse.js';
import styles from '../styles/Home.module.css';

// SKU pattern (same as server) — used for direct PDF text extraction
const SKU_PATTERN_CLIENT = /\b([A-Z0-9]{2,}-[A-Z0-9]+(?:-[A-Z0-9]+)*)\b/g;
const STOP_WORDS = new Set(['HTTP', 'HTTPS', 'UTF-8', 'PNG', 'JPG', 'N/A', 'INV', 'SO']);

function isStopWord(sku) {
  // Filter out order/invoice numbers like SO-478697 or INV-478665 (prefix + all digits)
  if (/^(SO|INV|PO|REF|ORD)-\d+$/.test(sku)) return true;
  if (STOP_WORDS.has(sku)) return true;
  // Filter out hyphenated words that are product descriptions, not SKUs
  // Real SKUs have all-uppercase segments; description words like "Sea-Weed" won't appear uppercased with both parts being real words
  // Simple heuristic: if it only has 2 segments and both are common English words, skip
  const DESCRIPTION_WORDS = new Set(['SEA-WEED', 'WEAR-HOUSE', 'NET-20', 'NET-45', 'PICK-LIST', 'SHIP-TO', 'BILL-TO', 'WALKER-ST', 'PO-BOX', 'ST-WEAR']);
  if (DESCRIPTION_WORDS.has(sku)) return true;
  // Filter anything that looks like a location fragment (ends in common location words)
  if (/^(WALKER|WEAR|HOUSE|PICKING)/.test(sku)) return true;
  return false;
}

function extractSkusFromText(text) {
  const upper = text.toUpperCase();
  const matches = [...upper.matchAll(SKU_PATTERN_CLIENT)]
    .map((m) => m[1])
    .filter((s) => !isStopWord(s));

  // Deduplicate: if a shorter code is a prefix of a longer one, keep only the longer one
  // e.g. GLV-LH-GBC is dropped if GLV-LH-GBC-L also exists
  const all = [...new Set(matches)];
  const filtered = all.filter(
    (sku) => !all.some((other) => other !== sku && other.startsWith(sku + '-'))
  );

  return filtered;
}

// Extract text directly from a PDF (accurate, no OCR needed for text-based PDFs)
async function extractSkusFromPdf(file) {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Join items smartly: glue when previous ends with hyphen OR next starts with hyphen
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
    // Catch any remaining "- L" patterns
    const fixed = pageText.replace(/-\s+([A-Z0-9])/g, '-$1');
    fullText += fixed + '\n';
  }

  return extractSkusFromText(fullText);
}

// ─── Filename parser ───────────────────────────────────────────────────────────
// Expects: "Product Name(SKU-CODE)(SIZE).png"
function parseFilename(filename) {
  const base = filename.replace(/\.png$/i, '');
  const parts = base.match(/^(.*?)\(([^)]+)\)\(([^)]+)\)$/);
  if (parts) {
    return { name: parts[1].trim(), sku: parts[2].trim(), size: parts[3].trim() };
  }
  // Fallback: last paren group = sku, rest = name
  const fallback = base.match(/^(.*?)\(([^)]+)\)$/);
  if (fallback) {
    return { name: fallback[1].trim(), sku: fallback[2].trim(), size: '' };
  }
  return { name: base, sku: base, size: '' };
}

// ─── Fuzzy match SKU against library ─────────────────────────────────────────
function matchSku(sku, library) {
  if (!library.length) return null;

  const normalize = (s) => s.toUpperCase().trim();

  // 1. Exact match
  const exact = library.find((e) => normalize(e.sku) === normalize(sku));
  if (exact) return exact;

  // 2. Positional segment scoring — compare segment by segment at each position
  const segs = (s) => normalize(s).split(/[-_ ]+/).filter(Boolean);
  const querySegs = segs(sku);

  let bestEntry = null;
  let bestScore = -Infinity;

  for (const entry of library) {
    const entrySegs = segs(entry.sku);

    // Positional matches score higher than unordered matches
    let positionalMatches = 0;
    const maxLen = Math.max(querySegs.length, entrySegs.length);
    for (let i = 0; i < maxLen; i++) {
      if (querySegs[i] && entrySegs[i] && querySegs[i] === entrySegs[i]) {
        positionalMatches++;
      }
    }

    // Penalize any segment mismatch (catches L vs M at last position)
    const mismatches = maxLen - positionalMatches;
    const score = positionalMatches - mismatches * 0.6;

    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  // Must have at least 1 positional match and positive score
  if (bestScore > 0) return bestEntry;

  return null;
}

// ─── Label size definitions (width x height in inches, CSS pixels at 96dpi) ──
const LABEL_SIZES = {
  '2x1': { label: '2" × 1"', w: 192, h: 96 },
  '2x1.5': { label: '2" × 1.5"', w: 192, h: 144 },
  '4x2': { label: '4" × 2"', w: 384, h: 192 },
  '4x3': { label: '4" × 3"', w: 384, h: 288 },
  '4x6': { label: '4" × 6"', w: 384, h: 576 },
};

// ─── Main component ───────────────────────────────────────────────────────────
export default function Home() {
  const [activeTab, setActiveTab] = useState('library');

  // Library state
  const [library, setLibrary] = useState([]);
  const folderInputRef = useRef();

  // Load library from localStorage after mount (avoids SSR hydration mismatch)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('bfg-library');
      if (saved) setLibrary(JSON.parse(saved));
    } catch {}
  }, []);

  // Persist library to localStorage whenever it changes
  useEffect(() => {
    if (library.length === 0) return;
    try {
      localStorage.setItem('bfg-library', JSON.stringify(library));
    } catch (e) {
      console.warn('Could not save library to localStorage:', e.message);
    }
  }, [library]);

  // Order state
  const [skus, setSkus] = useState([]); // deduped list of extracted SKUs
  const [screenshots, setScreenshots] = useState([]); // [{name, dataUrl}]
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanQueue, setScanQueue] = useState([]); // items being scanned
  const [manualSku, setManualSku] = useState('');
  const [dropActive, setDropActive] = useState(false);
  const orderDropRef = useRef();

  // Print state
  const [labelSize, setLabelSize] = useState('4x2');
  const [labelsPerRow, setLabelsPerRow] = useState(2);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // ─── Library: folder selection ──────────────────────────────────────────────
  const handleFolderSelect = useCallback((e) => {
    const files = Array.from(e.target.files).filter((f) =>
      f.name.toLowerCase().endsWith('.png')
    );
    if (!files.length) return;

    const entries = [];
    let loaded = 0;

    files.forEach((file) => {
      const parsed = parseFilename(file.name);
      const reader = new FileReader();
      reader.onload = (ev) => {
        entries.push({
          sku: parsed.sku,
          name: parsed.name,
          size: parsed.size,
          filename: file.name,
          dataUrl: ev.target.result,
        });
        loaded++;
        if (loaded === files.length) {
          entries.sort((a, b) => a.sku.localeCompare(b.sku));
          setLibrary(entries);
        }
      };
      reader.readAsDataURL(file);
    });
  }, []);

  // ─── Order: drag & drop screenshots ────────────────────────────────────────
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

  const orderFileInputRef = useRef();

  async function processOrderImages(files) {
    // PDFs: extract text directly (accurate). Images: send to OCR via API.
    const pdfSkus = [];
    const imageFiles = [];

    for (const f of files) {
      if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        try {
          setScanQueue((prev) => [...prev, f.name]);
          setScanning(true);
          setScanError('');
          const skus = await extractSkusFromPdf(f);
          pdfSkus.push(...skus);
          setScreenshots((prev) => [...prev, { name: f.name, dataUrl: null }]);
          setScanQueue((prev) => prev.filter((n) => n !== f.name));
          if (skus.length === 0) {
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

    // Add PDF SKUs immediately
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

    // For image files, read as data URLs and send to OCR
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
    const newScreenshots = expanded;

    if (newScreenshots.length === 0) {
      // All files were PDFs handled above — nothing left to OCR
      setScanning(false);
      return;
    }

    setScreenshots((prev) => [...prev, ...newScreenshots]);

    // Queue scan
    setScanQueue((prev) => [...prev, ...newScreenshots.map((s) => s.name)]);
    setScanning(true);
    setScanError('');

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: newScreenshots.map((s) => s.dataUrl) }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail || 'Scan failed');

      const newSkus = data.skus ?? [];
      if (newSkus.length === 0) {
        setScanError('No SKUs found in the screenshot. Try adding them manually below.');
      }
      setSkus((prev) => {
        const merged = [...prev];
        for (const sku of newSkus) {
          if (!merged.some((s) => s.toLowerCase() === sku.toLowerCase())) {
            merged.push(sku);
          }
        }
        return merged;
      });
    } catch (err) {
      setScanError(`Error: ${err.message}`);
    } finally {
      setScanQueue((prev) =>
        prev.filter((n) => !newScreenshots.some((s) => s.name === n))
      );
      setScanning(false);
    }
  }

  function addManualSku() {
    const trimmed = manualSku.trim().toUpperCase();
    if (!trimmed) return;
    setSkus((prev) => {
      if (prev.some((s) => s.toLowerCase() === trimmed.toLowerCase()))
        return prev;
      return [...prev, trimmed];
    });
    setManualSku('');
  }

  function removeSku(sku) {
    setSkus((prev) => prev.filter((s) => s !== sku));
  }

  function removeScreenshot(idx) {
    setScreenshots((prev) => prev.filter((_, i) => i !== idx));
  }

  // ─── Print labels ───────────────────────────────────────────────────────────
  const matchedLabels = skus.map((sku) => ({
    sku,
    match: matchSku(sku, library),
  }));

  const sizeConfig = LABEL_SIZES[labelSize];

  function handlePrint() {
    window.print();
  }

  // ─── Print portal content ────────────────────────────────────────────────────
  const printContent = (
    <div
      id="print-portal"
      style={{
        display: 'none',
        padding: 0,
        margin: 0,
        background: 'white',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${labelsPerRow}, ${sizeConfig.w}px)`,
          gap: 8,
          padding: 8,
        }}
      >
        {matchedLabels.map(({ sku, match }) => (
          <div
            key={sku}
            style={{
              width: sizeConfig.w,
              height: sizeConfig.h,
              background: match ? '#fff' : '#fef9c3',
              border: `1px solid ${match ? '#ccc' : '#fde047'}`,
              borderRadius: 4,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 8,
              pageBreakInside: 'avoid',
              breakInside: 'avoid',
            }}
          >
            {match ? (
              <>
                <img
                  src={match.dataUrl}
                  alt={match.sku}
                  style={{ maxWidth: '100%', maxHeight: '60%', objectFit: 'contain' }}
                />
                <div style={{ fontFamily: 'monospace', fontSize: 10, fontWeight: 600, textAlign: 'center', marginTop: 4 }}>
                  {match.sku}
                </div>
                {match.name && (
                  <div style={{ fontSize: 9, color: '#555', textAlign: 'center', marginTop: 2 }}>{match.name}</div>
                )}
                {match.size && (
                  <div style={{ fontSize: 9, color: '#555', textAlign: 'center' }}>{match.size}</div>
                )}
              </>
            ) : (
              <>
                <div style={{ fontSize: 11, color: '#854d0e', textAlign: 'center' }}>⚠ No barcode found</div>
                <div style={{ fontFamily: 'monospace', fontSize: 10, fontWeight: 600, textAlign: 'center', marginTop: 6 }}>{sku}</div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <Head>
        <title>BFG Barcode Printer</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className={styles.container}>
        {/* ── Header ── */}
        <header className={`${styles.header} ${styles.noPrint}`}>
          <span className={styles.headerTitle}>BFG Barcode Printer</span>
          <span className={styles.headerSub}>Warehouse Label Tool</span>
        </header>

        {/* ── Tabs ── */}
        <nav className={`${styles.tabs} ${styles.noPrint}`}>
          {[
            { id: 'library', label: `Library${library.length ? ` (${library.length})` : ''}` },
            { id: 'order', label: `Order${skus.length ? ` (${skus.length})` : ''}` },
            { id: 'print', label: `Print${matchedLabels.length ? ` (${matchedLabels.length})` : ''}` },
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

        {/* ── Tab Content ── */}
        <div className={`${styles.content} ${styles.noPrint}`}>

          {/* ══════════ LIBRARY TAB ══════════ */}
          {activeTab === 'library' && (
            <div>
              <div className={styles.card}>
                <div className={styles.cardTitle}>Barcode Library</div>
                <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 14 }}>
                  Select a folder of PNG barcode files. Filenames must follow the pattern:<br />
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
                  >
                    Select Folder
                  </button>
                  {library.length > 0 && (
                    <>
                      <span className={`${styles.badge} ${styles.badgeGreen}`}>
                        {library.length} barcodes loaded
                      </span>
                      <button
                        className={`${styles.btn} ${styles.btnDanger} ${styles.btnSm}`}
                        onClick={() => setLibrary([])}
                      >
                        Clear
                      </button>
                    </>
                  )}
                </div>
              </div>

              {library.length > 0 && (
                <div className={styles.card}>
                  <div className={styles.cardTitle}>Loaded Barcodes</div>
                  <div className={styles.libraryGrid}>
                    {library.map((entry) => (
                      <div key={entry.filename} className={styles.libraryItem}>
                        <img
                          src={entry.dataUrl}
                          alt={entry.sku}
                          className={styles.libraryBarcode}
                        />
                        <div className={styles.libraryItemSku}>{entry.sku}</div>
                        {entry.size && (
                          <div className={styles.libraryItemName}>{entry.size}</div>
                        )}
                        {entry.name && (
                          <div className={styles.libraryItemName}>{entry.name}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {library.length === 0 && (
                <div className={styles.emptyState}>
                  <div className={styles.emptyStateTitle}>No barcodes loaded</div>
                  <div className={styles.emptyStateText}>
                    Select a folder of PNG barcode files to get started.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══════════ ORDER TAB ══════════ */}
          {activeTab === 'order' && (
            <div>
              {/* Drop zone */}
              <div className={styles.card}>
                <div className={styles.cardTitle}>Drop Order Screenshots</div>
                <div
                  className={`${styles.dropZone} ${dropActive ? styles.dropZoneActive : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDropActive(true); }}
                  onDragLeave={() => setDropActive(false)}
                  onDrop={handleOrderDrop}
                  onClick={() => orderFileInputRef.current?.click()}
                >
                  <div className={styles.dropZoneText}>
                    {scanning ? 'Scanning…' : 'Drop order screenshots here or click to browse'}
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
                      {screenshots.length} screenshot{screenshots.length !== 1 ? 's' : ''} processed
                    </div>
                    <div className={styles.screenshotList}>
                      {screenshots.map((s, idx) => (
                        <div key={idx} className={styles.screenshotThumb}>
                          <img src={s.dataUrl} alt={s.name} />
                          <button
                            className={styles.screenshotThumbRemove}
                            onClick={() => removeScreenshot(idx)}
                            title="Remove"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Manual SKU entry */}
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
                  <button
                    className={`${styles.btn} ${styles.btnSecondary}`}
                    onClick={addManualSku}
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* SKU list */}
              <div className={styles.card}>
                <div className={styles.row} style={{ marginBottom: 4 }}>
                  <div className={styles.cardTitle} style={{ margin: 0 }}>
                    Extracted SKUs
                  </div>
                  <div className={styles.spacer} />
                  {skus.length > 0 && (
                    <button
                      className={`${styles.btn} ${styles.btnDanger} ${styles.btnSm}`}
                      onClick={() => setSkus([])}
                    >
                      Clear All
                    </button>
                  )}
                </div>

                {skus.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--color-text-muted)', paddingTop: 8 }}>
                    No SKUs yet. Drop screenshots or type manually above.
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
                          <button
                            className={styles.skuChipRemove}
                            onClick={() => removeSku(sku)}
                            title="Remove"
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}

                {skus.length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <button
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={() => setActiveTab('print')}
                    >
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
              {/* Controls */}
              <div className={`${styles.card} ${styles.noPrint}`}>
                <div className={styles.cardTitle}>Print Settings</div>
                <div className={styles.printControls}>
                  <div className={styles.printControlGroup}>
                    <label className={styles.printControlLabel}>Label Size</label>
                    <select
                      className={styles.select}
                      value={labelSize}
                      onChange={(e) => setLabelSize(e.target.value)}
                    >
                      {Object.entries(LABEL_SIZES).map(([k, v]) => (
                        <option key={k} value={k}>{v.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.printControlGroup}>
                    <label className={styles.printControlLabel}>Per Row</label>
                    <select
                      className={styles.select}
                      value={labelsPerRow}
                      onChange={(e) => setLabelsPerRow(Number(e.target.value))}
                    >
                      {[1, 2, 3, 4].map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
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
                    {matchedLabels.filter((l) => l.match).length} of {matchedLabels.length} SKUs matched to barcodes
                    {matchedLabels.some((l) => !l.match) && (
                      <span style={{ color: 'var(--color-danger)', marginLeft: 8 }}>
                        — {matchedLabels.filter((l) => !l.match).length} unmatched (shown with yellow background)
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Label grid — visible on screen & printed */}
              {matchedLabels.length === 0 ? (
                <div className={`${styles.emptyState} ${styles.noPrint}`}>
                  <div className={styles.emptyStateTitle}>No SKUs to print</div>
                  <div className={styles.emptyStateText}>
                    Go to the Order tab and extract some SKUs first.
                  </div>
                  <button
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    style={{ marginTop: 16 }}
                    onClick={() => setActiveTab('order')}
                  >
                    Go to Order
                  </button>
                </div>
              ) : (
                <div
                  className="print-area"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${labelsPerRow}, ${sizeConfig.w}px)`,
                    gap: 8,
                    justifyContent: 'start',
                  }}
                >
                  {matchedLabels.map(({ sku, match }) => (
                    <div
                      key={sku}
                      className={`${styles.label} ${!match ? styles.labelNoMatch : ''}`}
                      style={{
                        width: sizeConfig.w,
                        height: sizeConfig.h,
                      }}
                    >
                      {match ? (
                        <>
                          <img
                            src={match.dataUrl}
                            alt={match.sku}
                            className={styles.labelBarcode}
                          />
                          <div className={styles.labelSku}>{match.sku}</div>
                          {match.name && (
                            <div className={styles.labelName}>{match.name}</div>
                          )}
                          {match.size && (
                            <div className={styles.labelName}>{match.size}</div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className={styles.labelNoMatchText}>
                            ⚠ No barcode found
                          </div>
                          <div className={styles.labelSku} style={{ marginTop: 6 }}>{sku}</div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Portal: renders label grid into #print-portal at body level for clean printing */}
      {mounted && createPortal(printContent, document.body)}
    </>
  );
}
