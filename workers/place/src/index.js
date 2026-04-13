const MAX_PAGE_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 40_000;
const MAX_STRUCTURED_CHARS = 20_000;


export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(request.url);

      if (!isAuthorized(request, env)) {
        return json({ error: "Unauthorized" }, 401, cors);
      }

      if (request.method === "POST" && url.pathname === "/api/geocode") {
        const body = await request.json();
        const geocode = await getGeocode(body, env);
        return json({ geocode }, 200, cors);
      }

      const isPlacesRequest = request.method === "POST" && (url.pathname === "/api/places" || url.pathname === "/api/places/web");
      if (!isPlacesRequest) {
        return json({ error: "Not found" }, 404, cors);
      }

      const body = await request.json();
      const metadataMode = metadataModeForRequest(url, body);
      const placeUrl = normalizePlaceUrl(body.url);
      const page = await getPlacePage(placeUrl, env);
      const metadata = await resolveMetadata(page, env, metadataMode);
      const geocode = await getGeocode(metadata, env);
      const place = buildPlace(page, metadata, geocode);

      return json({ place }, 200, cors);
    } catch (error) {
      return json({ error: messageFromError(error) }, 400, cors);
    }
  }
};

function isAuthorized(request, env) {
  if (!env.APP_TOKEN) return true;
  const authorization = request.headers.get("Authorization") || "";
  const explicit = request.headers.get("X-Locus-Token") || "";
  return authorization === `Bearer ${env.APP_TOKEN}` || explicit === env.APP_TOKEN;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

  const allowOrigin = origin && (allowed.includes("*") || allowed.includes(origin)) ? origin : "";
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Locus-Token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
  }

  return headers;
}

function normalizePlaceUrl(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("URL is required");
  }

  const text = input.trim();
  const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported");
  }

  if (isBlockedHost(url.hostname)) {
    throw new Error("This URL is not allowed");
  }

  url.hash = "";
  return url.toString();
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (host === "::1" || host.startsWith("[::1]")) return true;
  return false;
}

function metadataModeForRequest(url, body) {
  const value = String(body.metadataMode || body.metadata || url.searchParams.get("metadata") || "").toLowerCase();
  return url.pathname === "/api/places/web" || value === "web" ? "web" : "page";
}

async function fetchPlacePage(placeUrl) {
  const response = await fetch(placeUrl, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1",
      "User-Agent": "LocusBot/0.1 (+https://github.com)"
    }
  });

  if (!response.ok) {
    throw new Error(`Page returned ${response.status}`);
  }

  const contentType = response.headers.get("Content-Type") || "";
  if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
    throw new Error("URL did not return a page-like document");
  }

  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PAGE_BYTES) {
    throw new Error("Page is too large");
  }

  const html = await response.text();
  if (html.length > MAX_PAGE_BYTES) {
    throw new Error("Page is too large");
  }

  return extractPage(response.url || placeUrl, html, placeUrl);
}

async function getPlacePage(placeUrl, env) {
  try {
    return await fetchPlacePage(placeUrl);
  } catch (error) {
    const directError = messageFromError(error);
    const readerPage = await fetchReaderFallback(placeUrl, directError, env);
    if (readerPage) return readerPage;

    const fallback = fallbackPage(placeUrl, directError);
    console.warn(`Page fetch failed for ${placeUrl}: ${fallback.fetchError}`);
    return fallback;
  }
}

async function fetchReaderFallback(placeUrl, directError, env) {
  if (!env.READER_FALLBACK_URL) return null;

  try {
    const readerUrl = `${env.READER_FALLBACK_URL.replace(/\/+$/, "")}/${placeUrl}`;
    const response = await fetch(readerUrl, {
      headers: {
        "Accept": "text/plain, text/markdown;q=0.9, */*;q=0.1",
        "User-Agent": "LocusBot/0.1 (+https://github.com)"
      }
    });

    if (!response.ok) {
      throw new Error(`Reader fallback returned ${response.status}`);
    }

    const markdown = await response.text();
    if (!markdown.trim()) {
      throw new Error("Reader fallback returned no content");
    }

    const page = extractReaderPage(placeUrl, markdown.slice(0, MAX_TEXT_CHARS));
    page.fetchStatus = "reader_fallback";
    page.fetchError = directError;
    return page;
  } catch (error) {
    console.warn(`Reader fallback failed for ${placeUrl}: ${messageFromError(error)}`);
    return null;
  }
}

