import { useState, useEffect } from 'react'
import './App.css'

// ─── Types ───────────────────────────────────────────────────────────────────
interface LyricsResult {
  lyrics: string
  artist: string
  title: string
  chordSheet?: string
}

interface SavedSong {
  id: string
  artist: string
  title: string
  lyrics: string
  chordSheet?: string
  transposeOffset?: number
  savedAt: string
}

type Status = 'idle' | 'loading' | 'success' | 'error'
type DisplayMode = 'lyrics' | 'chords'

// ─── Chord utilities ──────────────────────────────────────────────────────────
const SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
const FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B']

// CORS proxy — lets the browser fetch UG pages without CORS errors
const CORS_PROXY = 'https://corsproxy.io/?url='

function noteIndex(note: string) {
  const i = SHARP.indexOf(note)
  return i !== -1 ? i : FLAT.indexOf(note)
}

function transposeChord(chord: string, semitones: number): string {
  if (!semitones) return chord
  const m = chord.match(/^([A-G][#b]?)(.*)$/)
  if (!m) return chord
  const [, root, quality] = m
  const idx = noteIndex(root)
  if (idx === -1) return chord
  const newIdx = ((idx + semitones) % 12 + 12) % 12
  return (root.endsWith('b') ? FLAT : SHARP)[newIdx] + quality
}

function detectKey(sheet: string, semitones: number): string {
  const m = sheet.match(/\[([A-G][#b]?)[^\]]*\]/)
  if (!m) return ''
  const root = m[1].match(/^([A-G][#b]?)/)
  return root ? transposeChord(root[1], semitones) : ''
}

/** Decode HTML entities in a data-content attribute value */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

/** Pull the JSON embedded in UG's js-store div from an HTML page */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractJsStore(html: string): any {
  const m = html.match(/class="js-store"[^>]*data-content="([^"]*)"/)
  if (!m) throw new Error('Could not find page data')
  return JSON.parse(decodeHtmlEntities(m[1]))
}

/** Convert UG [ch]X[/ch] / [tab] tags → our [X] inline chord format */
function convertUGContent(raw: string): string {
  return raw
    .replace(/\[tab\]/gi, '')
    .replace(/\[\/tab\]/gi, '')
    .replace(/\[ch\]([^\[]+?)\[\/ch\]/g, '[$1]')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

/**
 * Fetch a chord sheet from Ultimate Guitar.
 *
 * On the deployed Netlify site we call our own serverless function
 * (/.netlify/functions/fetch-chords) which runs server-side — zero CORS
 * issues on any device including iPhone / mobile Safari.
 *
 * In local development that endpoint returns 404, so we fall back to the
 * corsproxy.io CORS proxy (works fine on desktop).
 */
async function fetchChordSheet(artist: string, title: string): Promise<string> {
  // ── Try Netlify serverless function (deployed site, all devices) ──────────
  try {
    const params = new URLSearchParams({ artist, title })
    const res = await fetch(`/.netlify/functions/fetch-chords?${params}`)
    if (res.ok) {
      const data = await res.json()
      if (data.content) return convertUGContent(data.content)
      throw new Error(data.error || 'Empty response from server')
    }
    // 404 = running locally without netlify dev — fall through to proxy
    if (res.status !== 404) {
      const data = await res.json().catch(() => ({}))
      throw new Error((data as { error?: string }).error || 'Server error fetching chords')
    }
  } catch (err: unknown) {
    // Re-throw real errors; swallow network errors that just mean
    // "function not available locally" (TypeError: Failed to fetch on 404-ish)
    const msg = (err as Error)?.message ?? ''
    if (msg && !msg.includes('Failed to fetch') && !msg.includes('404')) throw err
  }

  // ── Fallback: CORS proxy (local dev only) ─────────────────────────────────
  const q = encodeURIComponent(`${artist} ${title}`)
  const searchUrl = `https://www.ultimate-guitar.com/search.php?search_type=title&value=${q}`

  const searchRes = await fetch(CORS_PROXY + encodeURIComponent(searchUrl))
  if (!searchRes.ok) throw new Error('Could not reach chord database')
  const searchHtml = await searchRes.text()

  let tabUrl: string
  try {
    const store = extractJsStore(searchHtml)
    const results: any[] = store?.store?.page?.data?.results ?? [] // eslint-disable-line @typescript-eslint/no-explicit-any
    const tab =
      results.find((r: { type: string }) => r.type === 'Chords') ??
      results.find((r: { type: string }) => r.type === 'Tab') ??
      results[0]
    if (!tab) throw new Error('No chord sheet found for this song')
    tabUrl = tab.tab_url as string
  } catch {
    throw new Error('No chord sheet found for this song')
  }

  const tabRes = await fetch(CORS_PROXY + encodeURIComponent(tabUrl))
  if (!tabRes.ok) throw new Error('Could not load chord sheet')
  const tabHtml = await tabRes.text()

  let content: string
  try {
    const tabStore = extractJsStore(tabHtml)
    content =
      tabStore?.store?.page?.data?.tab_view?.wiki_tab?.content ??
      tabStore?.store?.page?.data?.tab?.content ??
      ''
  } catch {
    throw new Error('Could not parse chord sheet')
  }

  if (!content.trim()) throw new Error('Chord sheet was empty')
  return convertUGContent(content)
}

// ─── Chord sheet renderer ─────────────────────────────────────────────────────

/**
 * True if the string inside [] is a chord (e.g. "D", "G#m7", "Cadd9").
 * Uses an explicit quality list so section labels like "Chorus", "Bridge" are rejected.
 */
function looksLikeChord(s: string): boolean {
  return /^[A-G][#b]?(?:maj|min|dim|aug|sus|add|M|m)?[0-9]*(?:\/[A-G][#b]?)?$/.test(s)
}

/** True if the line is a section label, e.g. [Intro], [Verse 1], [Chorus] */
function isSectionLabel(line: string): boolean {
  const m = line.trim().match(/^\[([^\]]+)\]$/)
  if (!m) return false
  return !looksLikeChord(m[1]) // section labels don't look like chords
}

/**
 * If a line is entirely plain-text chord names separated by spaces (no brackets),
 * e.g. "D   G   C   G", returns their character positions. Otherwise null.
 */
const PLAIN_CHORD_RE = /^[A-G][#b]?(?:maj|min|dim|aug|sus|add|M|m)?[0-9]*(?:\/[A-G][#b]?)?$/
function parsePlainChordLine(line: string): Array<{ pos: number; chord: string }> | null {
  if (!line.trim() || /[\[\]]/.test(line)) return null // blank or already has brackets
  const tokens = line.trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 1) return null
  // Single-chord lines are only recognised if they start with whitespace (indented)
  if (tokens.length === 1 && !/^\s/.test(line)) return null
  if (!tokens.every(t => PLAIN_CHORD_RE.test(t))) return null
  // Record the original character position of each token
  const result: Array<{ pos: number; chord: string }> = []
  let from = 0
  for (const token of tokens) {
    const pos = line.indexOf(token, from)
    result.push({ pos, chord: token })
    from = pos + token.length
  }
  return result
}

/**
 * A line is "chord-only" when stripping every [Chord] token leaves nothing
 * but whitespace — i.e. the line is a chord-position line, not inline chords.
 */
function isChordOnlyLine(line: string): boolean {
  if (!/\[[A-G][^\]]*\]/.test(line)) return false
  return line.replace(/\[[A-G][^\]]*\]/g, '').trim() === ''
}

/**
 * Parse a chord-only line into (characterPosition, chord) pairs.
 *
 * Uses match.index — the actual column of '[' in the string — so positions
 * match what the user sees in the monospace edit pane exactly.
 *
 * The old approach counted only non-bracket characters (charPos), which made
 * each chord land 2 columns too far left for every preceding '[X]' bracket,
 * causing chords to drift away from the correct words.
 */
function parseChordPositions(line: string): Array<{ pos: number; chord: string }> {
  const result: Array<{ pos: number; chord: string }> = []
  const re = /\[([^\]]+)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (looksLikeChord(m[1])) {
      result.push({ pos: m.index, chord: m[1] })
    }
  }
  return result
}

type DisplayLine =
  | { kind: 'paired'; chords: Array<{ pos: number; chord: string }>; lyric: string }
  | { kind: 'inline'; text: string }  // line already has [Chord]text inline
  | { kind: 'plain';  text: string }

/**
 * Pre-process a chord sheet into display lines:
 *  - chord-only lines (bracket or plain-text) are paired with the following lyric line
 *  - inline-chord lines ([Chord]word) are kept as-is
 *  - everything else is plain text
 */
function processSheet(sheet: string): DisplayLine[] {
  const lines = sheet.split('\n')
  const out: DisplayLine[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Resolve chord positions from bracket format OR plain-text format
    let chords: Array<{ pos: number; chord: string }> | null = null
    if (isChordOnlyLine(line)) {
      chords = parseChordPositions(line)
    } else {
      chords = parsePlainChordLine(line)
    }

    if (chords !== null) {
      const next = lines[i + 1]
      // Don't pair with: another chord line, a section label [Intro]/[Chorus]/…, or undefined
      const nextIsChord = next !== undefined &&
        (isChordOnlyLine(next) || parsePlainChordLine(next) !== null)
      const lyric = (next !== undefined && !nextIsChord && !isSectionLabel(next))
        ? next
        : ''
      out.push({ kind: 'paired', chords, lyric })
      i += lyric !== '' ? 2 : 1
    } else if (/\[[A-G][^\]]*\]/.test(line) && !isSectionLabel(line)) {
      out.push({ kind: 'inline', text: line })
      i++
    } else {
      out.push({ kind: 'plain', text: line })
      i++
    }
  }

  // Collapse runs of 2+ consecutive blank lines down to a single blank line
  const collapsed: DisplayLine[] = []
  let prevBlank = false
  for (const dl of out) {
    const isBlank = dl.kind === 'plain' && dl.text.trim() === ''
    if (isBlank && prevBlank) continue
    collapsed.push(dl)
    prevBlank = isBlank
  }
  return collapsed
}

/**
 * Snap a character position to the NEAREST word start in the lyric,
 * so chords always land on the beginning of a word rather than mid-syllable
 * or in a gap of spaces.
 */
function snapToWord(lyric: string, pos: number): number {
  if (!lyric) return 0
  if (pos <= 0) return 0

  // Collect all word-start positions
  const wordStarts: number[] = []
  if (lyric[0] !== ' ') wordStarts.push(0)
  for (let i = 1; i < lyric.length; i++) {
    if (lyric[i] !== ' ' && lyric[i - 1] === ' ') wordStarts.push(i)
  }
  if (wordStarts.length === 0) return 0

  // Return the word start closest to pos
  return wordStarts.reduce((best, ws) =>
    Math.abs(ws - pos) < Math.abs(best - pos) ? ws : best
  , wordStarts[0])
}

/**
 * Rebuild the chord line as a plain string at the original character positions,
 * with each chord name transposed. Extra spaces are added to preserve alignment.
 */
function buildChordLine(chords: Array<{ pos: number; chord: string }>, semitones: number): string {
  let line = ''
  for (const { pos, chord } of chords) {
    const name = transposeChord(chord, semitones)
    if (pos > line.length) line += ' '.repeat(pos - line.length)
    line += name
  }
  return line
}

/** Render a paired chord-above-lyric row in pre-formatted monospace (matches edit pane). */
function PairedRow({ chords, lyric, semitones }: {
  chords: Array<{ pos: number; chord: string }>
  lyric: string
  semitones: number
}) {
  // ── No lyric (e.g. intro/outro) — list chords as spaced labels ────────────
  if (!lyric.trim()) {
    return (
      <div className="chord-line chord-line--chords-only">
        {chords.map(({ chord }, j) => (
          <span key={j} className="chord-only-label">
            {transposeChord(chord, semitones)}
          </span>
        ))}
      </div>
    )
  }

  // ── Pre-formatted: chord line reconstructed at original positions ──────────
  return (
    <div className="paired-row">
      <div className="chord-row">{buildChordLine(chords, semitones) || '\u00A0'}</div>
      <div className="lyric-row">{lyric}</div>
    </div>
  )
}

/** Render an inline-chord line: [G]Here comes the [C]sun */
function InlineRow({ text, semitones }: { text: string; semitones: number }) {
  const segs: Array<{ chord: string; text: string }> = []
  const first = text.indexOf('[')
  if (first > 0) segs.push({ chord: '', text: text.slice(0, first) })
  const re = /\[([^\]]+)\]([^\[]*)/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (looksLikeChord(m[1])) segs.push({ chord: m[1], text: m[2] })
    else segs.push({ chord: '', text: `[${m[1]}]${m[2]}` })
  }
  return (
    <div className="chord-line">
      {segs.map((seg, j) => (
        <span key={j} className="chord-seg">
          <span className="chord-label">
            {seg.chord ? transposeChord(seg.chord, semitones) : '\u00A0'}
          </span>
          <span className="chord-text">{seg.text || '\u00A0'}</span>
        </span>
      ))}
    </div>
  )
}

/** Full chord-sheet body — handles both UG-style and inline-chord formats. */
function ChordSheetBody({ sheet, semitones }: { sheet: string; semitones: number }) {
  const lines = processSheet(sheet)
  return (
    <div className="chord-sheet-body">
      {lines.map((line, i) => {
        if (line.kind === 'paired')
          return <PairedRow key={i} chords={line.chords} lyric={line.lyric} semitones={semitones} />
        if (line.kind === 'inline')
          return <InlineRow key={i} text={line.text} semitones={semitones} />
        if (line.text.trim() === '')
          return <div key={i} className="lyric-line lyric-line-blank">&nbsp;</div>
        return <div key={i} className="lyric-line">{line.text}</div>
      })}
    </div>
  )
}

// ─── Song card ────────────────────────────────────────────────────────────────
interface SongCardProps {
  title: string
  artist: string
  lyrics: string
  chordSheet?: string
  initialTranspose?: number
  subtitle?: React.ReactNode
  onChordSave?: (sheet: string) => void
  onTransposeChange?: (semitones: number) => void
  onDelete?: () => void
  onBack?: () => void
  saveButton?: React.ReactNode
  /** Clean viewer mode: only shows title, mode toggle, and key — no editing buttons */
  cleanMode?: boolean
}

function SongCard({
  title, artist, lyrics, chordSheet,
  initialTranspose = 0,
  subtitle, onChordSave, onTransposeChange, onDelete, onBack, saveButton,
  cleanMode = false,
}: SongCardProps) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>(chordSheet ? 'chords' : 'lyrics')
  const [transpose, setTranspose] = useState(initialTranspose)
  const [showInput, setShowInput] = useState(false)
  const [inputText, setInputText] = useState('')

  const [chordSearching, setChordSearching] = useState(false)
  const [chordSearchErr, setChordSearchErr] = useState('')

  useEffect(() => {
    setDisplayMode(chordSheet ? 'chords' : 'lyrics')
    setTranspose(initialTranspose)
    setChordSearchErr('')
    setShowInput(false)
  }, [chordSheet, initialTranspose])

  const changeTranspose = (val: number) => {
    setTranspose(val)
    onTransposeChange?.(val)
  }

  const handleFindChords = async () => {
    setChordSearching(true)
    setChordSearchErr('')
    try {
      const sheet = await fetchChordSheet(artist, title)
      onChordSave?.(sheet)
    } catch (err) {
      setChordSearchErr(err instanceof Error ? err.message : 'Not found')
    } finally {
      setChordSearching(false)
    }
  }

  const handleApply = () => {
    if (!inputText.trim()) return
    onChordSave?.(inputText.trim())
    setShowInput(false)
    setInputText('')
  }

  const activeSheet = displayMode === 'chords' ? chordSheet : undefined
  const currentKey = activeSheet ? detectKey(activeSheet, transpose) : ''

  // ── Transpose bar (shared between clean and full modes) ───────────────────
  const transposeBar = displayMode === 'chords' && chordSheet ? (
    <div className="transpose-bar">
      <span className="transpose-label">
        Key{currentKey ? `: ${currentKey}` : ''}
      </span>
      <div className="transpose-controls">
        <button className="transpose-btn" onClick={() => changeTranspose(transpose - 1)}>♭ −1</button>
        <span className="transpose-offset">
          {transpose > 0 ? `+${transpose}` : transpose}
        </span>
        <button className="transpose-btn" onClick={() => changeTranspose(transpose + 1)}>♯ +1</button>
        {transpose !== 0 && (
          <button className="transpose-reset" onClick={() => changeTranspose(0)}>Reset</button>
        )}
      </div>
    </div>
  ) : null

  // ── Body (shared) ─────────────────────────────────────────────────────────
  const body = displayMode === 'chords' && chordSheet ? (
    <ChordSheetBody sheet={chordSheet} semitones={transpose} />
  ) : (
    <pre className="lyrics-body">{lyrics.trim()}</pre>
  )

  // ── Clean viewer mode ─────────────────────────────────────────────────────
  if (cleanMode) {
    return (
      <div className="lyrics-card lyrics-card--clean">
        <div className="lyrics-header lyrics-header--clean">
          <div className="lyrics-header-text">
            <h2 className="song-title">{title}</h2>
            <p className="song-artist">{artist}</p>
          </div>
          {chordSheet && (
            <div className="mode-toggle">
              <button
                className={`mode-btn ${displayMode === 'lyrics' ? 'active' : ''}`}
                onClick={() => setDisplayMode('lyrics')}
              >Lyrics</button>
              <button
                className={`mode-btn ${displayMode === 'chords' ? 'active' : ''}`}
                onClick={() => setDisplayMode('chords')}
              >Chords</button>
            </div>
          )}
        </div>
        {transposeBar}
        {body}
      </div>
    )
  }

  // ── Full edit mode ────────────────────────────────────────────────────────
  return (
    <div className="lyrics-card">
      {/* Header */}
      <div className="lyrics-header">
        <div className="lyrics-header-text">
          <h2 className="song-title">{title}</h2>
          <p className="song-artist">{artist}</p>
          {subtitle && <span className="card-subtitle">{subtitle}</span>}
        </div>
        <div className="header-actions">
          {chordSheet && (
            <div className="mode-toggle">
              <button className={`mode-btn ${displayMode === 'lyrics' ? 'active' : ''}`} onClick={() => setDisplayMode('lyrics')}>Lyrics</button>
              <button className={`mode-btn ${displayMode === 'chords' ? 'active' : ''}`} onClick={() => setDisplayMode('chords')}>Chords</button>
            </div>
          )}

          {/* Auto-find chords from Ultimate Guitar */}
          <button
            className="chord-add-btn"
            onClick={handleFindChords}
            disabled={chordSearching}
          >
            {chordSearching ? '⏳ Searching…' : chordSheet ? '🔄 Re-fetch Chords' : '🔍 Find Chords'}
          </button>

          {/* Manual edit / paste */}
          <button className="chord-add-btn" onClick={() => {
            setShowInput(v => {
              if (!v) setInputText(chordSheet ?? '')
              return !v
            })
          }}>
            {chordSheet ? '✏️ Edit' : '✏️ Paste'}
          </button>

          {saveButton}
          {onBack && <button className="back-btn" onClick={onBack}>← Back</button>}
          {onDelete && <button className="delete-btn" onClick={onDelete}>Delete</button>}
        </div>
      </div>

      {/* Chord search error */}
      {chordSearchErr && (
        <div className="chord-search-error">
          ⚠️ {chordSearchErr} — try "✏️ Paste" to add chords manually.
        </div>
      )}

      {/* Manual chord paste */}
      {showInput && (
        <div className="chord-input-area">
          <p className="chord-input-hint">
            {chordSheet
              ? <>Edit the chord sheet below. Chords use <code>[Chord]</code> notation inline with lyrics — e.g. <code>[G]Here comes the [C]sun</code></>
              : <>Paste a chord sheet using <code>[Chord]</code> notation — e.g. <code>[G]Here comes the [C]sun</code></>
            }
          </p>
          <textarea
            className="chord-textarea"
            rows={8}
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder={`[G]Here comes the [C]sun, [G]doo-doo-doo-doo\n[G]Here comes the [C]sun, and I say\n[F]It's all [C]right`}
          />
          <div className="chord-input-actions">
            <button className="search-btn" onClick={handleApply} disabled={!inputText.trim()}>Apply</button>
            <button className="back-btn" onClick={() => setShowInput(false)}>Cancel</button>
          </div>
        </div>
      )}

      {transposeBar}
      {body}
    </div>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────
type View = 'home' | 'saved' | 'edit'

function App() {
  const [view, setView] = useState<View>('home')
  const [artist, setArtist] = useState('')
  const [title, setTitle] = useState('')
  const [result, setResult] = useState<LyricsResult | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [savedSongs, setSavedSongs] = useState<SavedSong[]>([])
  const [selectedSaved, setSelectedSaved] = useState<SavedSong | null>(null)
  const [selectedEdit, setSelectedEdit] = useState<SavedSong | null>(null)
  const [saveConfirm, setSaveConfirm] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('lyric-viewer-saved')
    if (stored) setSavedSongs(JSON.parse(stored))
  }, [])

  const persistSaved = (songs: SavedSong[]) => {
    setSavedSongs(songs)
    localStorage.setItem('lyric-viewer-saved', JSON.stringify(songs))
  }

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!artist.trim() || !title.trim()) return
    setStatus('loading')
    setResult(null)
    setErrorMsg('')
    try {
      const res = await fetch(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(artist.trim())}/${encodeURIComponent(title.trim())}`
      )
      if (!res.ok) throw new Error('Lyrics not found')
      const data = await res.json()
      if (!data.lyrics) throw new Error('No lyrics available for this song')
      setResult({ lyrics: data.lyrics, artist: artist.trim(), title: title.trim() })
      setStatus('success')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong')
      setStatus('error')
    }
  }

  const handleSave = () => {
    if (!result) return
    if (savedSongs.some(s =>
      s.artist.toLowerCase() === result.artist.toLowerCase() &&
      s.title.toLowerCase() === result.title.toLowerCase()
    )) return
    const newSong: SavedSong = {
      id: `${Date.now()}`,
      artist: result.artist,
      title: result.title,
      lyrics: result.lyrics,
      chordSheet: result.chordSheet,
      savedAt: new Date().toLocaleDateString(),
    }
    persistSaved([newSong, ...savedSongs])
    setSaveConfirm(true)
    setTimeout(() => setSaveConfirm(false), 2000)
  }

  const handleDelete = (id: string) => {
    persistSaved(savedSongs.filter(s => s.id !== id))
    if (selectedSaved?.id === id) setSelectedSaved(null)
    if (selectedEdit?.id === id) setSelectedEdit(null)
  }

  // Sidebar click → clean viewer (doesn't change the active tab)
  const openSaved = (song: SavedSong) => {
    setSelectedSaved(song)
    setSelectedEdit(null)
  }

  // Edit tab song click → full editor
  const openEdit = (song: SavedSong) => {
    setSelectedEdit(song)
    setSelectedSaved(null)
  }

  const isAlreadySaved = result
    ? savedSongs.some(s =>
        s.artist.toLowerCase() === result.artist.toLowerCase() &&
        s.title.toLowerCase() === result.title.toLowerCase()
      )
    : false

  return (
    <div className="layout">

      {/* ── Top menu bar ── */}
      <nav className="menubar">
        <span className="menubar-logo">♪ Lyric Viewer</span>
        <div className="menubar-tabs">
          <button
            className={`menubar-tab ${view === 'home' ? 'active' : ''}`}
            onClick={() => { setView('home'); setSelectedSaved(null); setSelectedEdit(null) }}
          >
            Home
          </button>
          <button
            className={`menubar-tab ${view === 'edit' ? 'active' : ''}`}
            onClick={() => { setView('edit'); setSelectedSaved(null); setSelectedEdit(null) }}
          >
            Edit
          </button>
          <button
            className={`menubar-tab ${view === 'saved' ? 'active' : ''}`}
            onClick={() => { setView('saved'); setSelectedSaved(null); setSelectedEdit(null) }}
          >
            Saved {savedSongs.length > 0 && <span className="badge">{savedSongs.length}</span>}
          </button>
        </div>
      </nav>

      {/* ── Body: sidebar + main panel ── */}
      <div className="body-area">

        {/* ── Left sidebar ── */}
        <aside className="sidebar">
          <div className="sidebar-header">
            Saved Songs
            {savedSongs.length > 0 && <span className="badge">{savedSongs.length}</span>}
          </div>
          <div className="sidebar-list">
            {savedSongs.length === 0 ? (
              <div className="sidebar-empty">No saved songs yet.<br />Search and hit Save!</div>
            ) : (
              savedSongs.map(song => (
                <div
                  key={song.id}
                  className={`sidebar-item ${selectedSaved?.id === song.id ? 'active' : ''}`}
                  onClick={() => openSaved(song)}
                >
                  <div className="sidebar-item-title">
                    {song.title}
                    {song.chordSheet && <span className="sidebar-item-chord-dot" title="Has chords" />}
                  </div>
                  <div className="sidebar-item-artist">{song.artist}</div>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ── Main panel ── */}
        <div className="main-panel">
          <div className={`main-inner${selectedSaved ? ' main-inner--clean' : ''}`}>

            {/* ── Clean viewer: song selected from sidebar ── */}
            {selectedSaved ? (
              <SongCard
                cleanMode
                title={selectedSaved.title}
                artist={selectedSaved.artist}
                lyrics={selectedSaved.lyrics}
                chordSheet={selectedSaved.chordSheet}
                initialTranspose={selectedSaved.transposeOffset ?? 0}
                onTransposeChange={semitones => {
                  const updated = { ...selectedSaved, transposeOffset: semitones }
                  setSelectedSaved(updated)
                  persistSaved(savedSongs.map(s => s.id === updated.id ? updated : s))
                }}
              />

            ) : view === 'edit' ? (
              /* ── Edit tab ── */
              selectedEdit ? (
                /* Full editing interface for selected song */
                <SongCard
                  title={selectedEdit.title}
                  artist={selectedEdit.artist}
                  lyrics={selectedEdit.lyrics}
                  chordSheet={selectedEdit.chordSheet}
                  initialTranspose={selectedEdit.transposeOffset ?? 0}
                  subtitle={`Saved ${selectedEdit.savedAt}`}
                  onChordSave={sheet => {
                    const updated = { ...selectedEdit, chordSheet: sheet }
                    setSelectedEdit(updated)
                    persistSaved(savedSongs.map(s => s.id === updated.id ? updated : s))
                    // Keep selectedSaved in sync if same song is being viewed
                    if (selectedSaved?.id === updated.id) setSelectedSaved(updated)
                  }}
                  onTransposeChange={semitones => {
                    const updated = { ...selectedEdit, transposeOffset: semitones }
                    setSelectedEdit(updated)
                    persistSaved(savedSongs.map(s => s.id === updated.id ? updated : s))
                    if (selectedSaved?.id === updated.id) setSelectedSaved(updated)
                  }}
                  onBack={() => setSelectedEdit(null)}
                  onDelete={() => handleDelete(selectedEdit.id)}
                />
              ) : (
                /* Song picker list */
                <>
                  <h2 className="saved-page-title">Edit a Song</h2>
                  {savedSongs.length === 0 ? (
                    <div className="placeholder">
                      <span className="placeholder-icon">♫</span>
                      <p>No saved songs yet. Search for a song and hit Save first.</p>
                    </div>
                  ) : (
                    <div className="saved-grid">
                      {savedSongs.map(song => (
                        <div key={song.id} className="saved-card" onClick={() => openEdit(song)}>
                          <div className="saved-card-info">
                            <span className="saved-card-title">{song.title}</span>
                            <span className="saved-card-artist">{song.artist}</span>
                          </div>
                          <div className="saved-card-right">
                            {song.chordSheet && <span className="chord-badge">♩ Chords</span>}
                            <span className="saved-card-date">{song.savedAt}</span>
                            <button
                              className="chord-add-btn"
                              onClick={e => { e.stopPropagation(); openEdit(song) }}
                            >✏️ Edit</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )

            ) : view === 'home' ? (
              /* ── Home page ── */
              <>
                <div className="page-header">
                  <h1 className="page-title">♪ Lyric Viewer</h1>
                  <p className="page-tagline">Search lyrics & chords for any song</p>
                </div>

                <form className="search-form" onSubmit={handleSearch}>
                  <div className="input-row">
                    <input className="input" type="text" placeholder="Artist name" value={artist}
                      onChange={e => setArtist(e.target.value)} disabled={status === 'loading'} />
                    <input className="input" type="text" placeholder="Song title" value={title}
                      onChange={e => setTitle(e.target.value)} disabled={status === 'loading'} />
                    <button className="search-btn" type="submit"
                      disabled={status === 'loading' || !artist.trim() || !title.trim()}>
                      {status === 'loading' ? 'Searching...' : 'Search'}
                    </button>
                  </div>
                </form>

                {status === 'idle' && (
                  <div className="placeholder">
                    <span className="placeholder-icon">♪</span>
                    <p>Enter an artist and song title to find lyrics</p>
                  </div>
                )}
                {status === 'loading' && (
                  <div className="placeholder"><div className="spinner" /><p>Fetching lyrics...</p></div>
                )}
                {status === 'error' && (
                  <div className="error-box"><strong>Not found</strong><p>{errorMsg}</p></div>
                )}
                {status === 'success' && result && (
                  <SongCard
                    title={result.title}
                    artist={result.artist}
                    lyrics={result.lyrics}
                    chordSheet={result.chordSheet}
                    onChordSave={sheet => setResult(r => r ? { ...r, chordSheet: sheet } : r)}
                    saveButton={
                      <button className={`save-btn ${isAlreadySaved ? 'saved' : ''}`}
                        onClick={handleSave} disabled={isAlreadySaved}>
                        {saveConfirm ? 'Saved!' : isAlreadySaved ? 'Saved' : 'Save'}
                      </button>
                    }
                  />
                )}
              </>

            ) : (
              /* ── Saved page ── */
              <>
                <h2 className="saved-page-title">Saved Songs</h2>
                {savedSongs.length === 0 ? (
                  <div className="placeholder">
                    <span className="placeholder-icon">♫</span>
                    <p>No saved songs yet. Search for a song and hit Save.</p>
                  </div>
                ) : (
                  <div className="saved-grid">
                    {savedSongs.map(song => (
                      <div key={song.id} className="saved-card" onClick={() => openSaved(song)}>
                        <div className="saved-card-info">
                          <span className="saved-card-title">{song.title}</span>
                          <span className="saved-card-artist">{song.artist}</span>
                        </div>
                        <div className="saved-card-right">
                          {song.chordSheet && <span className="chord-badge">♩ Chords</span>}
                          <span className="saved-card-date">{song.savedAt}</span>
                          <button className="delete-btn small"
                            onClick={e => { e.stopPropagation(); handleDelete(song.id) }}
                            title="Delete">✕</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

          </div>
        </div>
      </div>
    </div>
  )
}

export default App
