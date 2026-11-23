import Parser from 'rss-parser';

interface FeedCache {
  url: string;
  timestamp: number;
  items: Array<{ title: string; link: string; pubDate?: string; category?: string }>;
}

let cachedFeed: FeedCache | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const parser = new Parser();

export function clearRssCache(): void {
  cachedFeed = null;
}

export async function fetchRssFeed(feedUrl: string): Promise<Array<{ title: string; link: string; pubDate?: string; category?: string }>> {
  const now = Date.now();

  if (cachedFeed && cachedFeed.url === feedUrl && now - cachedFeed.timestamp < CACHE_TTL_MS) {
    return cachedFeed.items;
  }

  const urls = String(feedUrl || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  try {
    if (urls.length === 0) throw new Error('Nenhuma fonte de notícias configurada');
    const allItems: Array<{ title: string; link: string; pubDate?: string; category?: string }> = [];

    for (const url of urls) {
      const category = url.includes('ge.globo') ? 'ESPORTES'
        : (url.includes('tecnologia') || url.includes('ciencia') || url.includes('educacao') ? 'CURIOSIDADES'
        : 'REGIÃO');
      const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

      const rawText = await response.text();
    // Strip BOM and any leading characters before first '<'
    const firstTagIdx = rawText.indexOf('<');
    const cleanXml = firstTagIdx >= 0 ? rawText.slice(firstTagIdx).trim() : rawText.trim();

    const feed = await parser.parseString(cleanXml);
      const items = (feed.items || []).slice(0, 10).map((item) => ({
      title: (item.title || 'Sem título').replace(/\s+/g, ' ').trim(),
      link: item.link || '',
      pubDate: item.pubDate || '',
      category
    }));
      allItems.push(...items);
    }

    if (allItems.length === 0) throw new Error('Nenhum feed retornou notícias');

    cachedFeed = {
      url: feedUrl,
      timestamp: now,
      items: allItems.slice(0, 30)
    };

    return cachedFeed.items;
  } catch (err: any) {
    console.warn(`[RSS Service] Failed to fetch news feeds: ${err.message}. No unverified fallback news will be shown.`);
    return [];
  }
}
