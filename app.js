// plume — a 100% client-side blogging platform for Solid.
//
// Phase 1: write + read + list posts. Markdown via marked. xlogin auth.
// Posts live at <pod>/public/post/<slug>.jsonld as schema:BlogPosting
// resources — any pod-aware app can read, render, or replace them.
//
// Phases beyond this one (see README):
//   2. Edit + delete
//   3. Categories + tags
//   4. RSS / Atom feed
//   5. Comments (per-post container)
//   6. Multi-author blogs (cross-pod WAC)
//   7. Webmention / federation
//   8. Mashlib pane integration

const POST_PATH = '/public/post/'
const COMMENT_PATH = '/public/comment/'
const LS_LAST_POD = 'plume.lastPod'
const SCHEMA = 'https://schema.org/'
const FOAF = 'http://xmlns.com/foaf/0.1/'

const state = {
  podOrigin: null,
  blogUrl: null,
  posts: [],
  byUrl: new Map(),
  profiles: new Map(),
  // current view: 'home' | 'post' | 'compose'
  view: 'home',
  currentPost: null,
  currentTag: null,
  // Blog identity — derived from the pod owner's WebID profile when we
  // know who owns this pod. Drives the masthead so /?pod=alice.pod and
  // /?pod=bob.pod feel like genuinely different blogs.
  blogOwner: null,        // owner's WebID URL (best-effort guess)
  blogOwnerProfile: null  // { name, picture, bio } once resolved
}

// --- helpers ---

function authFetch(url, opts) {
  if (window.xlogin && window.xlogin.id && window.xlogin.authFetch) {
    return window.xlogin.authFetch(url, opts)
  }
  return fetch(url, opts)
}

function meWebId() { return window.xlogin?.id || null }

function podFromWebId(webId) {
  if (!webId || !webId.startsWith('http')) return null
  try { const u = new URL(webId); return `${u.protocol}//${u.host}` } catch { return null }
}

function escapeHtml(s) {
  if (typeof s !== 'string') s = String(s ?? '')
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function renderMarkdown(md) {
  if (window.marked) {
    try {
      window.marked.use({ breaks: false, gfm: true });
      let html = window.marked.parse(md || '')
      // External links: open in a new tab. Skip in-document fragment refs
      // (#foo) so a footnote/anchor link inside the post stays in-page.
      html = html.replace(/<a (?![^>]*\btarget=)([^>]*?)href="([^"#][^"]*)"/g,
        '<a target="_blank" rel="noopener noreferrer" $1href="$2"')
      return html
    } catch (e) {
      console.warn('marked threw:', e)
    }
  }
  return `<p>${escapeHtml(md || '')}</p>`
}

function excerpt(text, max = 220) {
  if (!text) return ''
  // Strip basic markdown for the excerpt: headings, bold/italic markers, links → text, code fences
  const plain = String(text)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/>\s+/g, '')
    .trim()
  if (plain.length <= max) return plain
  return plain.slice(0, max).replace(/\s+\S*$/, '') + '…'
}

function formatDate(d) {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function hostLabel(webId) {
  try { return new URL(webId).host.split('.')[0] } catch { return webId }
}

function initials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function slugify(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled'
}

// --- profile fetch (name + avatar) ---

async function fetchProfile(webId) {
  if (!webId) return null
  if (state.profiles.has(webId)) return state.profiles.get(webId)
  let resolve
  const pending = new Promise(r => resolve = r)
  state.profiles.set(webId, pending)
  try {
    const r = await fetch(webId, { headers: { Accept: 'application/ld+json' } })
    if (!r.ok) throw new Error(`profile ${r.status}`)
    const doc = await r.json()
    const profile = parseProfile(doc, webId)
    state.profiles.set(webId, profile)
    resolve(profile)
    return profile
  } catch {
    const fallback = { name: hostLabel(webId), picture: null }
    state.profiles.set(webId, fallback)
    resolve(fallback)
    return fallback
  }
}

function parseProfile(doc, webId) {
  const nodes = doc['@graph'] ? (Array.isArray(doc['@graph']) ? doc['@graph'] : [doc['@graph']]) : [doc]
  const target = nodes.find(n =>
    n['@id'] === webId ||
    n['@id'] === '#' + (webId.split('#')[1] || '') ||
    n['@id'] === webId.split('#').pop()
  ) || nodes[0]
  if (!target) return { name: hostLabel(webId), picture: null, bio: null }
  const name =
    target['foaf:name'] || target[FOAF + 'name'] ||
    target['schema:name'] || target[SCHEMA + 'name'] ||
    target['name'] || hostLabel(webId)
  const pic =
    target['foaf:img'] || target[FOAF + 'img'] ||
    target['foaf:depiction'] || target[FOAF + 'depiction'] ||
    target['schema:image'] || target[SCHEMA + 'image'] ||
    target['image'] || null
  const picture = typeof pic === 'string' ? pic : (pic && pic['@id']) || null
  const bio =
    target['schema:description'] || target[SCHEMA + 'description'] ||
    target['bio'] || target['vcard:note'] || null
  return {
    name: String(name || hostLabel(webId)),
    picture,
    bio: typeof bio === 'string' ? bio : (bio && bio['@value']) || null
  }
}

// Best-effort discovery of who owns this pod. Single-user JSS exposes
// the owner at <origin>/profile/card.jsonld#me. We try that first, fall
// back to inferring from a post's author when we read one.
async function discoverBlogOwner(origin) {
  if (!origin) return null
  const guess = origin.replace(/\/$/, '') + '/profile/card.jsonld#me'
  try {
    const r = await fetch(guess.split('#')[0], { headers: { Accept: 'application/ld+json' } })
    if (r.ok) return guess
  } catch {}
  return null
}

function renderMasthead() {
  const brandName = document.querySelector('.brand-name')
  const brandMark = document.querySelector('.brand-mark')
  const tag = document.getElementById('blog-tagline')
  if (!brandName || !tag) return
  const p = state.blogOwnerProfile
  if (p?.name) {
    // Owner-derived blog identity. "Alice's writing" reads natural.
    const ending = p.name.endsWith('s') ? "'" : "'s"
    brandName.textContent = p.name + ending + ' writing'
    brandName.style.fontStyle = 'normal'
    tag.textContent = p.bio || 'light as a feather'
    if (p.picture) {
      brandMark.innerHTML = `<img alt="" src="${escapeHtml(p.picture)}" referrerpolicy="no-referrer">`
      brandMark.style.padding = '0'
      brandMark.style.overflow = 'hidden'
      brandMark.style.borderRadius = '50%'
      brandMark.style.width = '32px'
      brandMark.style.height = '32px'
      brandMark.style.transform = 'translateY(6px)'
    }
  } else {
    brandName.textContent = 'plume'
    tag.textContent = 'light as a feather'
  }
}

// --- blog container + posts ---

async function ensureBlog() {
  // HEAD; if 404, create container via LDP POST. Owner-only.
  const r = await authFetch(state.blogUrl, { method: 'HEAD' })
  if (r.ok) return
  if (r.status !== 404) throw new Error(`HEAD blog: ${r.status}`)
  if (!meWebId()) throw new Error('login required to create the blog container')
  const parent = state.blogUrl.replace(/[^\/]+\/?$/, '')
  const slug = state.blogUrl.split('/').filter(Boolean).pop()
  const c = await authFetch(parent, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/turtle',
      'Slug': slug,
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"'
    },
    body: ''
  })
  if (!c.ok) throw new Error(`create blog: ${c.status}`)
}

