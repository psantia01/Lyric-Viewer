/**
 * Netlify serverless function — fetches chord sheets from Ultimate Guitar
 * server-side so there are no CORS issues on any device (including iPhone).
 *
 * Usage: GET /.netlify/functions/fetch-chords?artist=X&title=Y
 */

const https = require('https')
const http  = require('http')

// Follow redirects and return the full response body as a string
function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'))
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, redirects + 1).then(resolve).catch(reject)
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')) })
  })
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
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
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing artist or title' }) }
  }

  try {
    // ── Step 1: search Ultimate Guitar ──────────────────────────────────────
    const query      = encodeURIComponent(`${title} ${artist}`)
    const searchUrl  = `https://www.ultimate-guitar.com/search.php?search_type=title&value=${query}`
    const searchHtml = await fetchUrl(searchUrl)
    const searchJson = extractJsStore(searchHtml)
    if (!searchJson) throw new Error('Could not read Ultimate Guitar search results')

    const results = searchJson?.store?.page?.data?.results ?? []
    const hit = results.find(r => r.type === 'Chords') ??
                results.find(r => ['Tab', 'Pro Tab'].includes(r.type))
    if (!hit?.tab_url) throw new Error('No chord sheet found for this song on Ultimate Guitar')

    // ── Step 2: fetch the tab page ──────────────────────────────────────────
    const tabHtml = await fetchUrl(hit.tab_url)
    const tabJson = extractJsStore(tabHtml)
    if (!tabJson) throw new Error('Could not read the chord sheet page')

    const content = tabJson?.store?.page?.data?.tab_view?.wiki_tab?.content
    if (!content) throw new Error('Chord content was empty')

    return { statusCode: 200, headers: cors, body: JSON.stringify({ content }) }

  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: err.message || 'Failed to fetch chords' }),
    }
  }
}
