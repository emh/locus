const DEFAULT_OPENAI_MODEL = "gpt-5";

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

      if (request.method !== "POST" || url.pathname !== "/api/places") {
        return json({ error: "Not found" }, 404, cors);
      }

      const body = await request.json();
      const placeUrl = normalizePlaceUrl(body.url);
      const metadata = await getMetadata(placeUrl, env);
      const geocode = await getGeocode(metadata, env);
      const place = buildPlace(placeUrl, metadata, geocode);

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

async function getMetadata(placeUrl, env) {
  const target = await metadataTarget(placeUrl);

  try {
    if (env.MOCK_LLM === "true") {
      return heuristicMetadata(target);
    }

    return await extractMetadataWithOpenAI(target, env);
  } catch (error) {
    return fallbackMetadata(target, messageFromError(error));
  }
}

async function extractMetadataWithOpenAI(target, env) {
  const apiKey = stringOr(env.OPENAI_API_KEY, "");
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required when MOCK_LLM is false");
  }

  const body = {
    model: stringOr(env.OPENAI_MODEL, DEFAULT_OPENAI_MODEL),
    input: [
      {
        role: "system",
        content: systemPrompt()
      },
      {
        role: "user",
        content: userPrompt(target)
      }
    ],
    tools: [
      { type: "web_search" }
    ],
    tool_choice: "auto",
    include: ["web_search_call.action.sources"],
    text: {
      format: {
        type: "json_schema",
        name: "place_metadata",
        strict: true,
        schema: metadataSchema()
      }
    }
  };

  const reasoning = reasoningConfig(env);
  if (reasoning) body.reasoning = reasoning;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(await openAIError(response, "OpenAI metadata request failed"));
  }

  const payload = await response.json();
  const outputText = getOutputText(payload);
  if (!outputText) throw new Error("OpenAI returned no metadata text");

  const metadata = normalizeMetadata(JSON.parse(outputText), target);
  const sources = extractSources(payload);
  if (sources.length) metadata.sources = sources;
  return metadata;
}

function systemPrompt() {
  return [
    "The user will provide the URL for a place they need metadata for.",
    "Examine the supplied URL and determine the type of place it is, the name, the address, the lat/lng coordinates, a short description, and tags.",
    "Use web search to open the exact supplied URL first, follow redirects, and resolve short links or map share links when needed.",
    "If a search query hint is supplied, treat it as the intended place query from the share link and use it to search for the exact place.",
    "For Google Maps or share.google links, prefer the Google Maps place result's displayed address and coordinates when available.",
    "If the URL is a share URL, search result, or interstitial, identify the intended place only when the URL or page clearly points to one physical place.",
    "You may navigate further within the supplied website, especially contact, location, about, menu, hours, store, reservation, and booking pages.",
    "For canonicalUrl, find the place's actual official website URL when available. For Google Maps or share.google URLs, do not return the Google share URL as canonicalUrl unless no better official website can be determined.",
    "Prefer the place's official website over aggregators, social profiles, map listings, or unrelated businesses with similar names.",
    "If no official website URL can be determined, use the supplied URL as canonicalUrl.",
    "If the page is not about one specific physical place, set isRelevantPlace to false and leave unknown fields empty.",
    "For address, return a complete display address, preserving enough detail to identify the right city, state/province, postal code, and country when available.",
    "Actively look for exact decimal lat/lng coordinates on the official site, map pages, or search results; leave them empty only when you cannot verify them.",
    "Choose a concise place type yourself, for example restaurant, cocktail bar, museum, gym, bookstore, market, hotel, park, or music venue.",
    "Put descriptive details in tags, not type. Do not invent missing facts.",
    "Return structured output that exactly matches the schema."
  ].join(" ");
}

function userPrompt(target) {
  return [
    `URL: ${target.url}`,
    `Resolved URL hint: ${target.resolvedUrl}`,
    `Search query hint: ${target.searchQuery}`,
    `Host hint: ${target.source}`,
    "",
    "Extract these fields:",
    "- name: public place name",
    "- address: full display address, including unit or suite, cross-streets, neighborhood, postal code, state/province, and country when available",
    "- city: locality only, without state, province, postal code, or country",
    "- state: state, province, prefecture, region, or equivalent administrative area when available",
    "- country: full country name when known",
    "- type: concise model-chosen place type",
    "- description: one short factual description",
    "- tags: short descriptive tags such as cuisine, atmosphere, specialty, collection, or activity",
    "- canonicalUrl: official website URL for the place when known, otherwise the supplied URL",
    "- lat and lng: exact decimal degrees as strings; search for them and leave empty only if not verified",
    "- isRelevantPlace: false unless the URL resolves to one specific physical place"
  ].join("\n");
}

function metadataSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["name", "address", "city", "state", "country", "type", "description", "tags", "canonicalUrl", "lat", "lng", "isRelevantPlace"],
    properties: {
      name: { type: "string" },
      address: { type: "string" },
      city: { type: "string" },
      state: { type: "string" },
      country: { type: "string" },
      type: { type: "string" },
      description: { type: "string" },
      tags: {
        type: "array",
        maxItems: 8,
        items: { type: "string" }
      },
      canonicalUrl: { type: "string" },
      lat: { type: "string" },
      lng: { type: "string" },
      isRelevantPlace: { type: "boolean" }
    }
  };
}

function reasoningConfig(env) {
  const effort = stringOr(env.OPENAI_REASONING_EFFORT, "");
  if (!effort) return null;
  if (!["minimal", "low", "medium", "high"].includes(effort)) return null;
  return { effort };
}

async function metadataTarget(placeUrl) {
  const shareHint = await googleShareHint(placeUrl);
  return {
    url: placeUrl,
    resolvedUrl: shareHint.resolvedUrl,
    searchQuery: shareHint.searchQuery,
    source: sourceFromUrl(placeUrl)
  };
}

async function googleShareHint(placeUrl) {
  const url = safeUrl(placeUrl);
  if (!isGoogleShareUrl(url)) {
    return {
      resolvedUrl: "",
      searchQuery: ""
    };
  }

  try {
    const response = await fetch(placeUrl, {
      headers: {
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1",
        "User-Agent": "LocusBot/0.1 (+https://github.com)"
      }
    });
    const html = await response.text();

    return {
      resolvedUrl: response.url || "",
      searchQuery: extractGoogleSearchQuery(html, safeUrl(response.url) || url)
    };
  } catch (error) {
    console.warn(`Google share hint failed for ${placeUrl}: ${messageFromError(error)}`);
    return {
      resolvedUrl: "",
      searchQuery: ""
    };
  }
}

function isGoogleShareUrl(url) {
  return url?.hostname === "share.google" ||
    (url?.hostname.endsWith("google.com") && url?.pathname === "/share.google");
}

