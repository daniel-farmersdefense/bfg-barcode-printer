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
    let positionalMatches = 0;
    const maxLen = Math.max(querySegs.length, entrySegs.length);
    for (let i = 0; i < maxLen; i++) {
      if (querySegs[i] && entrySegs[i] && querySegs[i] === entrySegs[i]) {
        positionalMatches++;
      }
    }
    const mismatches = maxLen - positionalMatches;
    const score = positionalMatches - mismatches * 0.6;
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }
  if (bestScore > 0) return bestEntry;
  return null;
}

// Fixed label dimensions: 2" × 1.5"
const LABEL_W_PX = 192; // 2in at 96dpi
const LABEL_H_PX = 144; // 1.5in at 96dpi

export default function Home() {
  const [activeTab, setActiveTab] = useState('library');

  // Library state — loaded from server (shared across all users)
  const [library, setLibrary] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const folderInputRef = useRef();

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Fetch shared library from server on mount
  useEffect(() => {
    fetchLibrary();
  }, []);

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

  function handlePrint() { window.print(); }

  // Print portal — renders at body level, shown only during print
  const printContent = (
    <div id="print-portal" style={{ display: 'none', margin: 0, padding: 0, background: 'white' }}>
      {matchedLabels.map(({ sku, match }) => (
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
      ))}
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
        </div>
      </div>

      {mounted && createPortal(printContent, document.body)}
    </>
  );
}