async function loadPosts() {
  const r = await authFetch(state.blogUrl, { headers: { Accept: 'application/ld+json' } })
  if (!r.ok) {
    if (r.status === 404) return []
    throw new Error(`load blog: ${r.status}`)
  }
  const doc = await r.json()
  const contains = doc['ldp:contains'] || doc['http://www.w3.org/ns/ldp#contains'] || doc['contains'] || []
  const arr = Array.isArray(contains) ? contains : [contains]
  const urls = arr
    .map(x => typeof x === 'string' ? x : x['@id'])
    .filter(Boolean)
    .filter(u => u.endsWith('.jsonld'))
  const posts = await Promise.all(urls.map(fetchPost))
  return posts
    .filter(Boolean)
    .sort((a, b) => b.dateCreated - a.dateCreated)
}

async function fetchPost(url) {
  try {
    const r = await authFetch(url, { headers: { Accept: 'application/ld+json' } })
    if (!r.ok) return null
    const doc = await r.json()
    return parsePost(doc, url)
  } catch { return null }
}

function parsePost(doc, url) {
  const node = doc['@graph']
    ? (Array.isArray(doc['@graph']) ? doc['@graph'][0] : doc['@graph'])
    : doc
  if (!node) return null
  const headline =
    node['schema:headline'] || node[SCHEMA + 'headline'] || node['headline'] ||
    node['schema:name'] || node[SCHEMA + 'name'] || ''
  const body =
    node['schema:articleBody'] || node[SCHEMA + 'articleBody'] ||
    node['articleBody'] || ''
  const created =
    node['schema:datePublished'] || node[SCHEMA + 'datePublished'] ||
    node['schema:dateCreated'] || node[SCHEMA + 'dateCreated'] ||
    node['datePublished'] || node['dateCreated'] || null
  const author =
    (node['schema:author'] && (node['schema:author']['@id'] || node['schema:author'])) ||
    (node[SCHEMA + 'author'] && (node[SCHEMA + 'author']['@id'] || node[SCHEMA + 'author'])) ||
    node['author'] || null
  const modified =
    node['schema:dateModified'] || node[SCHEMA + 'dateModified'] ||
    node['dateModified'] || null
  const rawKeywords =
    node['schema:keywords'] || node[SCHEMA + 'keywords'] ||
    node['keywords'] || []
  const keywords = normaliseKeywords(rawKeywords)
  if (!headline || !body) return null
  return {
    url,
    headline: String(headline),
    body: String(body),
    author: typeof author === 'string' ? author : author?.['@id'] || null,
    dateCreated: new Date(created || Date.now()),
    dateModified: modified ? new Date(modified) : null,
    keywords
  }
}

// Tags can be serialised three ways: a single string ("a, b, c"), an
// array of strings, or absent. Normalise to a clean string[] of unique
// lower-cased tags with whitespace stripped.
function normaliseKeywords(raw) {
  let arr
  if (Array.isArray(raw)) arr = raw
  else if (typeof raw === 'string') arr = raw.split(',')
  else return []
  const seen = new Set()
  const out = []
  for (const v of arr) {
    const t = String(v).trim().toLowerCase()
    if (!t) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

async function savePost({ headline, body, slug, keywords }) {
  if (!meWebId()) throw new Error('login required to publish')
  await ensureBlog().catch(() => {})
  const ts = Date.now()
  const finalSlug = slug || `${slugify(headline)}-${ts.toString(36)}`
  const filename = `${finalSlug}.jsonld`
  const url = state.blogUrl + filename
  const tags = normaliseKeywords(keywords || [])
  const doc = {
    '@context': { schema: SCHEMA },
    '@id': '',
    '@type': 'schema:BlogPosting',
    'schema:headline': headline,
    'schema:articleBody': body,
    'schema:datePublished': new Date(ts).toISOString(),
    'schema:author': { '@id': meWebId() }
  }
  if (tags.length) doc['schema:keywords'] = tags
  const r = await authFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify(doc, null, 2)
  })
  await throwOnHttpError(r, 'publish')
  const local = parsePost(doc, url)
  if (local) {
    state.posts.unshift(local)
    state.byUrl.set(local.url, local)
  }
  regenerateFeed()
  return url
}

// Update existing post — preserves the original URL, datePublished, author;
// updates headline + articleBody + keywords and stamps schema:dateModified.
async function updatePost(url, { headline, body, keywords }) {
  if (!meWebId()) throw new Error('login required to edit')
  const existing = state.byUrl.get(url) || await fetchPost(url)
  if (!existing) throw new Error('post not found')
  if (existing.author && existing.author !== meWebId()) {
    throw new Error('this post belongs to a different author')
  }
  const tags = normaliseKeywords(keywords || [])
  const doc = {
    '@context': { schema: SCHEMA },
    '@id': '',
    '@type': 'schema:BlogPosting',
    'schema:headline': headline,
    'schema:articleBody': body,
    'schema:datePublished': existing.dateCreated.toISOString(),
    'schema:dateModified': new Date().toISOString(),
    'schema:author': { '@id': existing.author || meWebId() }
  }
  if (tags.length) doc['schema:keywords'] = tags
  const r = await authFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify(doc, null, 2)
  })
  await throwOnHttpError(r, 'save')
  const local = parsePost(doc, url)
  if (local) {
    // Replace in posts list (keep ordering by dateCreated)
    state.posts = state.posts.map(p => p.url === url ? local : p)
    state.byUrl.set(url, local)
  }
  regenerateFeed()
  return url
}

