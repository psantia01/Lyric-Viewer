/**
 * Netlify serverless function — fetches chord sheets from Ultimate Guitar
 * using their mobile JSON API (api.ultimate-guitar.com) which is not behind
 * the Cloudflare bot-protection that blocks requests to the main website.
 *
 * Usage: GET /.netlify/functions/fetch-chords?artist=X&title=Y
 */

const https = require('https')
const zlib  = require('zlib')

function decompress(buffer, encoding) {
  return new Promise((resolve, reject) => {
    if (encoding === 'gzip')    zlib.gunzip(buffer,          (e, b) => e ? reject(e) : resolve(b.toString('utf8')))
    else if (encoding === 'deflate') zlib.inflate(buffer,    (e, b) => e ? reject(e) : resolve(b.toString('utf8')))
    else if (encoding === 'br') zlib.brotliDecompress(buffer,(e, b) => e ? reject(e) : resolve(b.toString('utf8')))
    else resolve(buffer.toString('utf8'))
  })
}

function fetchJSON(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'))
    const req = https.get(url, {
      headers: {
        // Mimic the official UG Android app
        'User-Agent':      'UGT_ANDROID/6.13.0 (Linux; Android 13; Pixel 7)',
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection':      'keep-alive',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location, redirects + 1).then(resolve).catch(reject)
      }
      const encoding = res.headers['content-encoding'] || ''
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        decompress(Buffer.concat(chunks), encoding)
          .then(text => {
            try { resolve(JSON.parse(text)) }
            catch { reject(new Error('Response was not valid JSON')) }
          })
          .catch(reject)
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')) })
  })
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g,  '&').replace(/&lt;/g,  '<')
    .replace(/&gt;/g,   '>').replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'").replace(/&#x27;/g, "'")
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

  try {
    // ── Step 1: search via the UG mobile API (no Cloudflare) ────────────────
    const q = encodeURIComponent(`${title} ${artist}`)
    const searchData = await fetchJSON(
      `https://api.ultimate-guitar.com/api/v1/tab/search?q=${q}&type[]=300&official=0&page=1`
    )

    const tabs = searchData?.data?.tabs ?? []
    // Prefer "Chords" type; fall back to anything
    const hit = tabs.find(t => t.type_name === 'Chords') ??
                tabs.find(t => ['Tab', 'Pro Tab'].includes(t.type_name)) ??
                tabs[0]

    if (!hit?.id) throw new Error('No chord sheet found for this song on Ultimate Guitar')

    // ── Step 2: fetch the full tab content via the API ───────────────────────
    const tabData = await fetchJSON(
      `https://api.ultimate-guitar.com/api/v1/tab/info?tab_id=${hit.id}&tonality_name=&version=0`
    )

    const content =
      tabData?.data?.tab_view?.wiki_tab?.content ??
      tabData?.data?.tab?.content ?? ''

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
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: err.message || 'Failed to fetch chords' }),
    }
  }
}