function extractReaderPage(placeUrl, markdown) {
  const url = new URL(placeUrl);
  const source = url.hostname.replace(/^www\./, "");
  const title = getReaderField(markdown, "Title") || titleFromMarkdown(markdown) || titleFromUrl(url);
  const sourceUrl = getReaderField(markdown, "URL Source") || placeUrl;
  const content = markdown
    .replace(/^Title:.*$/im, "")
    .replace(/^URL Source:.*$/im, "")
    .replace(/^Published Time:.*$/im, "")
    .replace(/^Markdown Content:\s*$/im, "")
    .trim();
  const text = markdownToText(content);

  return {
    url: placeUrl,
    canonicalUrl: sourceUrl,
    source,
    siteName: source,
    title,
    description: "",
    text,
    structuredData: "",
    wordCount: countWords(text)
  };
}

function getReaderField(markdown, field) {
  const match = markdown.match(new RegExp(`^${escapeRegExp(field)}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || "";
}

function titleFromMarkdown(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.replace(/\s+\|\s+.+$/, "").trim() || "";
}

function fallbackPage(placeUrl, fetchError) {
  const url = new URL(placeUrl);
  const source = url.hostname.replace(/^www\./, "");
  const title = titleFromUrl(url) || `Place from ${source}`;

  return {
    url: placeUrl,
    canonicalUrl: placeUrl,
    source,
    siteName: source,
    title,
    description: "",
    text: `${title}. Place metadata could not be extracted from ${source}.`,
    structuredData: "",
    wordCount: 0,
    fetchStatus: "failed",
    fetchError
  };
}

function extractPage(placeUrl, html, requestedUrl = placeUrl) {
  const url = new URL(placeUrl);
  const googleFallback = extractGoogleSearchFallback(html, url);
  if (isGoogleShareHandoff(requestedUrl, url) && googleFallback) {
    return googleSearchPage(requestedUrl, url, googleFallback);
  }

  const source = url.hostname.replace(/^www\./, "");
  const title = getMeta(html, ["og:title", "twitter:title"]) || getTitle(html) || titleFromUrl(url);
  const description = getMeta(html, ["description", "og:description", "twitter:description"]);
  const siteName = getMeta(html, ["og:site_name", "application-name"]) || source;
  const canonicalUrl = getCanonicalUrl(html, url) || placeUrl;
  const structuredData = extractStructuredData(html).slice(0, MAX_STRUCTURED_CHARS);
  const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
  const wordCount = countWords(text);

  return {
    url: placeUrl,
    canonicalUrl,
    originalUrl: requestedUrl,
    source,
    siteName,
    title,
    description,
    text,
    structuredData,
    wordCount
  };
}

function isGoogleShareHandoff(requestedUrl, resolvedUrl) {
  const requested = safeUrl(requestedUrl);
  return requested?.hostname === "share.google" ||
    (resolvedUrl.hostname.endsWith("google.com") && resolvedUrl.pathname === "/share.google");
}

function extractGoogleSearchFallback(html, baseUrl) {
  const matches = html.matchAll(/href=["']([^"']*\/search\?[^"']*?q=[^"']+)["']/gi);

  for (const match of matches) {
    try {
      const url = new URL(decodeEntities(match[1]), baseUrl);
      const query = url.searchParams.get("q") || "";
      if (query.trim()) {
        return {
          url: googleSearchUrl(query.trim()),
          query: query.trim()
        };
      }
    } catch {
      // Keep looking for a usable search fallback.
    }
  }

  return null;
}

function googleSearchUrl(query) {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  return url;
}

function googleSearchPage(requestedUrl, resolvedUrl, fallback) {
  const title = fallback.query;
  return {
    url: fallback.url.toString(),
    canonicalUrl: fallback.url.toString(),
    originalUrl: requestedUrl,
    source: resolvedUrl.hostname.replace(/^www\./, ""),
    siteName: "Google Search",
    title,
    description: `Google shared search: ${title}`,
    text: title,
    structuredData: "",
    searchQuery: title,
    wordCount: countWords(title),
    fetchStatus: "google_search_fallback"
  };
}

async function resolveMetadata(page, env, mode = "page") {
  if (mode === "web" || !hasWebMetadataWorker(env)) {
    return getMetadata(page, env, mode);
  }

  const [pageMetadata, webMetadata] = await Promise.all([
    getMetadata(page, env, "page"),
    getMetadata(page, env, "web")
  ]);
  return metadataScore(webMetadata) > metadataScore(pageMetadata) ? webMetadata : pageMetadata;
}

function hasWebMetadataWorker(env) {
  return Boolean(env.METADATA_WEB?.fetch || env.METADATA_WEB_WORKER_URL);
}

function metadataScore(metadata) {
  let score = 0;
  const hasAddress = Boolean(metadata.address);
  const hasCity = Boolean(metadata.city);

  if (metadata.name) score += 1;
  if (hasAddress) score += 6;
  if (hasCity) score += 3;
  if (metadata.country) score += 1;
  if (metadata.type && metadata.type !== "Other") score += 1;
  if (metadata.description) score += 1;
  if (Array.isArray(metadata.tags) && metadata.tags.length) score += 1;
  if (hasAddress && hasCity) score += 4;
  if ((hasAddress || hasCity) && Number.isFinite(numberOrNull(metadata.lat)) && Number.isFinite(numberOrNull(metadata.lng))) score += 2;
  if (metadata.isRelevantPlace === false) score -= 6;
  return score;
}

async function getMetadata(page, env, mode = "page") {
  try {
    return await askMetadataWorker(page, env, mode);
  } catch (error) {
    return fallbackMetadata(page, messageFromError(error), mode);
  }
}

async function askMetadataWorker(page, env, mode = "page") {
  const binding = mode === "web" ? env.METADATA_WEB : env.METADATA;
  const workerUrl = mode === "web" ? env.METADATA_WEB_WORKER_URL : env.METADATA_WORKER_URL;
  const label = mode === "web" ? "Web metadata Worker" : "Metadata Worker";
  const request = new Request("https://metadata.local/metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(page)
  });

  let serviceBindingError = null;

  if (binding?.fetch) {
    let response;
    try {
      response = await binding.fetch(request);
    } catch (error) {
      serviceBindingError = error;
    }

    if (response) {
      if (!response.ok) {
        throw new Error(await responseError(response, `${label} failed`));
      }
      return response.json();
    }
  }

  if (workerUrl) {
    const response = await fetch(new URL("/metadata", workerUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(page)
    });
    if (!response.ok) {
      throw new Error(await responseError(response, `${label} failed`));
    }
    return response.json();
  }

  if (serviceBindingError) {
    throw serviceBindingError;
  }

  throw new Error(`${label} is not configured`);
}

function fallbackMetadata(page, error, mode = "page") {
  const description = page.description || summarize(page.text);
  return {
    name: page.title || titleFromUrl(new URL(page.url)),
    address: "",
    city: "",
    country: "",
    type: "Other",
    description,
    tags: inferTags(`${page.title} ${page.text}`),
    canonicalUrl: page.canonicalUrl || page.url,
    isRelevantPlace: false,
    metadataMode: mode,
    status: "metadata_incomplete",
    error
  };
}

async function getGeocode(metadata, env) {
  const lat = numberOrNull(metadata.lat);
  const lng = numberOrNull(metadata.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return {
      status: "metadata",
      lat,
      lng,
      city: metadata.city || "",
      country: metadata.country || ""
    };
  }

  try {
    return await askGeocodeWorker(metadata, env);
  } catch (error) {
    return {
      status: "geocode_failed",
      error: messageFromError(error)
    };
  }
}

async function askGeocodeWorker(metadata, env) {
  const body = {
    name: metadata.name,
    address: metadata.address,
    city: metadata.city,
    country: metadata.country,
    type: metadata.type
  };
  const request = new Request("https://geocode.local/geocode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  let serviceBindingError = null;

  if (env.GEOCODE?.fetch) {
    let response;
    try {
      response = await env.GEOCODE.fetch(request);
    } catch (error) {
      serviceBindingError = error;
    }

    if (response) {
      if (!response.ok) {
        throw new Error(await responseError(response, "Geocode Worker failed"));
      }
      return response.json();
    }
  }

  if (env.GEOCODE_WORKER_URL) {
    const response = await fetch(new URL("/geocode", env.GEOCODE_WORKER_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(await responseError(response, "Geocode Worker failed"));
    }
    return response.json();
  }

  if (serviceBindingError) {
    throw serviceBindingError;
  }

  throw new Error("Geocode Worker is not configured");
}

async function responseError(response, fallback) {
  try {
    const payload = await response.json();
    if (typeof payload.error === "string" && payload.error) {
      return payload.error;
    }
  } catch {
    // Fall through to status text.
  }

  return `${fallback}: ${response.status}`;
}

function buildPlace(page, metadata, geocode) {
  const metadataLat = numberOrNull(metadata.lat);
  const metadataLng = numberOrNull(metadata.lng);
  const lat = numberOrNull(geocode.lat) ?? metadataLat;
  const lng = numberOrNull(geocode.lng) ?? metadataLng;
  const address = metadata.address || geocode.displayAddress || "";
  const city = metadata.city || geocode.city || "";
  const country = countryName(metadata.country) || geocode.country || "";
  const geocodeStatus = geocode.status === "ready"
    ? "ready"
    : Number.isFinite(metadataLat) && Number.isFinite(metadataLng) ? "metadata" : geocode.status || "not_found";
  const status = deriveStatus(metadata, geocodeStatus, { address, city, lat, lng });
  const error = [page.fetchError, metadata.error, geocode.error].filter(Boolean).join("; ");

  return {
    id: crypto.randomUUID(),
    url: page.url,
    originalUrl: page.originalUrl || page.url,
    canonicalUrl: metadata.canonicalUrl || page.canonicalUrl || page.url,
    source: page.source,
    metadataMode: metadata.metadataMode || "",
    name: displayName(metadata.name, geocode.name, page.title || titleFromUrl(new URL(page.url))),
    address,
    city,
    country,
    type: metadata.type || "Other",
    description: metadata.description || page.description || summarize(page.text),
    tags: Array.isArray(metadata.tags) ? metadata.tags.slice(0, 8) : [],
    lat,
    lng,
    osmId: geocode.osmId || "",
    osmType: geocode.osmType || "",
    geocodeStatus,
    dateAdded: new Date().toISOString(),
    status,
    error
  };
}

function displayName(metadataName, geocodeName, fallback) {
  const name = metadataName || fallback;
  if (geocodeName && /\s+\|\s+/.test(name)) return geocodeName;
  return name || geocodeName || fallback;
}

function deriveStatus(metadata, geocodeStatus, fields) {
  if (metadata.status === "metadata_incomplete" || metadata.isRelevantPlace === false) {
    return "metadata_incomplete";
  }

  if (!fields.address || !fields.city) {
    return "metadata_incomplete";
  }

  if (!Number.isFinite(fields.lat) || !Number.isFinite(fields.lng) || geocodeStatus === "geocode_failed" || geocodeStatus === "not_found") {
    return "geocode_failed";
  }

  return "ready";
}

function getMeta(html, names) {
  for (const name of names) {
    const pattern = new RegExp(`<meta\\s+[^>]*(?:name|property)=["']${escapeRegExp(name)}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
    const reversePattern = new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${escapeRegExp(name)}["'][^>]*>`, "i");
    const match = html.match(pattern) || html.match(reversePattern);
    if (match?.[1]) return decodeEntities(match[1].trim());
  }
  return "";
}

function getTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeEntities(match[1].replace(/\s+/g, " ").trim()) : "";
}

function getCanonicalUrl(html, baseUrl) {
  const match = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i);
  if (!match?.[1]) return "";
  try {
    return new URL(decodeEntities(match[1]), baseUrl).toString();
  } catch {
    return "";
  }
}

function extractStructuredData(html) {
  const chunks = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match = pattern.exec(html);
  while (match) {
    if (match[1]?.trim()) {
      chunks.push(decodeEntities(match[1].replace(/<[^>]*>/g, " ").trim()));
    }
    match = pattern.exec(html);
  }

  const squarespaceLocation = extractSquarespaceLocation(html);
  if (squarespaceLocation) {
    chunks.push(JSON.stringify(squarespaceLocation));
  }

  return chunks.join("\n\n");
}

function extractSquarespaceLocation(html) {
  const marker = "Static.SQUARESPACE_CONTEXT";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;

  const assignmentIndex = html.indexOf("=", markerIndex);
  if (assignmentIndex < 0) return null;

  const start = html.indexOf("{", assignmentIndex);
  if (start < 0) return null;

  const raw = readJsonObject(html, start);
  if (!raw) return null;

  try {
    const context = JSON.parse(raw);
    const website = context.website || {};
    const location = website.location || {};
    if (!location.addressLine1 && !location.addressLine2 && !location.markerLat && !location.markerLng) return null;

    const parsedLine2 = parseAddressLine2(location.addressLine2);
    const country = location.addressCountry || countryName(context.websiteSettings?.country) || "";

    return {
      "@type": "LocalBusiness",
      "name": location.addressTitle || website.siteTitle || website.siteName || "",
      "description": website.siteDescription || "",
      "address": {
        "@type": "PostalAddress",
        "streetAddress": location.addressLine1 || "",
        "addressLocality": parsedLine2.city,
        "addressRegion": parsedLine2.region,
        "postalCode": parsedLine2.postalCode,
        "addressCountry": country
      },
      "geo": {
        "@type": "GeoCoordinates",
        "latitude": location.markerLat ?? location.mapLat ?? "",
        "longitude": location.markerLng ?? location.mapLng ?? ""
      }
    };
  } catch {
    return null;
  }
}

function readJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return "";
}