async function deletePost(url) {
  if (!meWebId()) throw new Error('login required to delete')
  const r = await authFetch(url, { method: 'DELETE' })
  if (!r.ok && r.status !== 404) {
    await throwOnHttpError(r, 'delete')
  }
  state.posts = state.posts.filter(p => p.url !== url)
  state.byUrl.delete(url)
  regenerateFeed()
}

// --- Atom feed ---
//
// Each blog is published as a real Atom feed at <pod>/public/post/feed.xml.
// plume rewrites it whenever a post is saved, edited, or deleted (best
// effort — silently skips if not the owner). RSS readers discover it via
// <link rel="alternate" type="application/atom+xml"> in the page head.

const FEED_FILE = 'feed.xml'
const FEED_MAX = 20

function feedUrl() {
  return state.blogUrl ? state.blogUrl + FEED_FILE : null
}

function plumePermalinkFor(postUrl) {
  const base = location.origin + location.pathname
  return `${base}?pod=${encodeURIComponent(state.podOrigin)}&post=${encodeURIComponent(postUrl)}`
}

function blogReaderUrl() {
  const base = location.origin + location.pathname
  return `${base}?pod=${encodeURIComponent(state.podOrigin)}`
}

function buildAtomFeed() {
  const posts = state.posts.slice(0, FEED_MAX)
  const owner = state.blogOwnerProfile
  const ownerWebId = state.blogOwner
  const host = (() => { try { return new URL(state.podOrigin).host } catch { return 'pod' } })()
  const ownerName = owner?.name || host
  const blogTitle = owner?.name
    ? `${owner.name}${owner.name.endsWith('s') ? "'" : "'s"} writing`
    : `${host} — plume`
  const subtitle = owner?.bio || 'light as a feather'
  const self = feedUrl()
  const reader = blogReaderUrl()
  const latest = posts.length
    ? posts.reduce((m, p) => {
        const d = p.dateModified || p.dateCreated
        return d > m ? d : m
      }, new Date(0))
    : new Date()
  const authorBlock = `<name>${escapeHtml(ownerName)}</name>${
    ownerWebId ? `<uri>${escapeHtml(ownerWebId)}</uri>` : ''
  }`
  const entries = posts.map(p => {
    const link = plumePermalinkFor(p.url)
    const html = renderMarkdown(p.body)
    const cats = (p.keywords || [])
      .map(t => `<category term="${escapeHtml(t)}"/>`).join('')
    return `<entry>` +
      `<title>${escapeHtml(p.headline)}</title>` +
      `<link href="${escapeHtml(link)}"/>` +
      `<id>${escapeHtml(p.url)}</id>` +
      `<published>${p.dateCreated.toISOString()}</published>` +
      `<updated>${(p.dateModified || p.dateCreated).toISOString()}</updated>` +
      `<author>${authorBlock}</author>` +
      `<summary>${escapeHtml(excerpt(p.body))}</summary>` +
      `<content type="html">${escapeHtml(html)}</content>` +
      cats +
      `</entry>`
  }).join('')
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>${escapeHtml(blogTitle)}</title>
<subtitle>${escapeHtml(subtitle)}</subtitle>
<link href="${escapeHtml(reader)}"/>
<link rel="self" type="application/atom+xml" href="${escapeHtml(self)}"/>
<id>${escapeHtml(reader)}</id>
<updated>${latest.toISOString()}</updated>
<author>${authorBlock}</author>
<generator uri="https://github.com/solid-apps/plume">plume</generator>
${entries}
</feed>
`
}

async function regenerateFeed() {
  if (!state.blogUrl || !meWebId()) return
  const url = feedUrl()
  if (!url) return
  try {
    const xml = buildAtomFeed()
    await authFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/atom+xml' },
      body: xml
    })
  } catch {
    // Best effort — feed regeneration shouldn't block a publish
  }
}

function installFeedDiscoveryLink() {
  if (!state.blogUrl) return
  const url = feedUrl()
  if (!url) return
  let link = document.querySelector('link[rel="alternate"][type="application/atom+xml"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'alternate'
    link.type = 'application/atom+xml'
    document.head.appendChild(link)
  }
  link.href = url
  link.title = 'Atom feed'
  // Footer subscribe pill
  const sub = document.getElementById('footer-subscribe')
  if (sub) {
    sub.href = url
    sub.hidden = false
  }
}

// --- comments ---
//
// Each post gets a sibling container at <pod>/public/comment/<post-slug>/.
// Comments are schema:Comment JSON-LD resources with schema:about pointing
// at the post URL. Author allows comments by granting ACL write access on
// /public/comment/<post-slug>/ — without that, the form 403s and we say so.

function commentContainerForPost(postUrl) {
  try {
    const u = new URL(postUrl)
    const filename = u.pathname.split('/').pop() || ''
    const slug = filename.replace(/\.jsonld$/, '')
    if (!slug) return null
    return `${u.origin}${COMMENT_PATH}${slug}/`
  } catch { return null }
}

async function loadComments(postUrl) {
  const container = commentContainerForPost(postUrl)
  if (!container) return []
  const r = await authFetch(container, { headers: { Accept: 'application/ld+json' } })
  if (!r.ok) {
    if (r.status === 404 || r.status === 401 || r.status === 403) return []
    throw new Error(`load comments: ${r.status}`)
  }
  const doc = await r.json()
  const contains = doc['ldp:contains'] || doc['http://www.w3.org/ns/ldp#contains'] || doc['contains'] || []
  const arr = Array.isArray(contains) ? contains : [contains]
  const urls = arr
    .map(x => typeof x === 'string' ? x : x['@id'])
    .filter(Boolean)
    .filter(u => u.endsWith('.jsonld'))
  const comments = await Promise.all(urls.map(fetchComment))
  return comments
    .filter(Boolean)
    .sort((a, b) => a.dateCreated - b.dateCreated)
}

async function fetchComment(url) {
  try {
    const r = await authFetch(url, { headers: { Accept: 'application/ld+json' } })
    if (!r.ok) return null
    const doc = await r.json()
    return parseComment(doc, url)
  } catch { return null }
}

function parseComment(doc, url) {
  const node = doc['@graph']
    ? (Array.isArray(doc['@graph']) ? doc['@graph'][0] : doc['@graph'])
    : doc
  if (!node) return null
  const text =
    node['schema:text'] || node[SCHEMA + 'text'] || node['text'] || ''
  const created =
    node['schema:dateCreated'] || node[SCHEMA + 'dateCreated'] ||
    node['dateCreated'] || null
  const author =
    (node['schema:author'] && (node['schema:author']['@id'] || node['schema:author'])) ||
    (node[SCHEMA + 'author'] && (node[SCHEMA + 'author']['@id'] || node[SCHEMA + 'author'])) ||
    node['author'] || null
  if (!text || !created) return null
  return {
    url,
    text: String(text),
    author: typeof author === 'string' ? author : author?.['@id'] || null,
    dateCreated: new Date(created)
  }
}

async function postComment(postUrl, text) {
  if (!meWebId()) throw new Error('login required to comment')
  const container = commentContainerForPost(postUrl)
  if (!container) throw new Error('invalid post URL')
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  const slug = `${ts}-${rand}.jsonld`
  const doc = {
    '@context': { schema: SCHEMA },
    '@id': '',
    '@type': 'schema:Comment',
    'schema:text': text,
    'schema:dateCreated': new Date(ts).toISOString(),
    'schema:author': { '@id': meWebId() },
    'schema:about': { '@id': postUrl }
  }
  // POST to the container (not PUT to a specific URL) so that
  // `acl:Append` permission is enough — Append authorises adding new
  // resources to a container but not arbitrary PUTs.
  const r = await authFetch(container, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/ld+json',
      'Slug': slug
    },
    body: JSON.stringify(doc, null, 2)
  })
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      throw new Error("Couldn't post comment — the blog author hasn't enabled comments on this post.")
    }
    await throwOnHttpError(r, 'comment')
  }
  const loc = r.headers.get('Location') || r.headers.get('location')
  const url = loc
    ? new URL(loc, container).toString()
    : `${container}${slug}`
  return parseComment(doc, url)
}

async function deleteComment(url) {
  if (!meWebId()) throw new Error('login required to delete')
  const r = await authFetch(url, { method: 'DELETE' })
  if (!r.ok && r.status !== 404) await throwOnHttpError(r, 'delete')
}

// --- "Enable comments" toggle ---
//
// When the post author wants others to comment, plume writes a WAC ACL
// on the per-post comment container granting:
//   - owner: full Read/Write/Control (default for any owner-created ACL)
//   - anyone (foaf:Agent): Read so visitors see the discussion
//   - authenticated agents (acl:AuthenticatedAgent): Append so logged-in
//     users can ADD new comments but can't modify/delete existing ones
//
// Disabling removes the ACL — the container falls back to its parent's
// defaults (typically owner-only).

const ACL_NS = 'http://www.w3.org/ns/auth/acl#'
const FOAF_AGENT = 'http://xmlns.com/foaf/0.1/Agent'

function aclUrlForCommentContainer(container) {
  // JSS convention: <container>/.acl (inside the container)
  return container + '.acl'
}

async function commentsEnabled(postUrl) {
  const container = commentContainerForPost(postUrl)
  if (!container) return false
  try {
    const r = await authFetch(aclUrlForCommentContainer(container), {
      headers: { Accept: 'application/ld+json' }
    })
    if (!r.ok) return false
    const doc = await r.json()
    const nodes = doc['@graph']
      ? (Array.isArray(doc['@graph']) ? doc['@graph'] : [doc['@graph']])
      : [doc]
    return nodes.some(n => {
      const types = [].concat(n['@type'] || [])
      if (!types.some(t => t === 'acl:Authorization' || t === ACL_NS + 'Authorization')) return false
      const cls = []
        .concat(n['acl:agentClass'] || [])
        .concat(n[ACL_NS + 'agentClass'] || [])
        .map(x => typeof x === 'string' ? x : x?.['@id'])
        .filter(Boolean)
      const hasAuthClass = cls.some(c =>
        c === 'acl:AuthenticatedAgent' || c === ACL_NS + 'AuthenticatedAgent')
      if (!hasAuthClass) return false
      const modes = []
        .concat(n['acl:mode'] || [])
        .concat(n[ACL_NS + 'mode'] || [])
        .map(x => typeof x === 'string' ? x : x?.['@id'])
        .filter(Boolean)
      return modes.some(m => m === 'acl:Append' || m === ACL_NS + 'Append' ||
                              m === 'acl:Write'  || m === ACL_NS + 'Write')
    })
  } catch { return false }
}

async function enableComments(postUrl) {
  if (!meWebId()) throw new Error('login required')
  const container = commentContainerForPost(postUrl)
  if (!container) throw new Error('invalid post URL')
  // Make sure the container exists before setting its ACL
  await ensureContainer(container)
  const aclUrl = aclUrlForCommentContainer(container)
  const acl = {
    '@context': { acl: ACL_NS },
    '@graph': [
      {
        '@id': '#owner',
        '@type': 'acl:Authorization',
        'acl:accessTo': { '@id': container },
        'acl:default': { '@id': container },
        'acl:agent': { '@id': meWebId() },
        'acl:mode': [
          { '@id': 'acl:Read' },
          { '@id': 'acl:Write' },
          { '@id': 'acl:Control' }
        ]
      },
      {
        '@id': '#anon-read',
        '@type': 'acl:Authorization',
        'acl:accessTo': { '@id': container },
        'acl:default': { '@id': container },
        'acl:agentClass': { '@id': FOAF_AGENT },
        'acl:mode': [{ '@id': 'acl:Read' }]
      },
      {
        '@id': '#auth-append',
        '@type': 'acl:Authorization',
        'acl:accessTo': { '@id': container },
        'acl:default': { '@id': container },
        'acl:agentClass': { '@id': ACL_NS + 'AuthenticatedAgent' },
        'acl:mode': [{ '@id': 'acl:Append' }]
      }
    ]
  }
  const r = await authFetch(aclUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify(acl, null, 2)
  })
  await throwOnHttpError(r, 'enable comments')
}

async function disableComments(postUrl) {
  if (!meWebId()) throw new Error('login required')
  const container = commentContainerForPost(postUrl)
  if (!container) throw new Error('invalid post URL')
  const r = await authFetch(aclUrlForCommentContainer(container), { method: 'DELETE' })
  if (!r.ok && r.status !== 404) await throwOnHttpError(r, 'disable comments')
}

async function ensureContainer(url) {
  const h = await authFetch(url, { method: 'HEAD' })
  if (h.ok) return
  if (h.status !== 404) throw new Error(`HEAD ${url}: ${h.status}`)
  const parent = url.replace(/[^\/]+\/?$/, '')
  const slug = url.split('/').filter(Boolean).pop()
  const c = await authFetch(parent, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/turtle',
      'Slug': slug,
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"'
    },
    body: ''
  })
  if (!c.ok) throw new Error(`create ${url}: ${c.status}`)
}

async function throwOnHttpError(r, action) {
  if (r.ok) return
  let detail = ''
  try {
    const text = (await r.text()).slice(0, 240)
    try { detail = JSON.parse(text).message || text } catch { detail = text }
  } catch {}
  if (r.status === 413) detail = 'too large for server'
  else if (r.status === 401 || r.status === 403) detail = 'forbidden — check login + ACL'
  throw new Error(`Couldn't ${action}: HTTP ${r.status}${detail ? ' — ' + detail : ''}`)
}

