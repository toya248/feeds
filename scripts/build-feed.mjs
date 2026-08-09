import { writeFile, mkdir } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: { maxTotalExpansions: 50000 },
});

const MAX_PER_SOURCE = 10;
const SUMMARY_LENGTH = 160;

const SOURCES = [
  {
    id: 'bluesky',
    label: 'Bluesky',
    kind: 'bluesky',
    url: 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=toya.bsky.social&limit=20',
  },
  {
    id: 'mastodon',
    label: 'Mastodon',
    kind: 'rss',
    url: 'https://mstdn.toya.blog/@toya.rss',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    kind: 'atom',
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCgELkfTT1fOzhhCocW_07sw',
  },
  {
    id: 'hatena',
    label: 'ブログ (はてな)',
    kind: 'rss',
    url: 'https://toya.hatenablog.com/rss',
  },
  {
    id: 'diary',
    label: '日記',
    kind: 'rss',
    url: 'https://diary.toya.blog/rss',
  },
  {
    id: 'substack',
    label: 'ニュースレター',
    kind: 'rss',
    url: 'https://toya.substack.com/feed',
  },
];

function decodeEntities(text = '') {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripHtml(html = '') {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function truncate(text = '', length = SUMMARY_LENGTH) {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function pickAlternateLink(link) {
  const links = toArray(link);
  const alt = links.find((l) => l?.['@_rel'] === 'alternate') ?? links[0];
  return alt?.['@_href'] ?? '';
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'toya-feed-aggregator/1.0' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'toya-feed-aggregator/1.0' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function loadRss(source) {
  const xml = await fetchText(source.url);
  const parsed = parser.parse(xml);
  const items = toArray(parsed?.rss?.channel?.item);
  return items.slice(0, MAX_PER_SOURCE).map((item) => {
    const description = stripHtml(String(item.description ?? ''));
    const title = stripHtml(String(item.title ?? ''));
    return {
      source: source.id,
      sourceLabel: source.label,
      title: title || truncate(description, 60) || '(タイトルなし)',
      url: item.link ?? '',
      publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      summary: truncate(description),
    };
  });
}

async function loadAtom(source) {
  const xml = await fetchText(source.url);
  const parsed = parser.parse(xml);
  const entries = toArray(parsed?.feed?.entry);
  return entries.slice(0, MAX_PER_SOURCE).map((entry) => {
    const description = stripHtml(
      String(entry['media:group']?.['media:description'] ?? entry.summary ?? '')
    );
    return {
      source: source.id,
      sourceLabel: source.label,
      title: stripHtml(String(entry.title ?? '')) || '(タイトルなし)',
      url: pickAlternateLink(entry.link),
      publishedAt: entry.published ? new Date(entry.published).toISOString() : null,
      summary: truncate(description),
    };
  });
}

async function loadBluesky(source) {
  const data = await fetchJson(source.url);
  const feed = toArray(data?.feed);
  return feed
    .filter((item) => item?.post?.author?.handle === 'toya.bsky.social' && !item.reason)
    .slice(0, MAX_PER_SOURCE)
    .map((item) => {
      const post = item.post;
      const text = String(post?.record?.text ?? '');
      const rkey = post?.uri?.split('/').pop();
      return {
        source: source.id,
        sourceLabel: source.label,
        title: truncate(text, 60) || '(本文なし)',
        url: rkey ? `https://bsky.app/profile/${post.author.handle}/post/${rkey}` : '',
        publishedAt: post?.record?.createdAt ? new Date(post.record.createdAt).toISOString() : null,
        summary: truncate(text),
      };
    });
}

async function loadSource(source) {
  try {
    if (source.kind === 'rss') return await loadRss(source);
    if (source.kind === 'atom') return await loadAtom(source);
    if (source.kind === 'bluesky') return await loadBluesky(source);
    throw new Error(`unknown source kind: ${source.kind}`);
  } catch (err) {
    console.error(`[warn] failed to load ${source.id}: ${err.message}`);
    return [];
  }
}

async function main() {
  const results = await Promise.all(SOURCES.map(loadSource));
  const entries = results
    .flat()
    .filter((entry) => entry.url && entry.publishedAt)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const output = {
    generatedAt: new Date().toISOString(),
    entries,
  };

  const dataDir = new URL('../data/', import.meta.url);
  await mkdir(dataDir, { recursive: true });
  await writeFile(new URL('feed.json', dataDir), `${JSON.stringify(output, null, 2)}\n`);

  console.log(`wrote ${entries.length} entries to data/feed.json`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
