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

async function getPosts() {
  const response = await fetch(`${SUBSTACK_URL}/api/v1/archive?sort=new&limit=${MAX_POSTS}`, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`Substack returned HTTP ${response.status}`);

  const items = await response.json();
  return items
    .filter((item) => item.title && item.canonical_url && item.canonical_url.startsWith("https://"))
    .map((item) => ({
      title: item.title,
      subtitle: teaser(item.subtitle || item.description),
      url: item.canonical_url,
      date: item.post_date ? new Date(item.post_date).toISOString() : null,
      image: resizeImage(item.cover_image),
    }));
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: HEADERS });

    try {
      const posts = await getPosts();
      if (!posts.length) throw new Error("No posts");
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