// --- rendering ---

function renderHome(tag) {
  state.view = 'home'
  state.currentTag = tag || null
  const page = document.getElementById('page')
  const filtered = tag
    ? state.posts.filter(p => (p.keywords || []).includes(tag))
    : state.posts
  if (state.posts.length === 0) {
    const loggedIn = !!meWebId()
    const host = (() => { try { return new URL(state.blogUrl || '').host } catch { return 'this pod' } })()
    page.innerHTML = `
      <div class="home-empty">
        <h2>${loggedIn ? 'Your blog is empty.' : 'No posts yet.'}</h2>
        <p>${loggedIn
          ? `Write your first post — it'll live on ${escapeHtml(host)} as JSON-LD.`
          : `Log in (top right) to start your blog on ${escapeHtml(host)}.`}</p>
        ${loggedIn ? '<button class="btn-primary" id="empty-new">Write your first post →</button>' : ''}
      </div>`
    if (loggedIn) {
      document.getElementById('empty-new').addEventListener('click', () => goCompose())
    }
    return
  }
  const header = tag
    ? `<div class="home-filter">
         <span class="home-filter-label">Posts tagged</span>
         <span class="tag-chip tag-chip-active">#${escapeHtml(tag)}</span>
         <a class="home-filter-clear" href="?">Clear ×</a>
       </div>`
    : ''
  page.innerHTML = `
    ${header}
    <div class="home" id="home-list"></div>
  `
  const clearLink = page.querySelector('.home-filter-clear')
  if (clearLink) clearLink.addEventListener('click', (e) => { e.preventDefault(); goHome() })
  const list = document.getElementById('home-list')
  if (filtered.length === 0) {
    list.innerHTML = `<p class="home-empty-tag">No posts tagged <strong>#${escapeHtml(tag)}</strong> yet.</p>`
    return
  }
  filtered.forEach(p => list.appendChild(renderPostCard(p)))
}

