/**
 * Netlify serverless function — fetches chord sheets from Ultimate Guitar.
 *
 * Uses ScraperAPI (scraperapi.com) to route requests through residential IPs
 * that bypass Cloudflare's bot protection on www.ultimate-guitar.com.
 *
 * Requires env var: SCRAPER_API_KEY
 *
 * Usage: GET /.netlify/functions/fetch-chords?artist=X&title=Y
 */

const https = require('https')
const zlib  = require('zlib')

const SCRAPER_KEY = process.env.SCRAPER_API_KEY

function scraperUrl(target) {
  return `https://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(target)}`
}

function decompress(buffer, encoding) {
  return new Promise((resolve, reject) => {
    if (encoding === 'gzip')         zlib.gunzip(buffer,          (e, b) => e ? reject(e) : resolve(b.toString('utf8')))
    else if (encoding === 'deflate') zlib.inflate(buffer,         (e, b) => e ? reject(e) : resolve(b.toString('utf8')))
    else if (encoding === 'br')      zlib.brotliDecompress(buffer,(e, b) => e ? reject(e) : resolve(b.toString('utf8')))
    else resolve(buffer.toString('utf8'))
  })
}

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'))
    const req = https.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location, redirects + 1).then(resolve).catch(reject)
      }
      const enc = res.headers['content-encoding'] || ''
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => decompress(Buffer.concat(chunks), enc).then(resolve).catch(reject))
    })
    req.on('error', reject)
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timed out')) })
  })
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g,  '&').replace(/&lt;/g,  '<')
    .replace(/&gt;/g,   '>').replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'").replace(/&#x27;/g, "'")
}

function extractJsStore(html) {
  const m = html.match(/class="js-store"\s+data-content="([^"]+)"/)
  if (!m) return null
  try { return JSON.parse(decodeHtmlEntities(m[1])) } catch { return null }
}

exports.handler = async event => {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' }


  const { artist = '', title = '' } = event.queryStringParameters || {}
  if (!artist.trim() || !title.trim()) {
    return { statusCode: 400, headers: cors,
      body: JSON.stringify({ error: 'Missing artist or title' }) }
  }

  if (!SCRAPER_KEY) {
    return { statusCode: 500, headers: cors,
      body: JSON.stringify({ error: 'SCRAPER_API_KEY environment variable is not set' }) }
  }

  try {
    // ── Step 1: search Ultimate Guitar via ScraperAPI ────────────────────────
    const q         = encodeURIComponent(`${title} ${artist}`)
    const searchUrl = `https://www.ultimate-guitar.com/search.php?search_type=title&value=${q}`
    const searchHtml = await fetchText(scraperUrl(searchUrl))
    const searchJson = extractJsStore(searchHtml)

    if (!searchJson) {
      const preview = searchHtml.slice(0, 200).replace(/\s+/g, ' ')
      throw new Error(`Could not read search results. Preview: ${preview}`)
    }

    const results = searchJson?.store?.page?.data?.results ?? []
    const hit = results.find(r => r.type === 'Chords') ??
                results.find(r => ['Tab', 'Pro Tab'].includes(r.type))

    if (!hit?.tab_url) throw new Error('No chord sheet found for this song on Ultimate Guitar')

    // ── Step 2: fetch the tab page via ScraperAPI ────────────────────────────
    const tabHtml = await fetchText(scraperUrl(hit.tab_url))
    const tabJson = extractJsStore(tabHtml)
    if (!tabJson) throw new Error('Could not read the chord sheet page')

    const content = tabJson?.store?.page?.data?.tab_view?.wiki_tab?.content ?? ''
    if (!content.trim()) throw new Error('Chord content was empty')

    // Convert UG [ch]X[/ch] / [tab] tags → our [X] inline format
    const converted = content
      .replace(/\[tab\]/gi, '')
      .replace(/\[\/tab\]/gi, '')
      .replace(/\[ch\]([^\[]+?)\[\/ch\]/g, '[$1]')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim()

    return { statusCode: 200, headers: cors, body: JSON.stringify({ content: converted }) }

  } catch (err) {
    return { statusCode: 500, headers: cors,
      body: JSON.stringify({ error: err.message || 'Failed to fetch chords' }) }
  }
}