function extractGoogleSearchQuery(html, baseUrl) {
  const matches = String(html || "").matchAll(/href=["']([^"']*\/search\?[^"']*?q=[^"']+)["']/gi);

  for (const match of matches) {
    try {
      const url = new URL(decodeEntities(match[1]), baseUrl);
      const query = url.searchParams.get("q") || "";
      if (query.trim()) return query.trim();
    } catch {
      // Keep looking for a usable search fallback.
    }
  }

  return "";
}

function normalizeMetadata(metadata, target) {
  const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
  const name = stringOr(metadata.name, titleFromUrl(target.url));
  const address = stringOr(metadata.address, "");
  const city = stringOr(metadata.city, "");
  const state = stringOr(metadata.state, "");
  const lat = stringOr(metadata.lat, "");
  const lng = stringOr(metadata.lng, "");
  const type = cleanType(metadata.type);
  const isRelevantPlace = typeof metadata.isRelevantPlace === "boolean"
    ? metadata.isRelevantPlace
    : Boolean(name && (address || city || (lat && lng) || type !== "Other"));

  return {
    name,
    address,
    city,
    state,
    country: stringOr(metadata.country, ""),
    type,
    description: stringOr(metadata.description, ""),
    tags: tags.map(tag => slugify(tag)).filter(Boolean).slice(0, 8),
    canonicalUrl: stringOr(metadata.canonicalUrl, target.url),
    lat,
    lng,
    isRelevantPlace,
    status: isRelevantPlace && name && (address || city) ? "ready" : "metadata_incomplete",
    error: ""
  };
}

function heuristicMetadata(target) {
  const name = titleFromUrl(target.url);
  return {
    name,
    address: "",
    city: "",
    state: "",
    country: "",
    type: "Other",
    description: "",
    tags: [],
    canonicalUrl: target.url,
    lat: "",
    lng: "",
    isRelevantPlace: false,
    status: "metadata_incomplete",
    error: ""
  };
}

function fallbackMetadata(target, error) {
  return {
    name: titleFromUrl(target.url),
    address: "",
    city: "",
    state: "",
    country: "",
    type: "Other",
    description: "",
    tags: [],
    canonicalUrl: target.url,
    lat: "",
    lng: "",
    isRelevantPlace: false,
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
      state: metadata.state || "",
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
    state: metadata.state,
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

function buildPlace(placeUrl, metadata, geocode) {
  const metadataLat = numberOrNull(metadata.lat);
  const metadataLng = numberOrNull(metadata.lng);
  const geocodeLat = numberOrNull(geocode.lat);
  const geocodeLng = numberOrNull(geocode.lng);
  const lat = geocodeLat ?? metadataLat;
  const lng = geocodeLng ?? metadataLng;
  const address = metadata.address || geocode.displayAddress || "";
  const city = metadata.city || geocode.city || "";
  const state = metadata.state || geocode.state || "";
  const country = countryName(metadata.country) || geocode.country || "";
  const name = displayName(metadata.name, geocode.name, titleFromUrl(placeUrl));
  const geocodeStatus = geocode.status === "ready"
    ? "ready"
    : Number.isFinite(metadataLat) && Number.isFinite(metadataLng) ? "metadata" : geocode.status || "not_found";
  const status = deriveStatus(metadata, geocodeStatus, { name, address, city, lat, lng });
  const error = [metadata.error, geocode.error].filter(Boolean).join("; ");
  const canonicalUrl = metadata.canonicalUrl || placeUrl;

  return {
    id: crypto.randomUUID(),
    url: placeUrl,
    originalUrl: placeUrl,
    canonicalUrl,
    source: sourceFromUrl(canonicalUrl || placeUrl),
    name,
    address,
    city,
    state,
    country,
    type: metadata.type || "Other",
    description: metadata.description || "",
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
  if (metadata.isRelevantPlace === false) {
    return "metadata_incomplete";
  }

  if (!fields.name || !fields.address || !fields.city) {
    return "metadata_incomplete";
  }

  if (!Number.isFinite(fields.lat) || !Number.isFinite(fields.lng) || geocodeStatus === "geocode_failed" || geocodeStatus === "not_found") {
    return "geocode_failed";
  }

  return "ready";
}

function cleanType(type) {
  const text = String(type || "").trim().replace(/\s+/g, " ");
  if (!text) return "Other";
  return text.length > 80 ? text.slice(0, 80).trim() : text;
}

function safeUrl(input) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function sourceFromUrl(input) {
  try {
    return new URL(input).hostname.replace(/^www\./, "");
  } catch {
    return "place";
  }
}

function titleFromUrl(input) {
  try {
    const url = new URL(input);
    const slug = url.pathname.split("/").filter(Boolean).pop() || url.hostname;
    return slug
      .replace(/\.[a-z0-9]+$/i, "")
      .split(/[-_]+/g)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  } catch {
    return "Untitled place";
  }
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

function numberOrNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOr(value, fallback) {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function getOutputText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;

  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }

  return chunks.join("");
}

function extractSources(payload) {
  const sources = new Map();

  for (const item of payload.output || []) {
    const actionSources = item.action?.sources || [];
    for (const source of actionSources) addSource(sources, source);

    for (const content of item.content || []) {
      const annotations = content.annotations || [];
      for (const annotation of annotations) {
        if (annotation.type === "url_citation") addSource(sources, annotation);
      }
    }
  }

  return Array.from(sources.values()).slice(0, 20);
}

function addSource(sources, source) {
  const url = stringOr(source.url, "");
  if (!url || sources.has(url)) return;
  sources.set(url, {
    url,
    title: stringOr(source.title, "")
  });
}

async function openAIError(response, fallback) {
  try {
    const payload = await response.json();
    const message = payload?.error?.message || payload?.error || payload?.message;
    if (typeof message === "string" && message) {
      return `${fallback}: ${message}`;
    }
  } catch {
    // Fall through to status text.
  }

  return `${fallback}: ${response.status}`;
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

function json(payload, status, headers = {}) {
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