function renderPostCard(post) {
  const card = document.createElement('article')
  card.className = 'post-card'
  card.innerHTML = `
    <h2 class="post-card-title"></h2>
    <p class="post-card-excerpt"></p>
    <div class="post-card-meta">
      <span class="post-card-avatar"></span>
      <a class="post-card-author" href="#" target="_blank" rel="noopener noreferrer"></a>
      <span class="post-card-sep">·</span>
      <span class="post-card-date"></span>
    </div>
    <div class="post-card-tags"></div>
  `
  card.querySelector('.post-card-title').textContent = post.headline
  card.querySelector('.post-card-excerpt').textContent = excerpt(post.body)
  card.querySelector('.post-card-date').textContent = formatDate(post.dateCreated)
  fillAuthor(card.querySelector('.post-card-avatar'), card.querySelector('.post-card-author'), post.author)
  renderTagChips(card.querySelector('.post-card-tags'), post.keywords)
  card.addEventListener('click', (e) => {
    if (e.target.closest('a, .tag-chip')) return
    goPost(post.url)
  })
  return card
}

function renderTagChips(container, keywords) {
  if (!container) return
  const tags = keywords || []
  if (!tags.length) { container.remove(); return }
  container.innerHTML = ''
  tags.forEach(t => {
    const chip = document.createElement('a')
    chip.className = 'tag-chip'
    chip.href = '?tag=' + encodeURIComponent(t)
    chip.textContent = '#' + t
    chip.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); goTag(t) })
    container.appendChild(chip)
  })
}

