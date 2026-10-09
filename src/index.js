// Serves Tom's latest Substack posts as JSON for tom-cox.com.
//
// Substack's API doesn't send CORS headers (so the browser can't read it) and
// blocks GitHub Actions, but it answers requests from Cloudflare. This Worker
// fetches the archive and returns the same shape as the site's data/posts.json.

const SUBSTACK_URL = "https://tomcox.substack.com";
const MAX_POSTS = 12;
const TEASER_LENGTH = 220;
const IMAGE_WIDTH = 720;
const CACHE_SECONDS = 300;

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
};

function teaser(value) {
  let text = (value || "").replace(/\s+/g, " ").trim();
  if (text.length > TEASER_LENGTH) {
    text = text.slice(0, TEASER_LENGTH);
    text = text.slice(0, text.lastIndexOf(" ")).replace(/[,.;:]+$/, "") + "…";
  }
  return text;
}

// Substack CDN URLs look like .../image/fetch/$s_!abcd!,f_auto,.../<source>.
// Adding a width after the signature segment serves a much smaller file.
function resizeImage(url) {
  if (!url) return null;
  return url.replace(/(\/image\/fetch\/\$s_![^,/]+!,)/, `$1w_${IMAGE_WIDTH},c_limit,`);
}

// Substack rate-limits requests that look like bots, so send a normal browser UA.
const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
};

async function get(url, accept) {
  const response = await fetch(url, {
    headers: { ...REQUEST_HEADERS, Accept: accept },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response;
}

async function fromApi() {
  const response = await get(`${SUBSTACK_URL}/api/v1/archive?sort=new&limit=${MAX_POSTS}`, "application/json");
  const items = await response.json();
  return items.map((item) => ({
    title: item.title,
    subtitle: teaser(item.subtitle || item.description),
    url: item.canonical_url,
    date: item.post_date ? new Date(item.post_date).toISOString() : null,
    image: resizeImage(item.cover_image),
  }));
}

function decode(value) {
  return (value || "")
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? decode(match[1]) : "";
}

async function fromFeed() {
  const response = await get(`${SUBSTACK_URL}/feed`, "application/rss+xml, application/xml");
  const xml = await response.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, MAX_POSTS).map(([, item]) => {
    const enclosure = item.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image\//);
    const pubDate = tag(item, "pubDate");
    return {
      title: tag(item, "title"),
      subtitle: teaser(tag(item, "description")),
      url: tag(item, "link"),
      date: pubDate ? new Date(pubDate).toISOString() : null,
      image: enclosure ? resizeImage(decode(enclosure[1])) : null,
    };
  });
}

// Try the JSON API, then the RSS feed. Errors from both are reported together.
async function getPosts() {
  const errors = [];
  for (const source of [fromApi, fromFeed]) {
    try {
      const posts = (await source())
        .filter((post) => post.title && (post.url || "").startsWith("https://"))
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      if (posts.length) return posts;
      errors.push(`${source.name}: no posts`);
    } catch (error) {
      errors.push(`${source.name}: ${error.message}`);
    }
  }
  throw new Error(errors.join("; "));
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: HEADERS });

    try {
      const posts = await getPosts();
      const body = { updated: new Date().toISOString(), source: SUBSTACK_URL, posts };
      return new Response(JSON.stringify(body), { headers: HEADERS });
    } catch (error) {
      // The site falls back to its own data/posts.json on any error.
      return new Response(JSON.stringify({ error: error.message }), {
        status: 502,
        headers: { ...HEADERS, "Cache-Control": "no-store" },
      });
    }
  },
};