function parseAddressLine2(value) {
  const parts = String(value || "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);

  return {
    city: parts[0] || "",
    region: parts[1] || "",
    postalCode: parts.slice(2).join(", ")
  };
}

function countryName(code) {
  const countries = {
    CA: "Canada",
    US: "United States",
    GB: "United Kingdom"
  };
  const text = String(code || "").trim();
  if (!text) return "";
  return countries[text.toUpperCase()] || text;
}

function htmlToText(html) {
  return decodeEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(?:p|br|li|h[1-6]|div|section|article|blockquote|tr|address)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function markdownToText(markdown) {
  return decodeEntities(markdown)
    .replace(/^#{2,}\s+.*$/gm, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\\([\\`*_{}\[\]()#+\-.!])/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[#>*_`~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function safeUrl(input) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function titleFromUrl(url) {
  const slug = url.pathname.split("/").filter(Boolean).pop() || url.hostname;
  return slug
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[-_]+/g)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function summarize(text) {
  const sentences = String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => sentence.length > 40);

  return sentences.slice(0, 2).join(" ").slice(0, 700) || "";
}

function inferTags(text) {
  const stop = new Set(["about", "after", "again", "also", "because", "before", "being", "between", "could", "every", "first", "from", "have", "into", "more", "most", "other", "over", "some", "than", "that", "their", "there", "these", "this", "through", "what", "when", "where", "which", "while", "with", "would"]);
  const counts = new Map();
  const words = String(text).toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];

  for (const word of words) {
    if (stop.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return Array.from(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => slugify(word))
    .filter(Boolean);
}

function numberOrNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function countWords(text) {
  return (String(text || "").match(/\S+/g) || []).length;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function messageFromError(error) {
  return error instanceof Error ? error.message : "Request failed";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