function renderPost(post) {
  state.view = 'post'
  state.currentPost = post
  const page = document.getElementById('page')
  const me = meWebId()
  const isMine = post.author === me
  page.innerHTML = `
    <article class="post">
      <a class="post-back" href="?">All posts</a>
      <h1 class="post-title"></h1>
      <header class="post-meta">
        <div class="post-author">
          <span class="post-author-avatar"></span>
          <div class="post-author-info">
            <a class="post-author-name" href="#" target="_blank" rel="noopener noreferrer"></a>
            <span class="post-author-date"></span>
          </div>
        </div>
        <div class="post-actions">
          <a class="text-btn" id="post-source" target="_blank" rel="noopener noreferrer" title="Open the JSON-LD resource">View source</a>
          ${isMine ? `
            <button class="text-btn" id="post-comments-toggle" title="Allow others to comment on this post">Comments: …</button>
            <button class="text-btn" id="post-edit">Edit</button>
            <button class="text-btn danger" id="post-delete">Delete</button>
          ` : ''}
        </div>
      </header>
      <div class="post-tags"></div>
      <div class="post-body"></div>
    </article>
  `
  page.querySelector('.post-title').textContent = post.headline
  page.querySelector('.post-author-date').textContent = formatDate(post.dateCreated)
  renderTagChips(page.querySelector('.post-tags'), post.keywords)
  page.querySelector('.post-body').innerHTML = renderMarkdown(post.body)
  fillAuthor(page.querySelector('.post-author-avatar'), page.querySelector('.post-author-name'), post.author, 'big')
  page.querySelector('.post-back').addEventListener('click', (e) => {
    e.preventDefault()
    goHome()
  })
  page.querySelector('#post-source').href = post.url
  if (isMine) {
    page.querySelector('#post-edit').addEventListener('click', () => goEdit(post.url))
    page.querySelector('#post-delete').addEventListener('click', async () => {
      if (!confirm(`Delete "${post.headline}"? This can't be undone.`)) return
      try {
        await deletePost(post.url)
        showToast('Post deleted.', null, 2400)
        goHome()
      } catch (e) {
        showToast(e.message, null, 6000)
      }
    })
    // Comments toggle — initially fetch status, then bind click to flip it
    const togBtn = page.querySelector('#post-comments-toggle')
    let enabled = false
    commentsEnabled(post.url).then(e => {
      enabled = e
      togBtn.textContent = enabled ? 'Comments: on' : 'Comments: off'
    })
    togBtn.addEventListener('click', async () => {
      const next = !enabled
      togBtn.disabled = true
      togBtn.textContent = next ? 'Enabling…' : 'Disabling…'
      try {
        if (next) await enableComments(post.url)
        else await disableComments(post.url)
        enabled = next
        togBtn.textContent = enabled ? 'Comments: on' : 'Comments: off'
        showToast(enabled
          ? 'Comments enabled — anyone logged in can now comment.'
          : 'Comments disabled.',
          null, 3500)
      } catch (e) {
        togBtn.textContent = enabled ? 'Comments: on' : 'Comments: off'
        showToast(e.message, null, 6000)
      } finally {
        togBtn.disabled = false
      }
    })
  }
  // Show "(edited)" indicator when the post has been updated
  if (post.dateModified) {
    const dateEl = page.querySelector('.post-author-date')
    dateEl.innerHTML = `${formatDate(post.dateCreated)} <span style="opacity:0.7">· edited ${formatDate(post.dateModified)}</span>`
  }

  // Comments section
  renderCommentsSection(post)
}

function renderCommentsSection(post) {
  const article = document.querySelector('.post')
  if (!article) return
  const section = document.createElement('section')
  section.className = 'comments'
  section.innerHTML = `
    <h3 class="comments-heading">Discussion <span class="comments-count" id="comments-count"></span></h3>
    <ol class="comments-list" id="comments-list">
      <li class="comments-loading">Loading conversation…</li>
    </ol>
    ${meWebId() ? `
      <form class="comment-form" id="comment-form">
        <textarea class="comment-input" id="comment-input" placeholder="Add to the conversation…" rows="3"></textarea>
        <div class="comment-form-bar">
          <span class="comment-hint">⌘ + Enter to post</span>
          <button class="btn-primary" id="comment-submit" type="submit" disabled>Comment</button>
        </div>
      </form>
    ` : `
      <p class="comments-login">Log in (top-right) to leave a comment.</p>
    `}
  `
  article.appendChild(section)

  // Load + render comments
  loadComments(post.url)
    .then(comments => renderCommentsList(comments, post))
    .catch(e => {
      const list = document.getElementById('comments-list')
      if (list) list.innerHTML = `<li class="comments-empty">Couldn't load comments: ${escapeHtml(e.message)}</li>`
    })

  // Bind form
  const form = document.getElementById('comment-form')
  if (!form) return
  const input = document.getElementById('comment-input')
  const submit = document.getElementById('comment-submit')
  const refresh = () => { submit.disabled = !input.value.trim() || !meWebId() }
  input.addEventListener('input', refresh)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSubmit() }
  })
  form.addEventListener('submit', (e) => { e.preventDefault(); doSubmit() })
  refresh()

  async function doSubmit() {
    if (submit.disabled) return
    submit.disabled = true
    submit.textContent = 'Posting…'
    try {
      const c = await postComment(post.url, input.value.trim())
      input.value = ''
      // Append the new comment to the list (or remove the empty state)
      const list = document.getElementById('comments-list')
      const empty = list.querySelector('.comments-empty')
      if (empty) empty.remove()
      list.appendChild(renderCommentItem(c, post))
      updateCommentsCount()
    } catch (e) {
      showToast(e.message, null, 7000)
    } finally {
      submit.disabled = false
      submit.textContent = 'Comment'
      refresh()
    }
  }
}

function updateCommentsCount() {
  const list = document.getElementById('comments-list')
  const count = document.getElementById('comments-count')
  if (!list || !count) return
  const n = list.querySelectorAll('.comment').length
  count.textContent = n > 0 ? `· ${n}` : ''
}

function renderCommentsList(comments, post) {
  const list = document.getElementById('comments-list')
  if (!list) return
  if (comments.length === 0) {
    list.innerHTML = `<li class="comments-empty">No comments yet — start the conversation.</li>`
    updateCommentsCount()
    return
  }
  list.innerHTML = ''
  comments.forEach(c => list.appendChild(renderCommentItem(c, post)))
  updateCommentsCount()
}

function renderCommentItem(comment, post) {
  const li = document.createElement('li')
  li.className = 'comment'
  li.dataset.url = comment.url
  const isMine = comment.author === meWebId()
  li.innerHTML = `
    <span class="comment-avatar"></span>
    <div class="comment-body">
      <div class="comment-head">
        <a class="comment-author" href="#" target="_blank" rel="noopener noreferrer"></a>
        <span class="comment-date"></span>
        ${isMine ? '<button class="text-btn comment-delete" title="Delete">×</button>' : ''}
      </div>
      <div class="comment-text"></div>
    </div>
  `
  li.querySelector('.comment-text').textContent = comment.text
  li.querySelector('.comment-date').textContent = formatDate(comment.dateCreated)
  fillAuthor(li.querySelector('.comment-avatar'), li.querySelector('.comment-author'), comment.author)
  if (isMine) {
    li.querySelector('.comment-delete').addEventListener('click', async () => {
      if (!confirm('Delete this comment?')) return
      try {
        await deleteComment(comment.url)
        li.remove()
        updateCommentsCount()
        const list = document.getElementById('comments-list')
        if (list && list.children.length === 0) {
          list.innerHTML = `<li class="comments-empty">No comments yet — start the conversation.</li>`
        }
      } catch (e) {
        showToast(e.message, null, 6000)
      }
    })
  }
  return li
}

function renderCompose(existing) {
  state.view = 'compose'
  state.currentPost = existing || null
  const page = document.getElementById('page')
  page.innerHTML = `
    <div class="compose">
      <a class="post-back" href="?">Cancel</a>
      <input class="compose-title" id="c-title" placeholder="Title" autocomplete="off" />
      <input class="compose-tags" id="c-tags" placeholder="Tags (comma-separated, optional)" autocomplete="off" />
      <textarea class="compose-body" id="c-body" placeholder="Write your post… markdown welcome."></textarea>
      <div class="compose-bar">
        <span class="compose-hint">${existing ? '⌘ + Enter to save' : '⌘ + Enter to publish'}</span>
        <button class="btn-primary" id="c-publish" disabled>${existing ? 'Save' : 'Publish'}</button>
      </div>
    </div>
  `
  const titleEl = document.getElementById('c-title')
  const tagsEl = document.getElementById('c-tags')
  const bodyEl = document.getElementById('c-body')
  const pubBtn = document.getElementById('c-publish')
  if (existing) {
    titleEl.value = existing.headline
    tagsEl.value = (existing.keywords || []).join(', ')
    bodyEl.value = existing.body
  }
  const refresh = () => {
    pubBtn.disabled = !(titleEl.value.trim() && bodyEl.value.trim() && meWebId())
  }
  const autosize = () => {
    bodyEl.style.height = 'auto'
    bodyEl.style.height = Math.max(bodyEl.scrollHeight, window.innerHeight * 0.6) + 'px'
  }
  titleEl.addEventListener('input', refresh)
  tagsEl.addEventListener('input', refresh)
  bodyEl.addEventListener('input', () => { refresh(); autosize() })
  ;[titleEl, tagsEl, bodyEl].forEach(el => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); publish() }
  }))
  pubBtn.addEventListener('click', publish)
  page.querySelector('.post-back').addEventListener('click', (e) => {
    e.preventDefault()
    if (titleEl.value.trim() || bodyEl.value.trim()) {
      if (!confirm('Discard this draft?')) return
    }
    goHome()
  })
  setTimeout(() => { titleEl.focus(); autosize() }, 50)
  refresh()

  async function publish() {
    if (pubBtn.disabled) return
    const isEdit = !!existing
    pubBtn.disabled = true
    pubBtn.textContent = isEdit ? 'Saving…' : 'Publishing…'
    try {
      const keywords = tagsEl.value.split(',')
      const url = isEdit
        ? await updatePost(existing.url, {
            headline: titleEl.value.trim(),
            body: bodyEl.value,
            keywords
          })
        : await savePost({
            headline: titleEl.value.trim(),
            body: bodyEl.value,
            keywords
          })
      showToast(isEdit ? 'Saved.' : 'Published.', null, 2200)
      goPost(url)
    } catch (e) {
      showToast(e.message, null, 6000)
      pubBtn.disabled = false
      pubBtn.textContent = isEdit ? 'Save' : 'Publish'
    }
  }
}

async function fillAuthor(avEl, nameEl, webId, size) {
  if (!webId) {
    avEl.textContent = '?'
    nameEl.textContent = 'unknown'
    return
  }
  nameEl.href = webId
  nameEl.textContent = hostLabel(webId)
  avEl.textContent = initials(hostLabel(webId))
  const profile = await fetchProfile(webId)
  if (!profile) return
  nameEl.textContent = profile.name
  if (profile.picture) {
    avEl.innerHTML = `<img alt="" src="${escapeHtml(profile.picture)}" referrerpolicy="no-referrer">`
  } else {
    avEl.textContent = initials(profile.name)
  }
}

// --- routing ---

function readRoute() {
  const u = new URL(location.href)
  if (u.searchParams.has('new')) return { view: 'compose' }
  const edit = u.searchParams.get('edit')
  if (edit) return { view: 'edit', url: edit }
  const post = u.searchParams.get('post')
  if (post) return { view: 'post', url: post }
  const tag = u.searchParams.get('tag')
  if (tag) return { view: 'home', tag: tag.toLowerCase().trim() }
  return { view: 'home' }
}

function goHome() {
  history.pushState(null, '', location.pathname)
  renderHome()
}
function goTag(tag) {
  const t = String(tag || '').toLowerCase().trim()
  if (!t) { goHome(); return }
  const u = new URL(location.href)
  u.search = '?tag=' + encodeURIComponent(t)
  u.hash = ''
  history.pushState(null, '', u.toString())
  renderHome(t)
}
function goPost(url) {
  const u = new URL(location.href)
  u.search = '?post=' + encodeURIComponent(url)
  u.hash = ''
  history.pushState(null, '', u.toString())
  const post = state.byUrl.get(url)
  if (post) renderPost(post)
  else {
    // Fetch on demand (linked-to from elsewhere)
    fetchPost(url).then(p => {
      if (p) { state.byUrl.set(url, p); renderPost(p) }
      else { showToast('Post not found.', null, 4000); goHome() }
    })
  }
}
function goCompose(existing) {
  history.pushState(null, '', '?new')
  renderCompose(existing)
}
function goEdit(url) {
  const u = new URL(location.href)
  u.search = '?edit=' + encodeURIComponent(url)
  u.hash = ''
  history.pushState(null, '', u.toString())
  const post = state.byUrl.get(url)
  if (post) renderCompose(post)
  else fetchPost(url).then(p => {
    if (p) { state.byUrl.set(url, p); renderCompose(p) }
    else { showToast('Post not found.', null, 4000); goHome() }
  })
}

window.addEventListener('popstate', () => {
  applyRoute()
})

function applyRoute() {
  const route = readRoute()
  if (route.view === 'compose') {
    if (!meWebId()) { showToast('Log in to write.', null, 3000); renderHome(); return }
    renderCompose()
  } else if (route.view === 'edit' && route.url) {
    if (!meWebId()) { showToast('Log in to edit.', null, 3000); renderHome(); return }
    const post = state.byUrl.get(route.url)
    if (post) renderCompose(post)
    else fetchPost(route.url).then(p => {
      if (p) { state.byUrl.set(route.url, p); renderCompose(p) }
      else { showToast('Post not found.', null, 4000); renderHome() }
    })
  } else if (route.view === 'post' && route.url) {
    const post = state.byUrl.get(route.url)
    if (post) renderPost(post)
    else fetchPost(route.url).then(p => {
      if (p) { state.byUrl.set(route.url, p); renderPost(p) }
      else { showToast('Post not found.', null, 4000); renderHome() }
    })
  } else if (route.tag) {
    renderHome(route.tag)
  } else {
    renderHome()
  }
}

// --- identity ---

function renderIdentity() {
  const pill = document.getElementById('topbar-id')
  const newBtn = document.getElementById('btn-new')
  const id = meWebId()
  if (id) {
    let label
    if (id.startsWith('http')) { try { label = new URL(id).host } catch { label = id } }
    else label = id.length > 16 ? id.slice(0, 8) + '…' + id.slice(-4) : id
    pill.textContent = label
    pill.hidden = false
    newBtn.hidden = false
  } else {
    pill.hidden = true
    newBtn.hidden = true
  }
}

function watchLogin() {
  let last = meWebId()
  setInterval(() => {
    const now = meWebId()
    if (now !== last) {
      last = now
      renderIdentity()
      // Re-render current view to surface logged-in affordances
      // (compose button, Edit/Delete, comment form, "Enable comments").
      if (state.view === 'home') renderHome(state.currentTag || undefined)
      else if (state.view === 'post' && state.currentPost) renderPost(state.currentPost)
      // When login state changes, the right pod target may have changed
      // too. If the user is now logged in and their WebID-derived pod
      // differs from what we were defaulting to (e.g. localhost from the
      // dev-mode fallback), re-target onto the real pod. ?pod= still wins.
      const hasExplicitPodParam = (() => {
        try { return !!new URLSearchParams(location.search).get('pod') }
        catch { return false }
      })()
      if (now && !hasExplicitPodParam) {
        const ownPod = podFromWebId(now)
        if (ownPod && ownPod !== state.podOrigin) {
          // Clear cached default so we don't re-pick the wrong pod next time.
          try {
            const cached = localStorage.getItem(LS_LAST_POD)
            if (cached && cached !== ownPod) localStorage.removeItem(LS_LAST_POD)
          } catch {}
          bootForPod(ownPod)
        }
      }
    }
  }, 400)
}

// --- toast ---

let toastTimer = null
function showToast(message, actionFn, duration = 4000) {
  if (!message) return
  const el = document.getElementById('toast')
  document.getElementById('toast-msg').textContent = message
  el.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(hideToast, duration)
}
function hideToast() {
  document.getElementById('toast').hidden = true
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null }
}

// --- boot ---

function defaultPod() {
  try {
    const loc = window.location
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(loc.host)) {
      return `${loc.protocol}//${loc.host}`
    }
  } catch {}
  return 'http://localhost:4443'
}

function pickPodOrigin() {
  // ?pod= overrides everything (explicit user choice).
  try {
    const p = new URLSearchParams(location.search).get('pod')
    if (p) return p
  } catch {}
  // When logged in, prefer the user's own pod (WebID-derived) over any
  // cached value — otherwise a stale "lastPod" from a different session
  // (e.g. localhost while developing) clobbers the obvious right answer
  // once the user is authenticated against a real pod.
  const me = meWebId()
  if (me) {
    const own = podFromWebId(me)
    if (own) return own
  }
  // Not logged in: cache wins (so visitors return to whichever pod's
  // blog they were reading last).
  try {
    const cached = localStorage.getItem(LS_LAST_POD)
    if (cached) return cached
  } catch {}
  return defaultPod()
}

async function bootForPod(origin) {
  if (!origin) return
  state.podOrigin = origin
  state.blogUrl = origin + POST_PATH
  try { localStorage.setItem(LS_LAST_POD, origin) } catch {}
  const fp = document.getElementById('footer-pod')
  fp.textContent = origin
  fp.href = origin
  installFeedDiscoveryLink()

  // Kick off owner discovery + posts fetch in parallel
  const ownerP = discoverBlogOwner(origin).then(async (webId) => {
    if (!webId) return null
    state.blogOwner = webId
    const profile = await fetchProfile(webId)
    state.blogOwnerProfile = profile
    renderMasthead()
    // Update the document title too
    if (profile?.name) document.title = `${profile.name}'s writing — plume`
    return profile
  })

  try {
    const posts = await loadPosts()
    state.posts = posts
    state.byUrl = new Map(posts.map(p => [p.url, p]))
    // If owner discovery failed but a post exists, infer the owner from its author.
    if (!state.blogOwner && posts.length > 0 && posts[0].author) {
      state.blogOwner = posts[0].author
      fetchProfile(posts[0].author).then(p => {
        state.blogOwnerProfile = p
        renderMasthead()
        if (p?.name) document.title = `${p.name}'s writing — plume`
      })
    }
  } catch (e) {
    // ERR_BLOCKED_BY_CLIENT (Brave Shields), mixed-content blocks, CORS:
    // surface a friendly hint rather than a raw stack.
    const msg = /BLOCKED_BY_CLIENT|Failed to fetch|NetworkError/i.test(e.message)
      ? `Couldn't reach ${origin}. If your pod is on HTTP and plume is on HTTPS, the browser blocks the request. Try running plume from the same origin as the pod, or use HTTPS for the pod.`
      : `Couldn't load posts: ${e.message}`
    showToast(msg, null, 8000)
  }
  applyRoute()
  await ownerP  // not strictly needed but lets the masthead settle before next interaction
  // One-shot feed backfill — if I'm the pod owner and there isn't a feed
  // yet (existing blog from before phase 4), write one now so the
  // Subscribe pill resolves to a real Atom feed without a new post.
  if (state.blogOwner && meWebId() === state.blogOwner && state.posts.length > 0) {
    try {
      const h = await authFetch(feedUrl(), { method: 'HEAD' })
      if (h.status === 404) regenerateFeed()
    } catch {}
  }
}

function init() {
  document.getElementById('toast-close').addEventListener('click', hideToast)
  document.getElementById('btn-new').addEventListener('click', () => goCompose())
  document.getElementById('brand').addEventListener('click', (e) => {
    e.preventDefault()
    goHome()
  })
  renderIdentity()
  watchLogin()
  bootForPod(pickPodOrigin())
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
