const PLACE_TYPES = [
  "Restaurant",
  "Bar",
  "Cafe",
  "Museum",
  "Shop",
  "Market",
  "Hotel",
  "Park",
  "Attraction",
  "Venue",
  "Fitness",
  "Other"
];


const TYPE_MATCHERS = [
  ["Restaurant", /\b(restaurant|diner|bistro|trattoria|pizzeria|sushi|ramen|taqueria|brasserie|izakaya)\b/i],
  ["Bar", /\b(bar|pub|cocktail|brewery|taproom|wine)\b/i],
  ["Cafe", /\b(cafe|coffee|espresso|bakery|tea)\b/i],
  ["Museum", /\b(museum|gallery|exhibit|exhibition)\b/i],
  ["Shop", /\b(shop|store|bookstore|boutique|retail)\b/i],
  ["Market", /\b(market|food hall|bazaar)\b/i],
  ["Hotel", /\b(hotel|inn|hostel|resort)\b/i],
  ["Park", /\b(park|garden|trail|beach)\b/i],
  ["Attraction", /\b(attraction|landmark|monument|temple|church|cathedral|shrine)\b/i],
  ["Venue", /\b(venue|theater|theatre|club|hall|arena)\b/i],
  ["Fitness", /\b(fitness|gym|personal trainer|training|athletic|athletics|pilates|yoga)\b/i]
];

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/metadata") {
        return json({ error: "Not found" }, 404);
      }

      const input = await request.json();
      const metadata = await extractMetadata(input, env);
      return json(metadata, 200);
    } catch (error) {
      return json({ error: messageFromError(error) }, 400);
    }
  }
};

async function extractMetadata(input, env) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }

  if (!env.OPENAI_MODEL) {
    throw new Error("OPENAI_MODEL is required");
  }

  const target = normalizeInput(input);
  const body = {
    model: env.OPENAI_MODEL,
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
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(await openAIError(response, "OpenAI web metadata request failed"));
  }

  const payload = await response.json();
  const outputText = getOutputText(payload);
  if (!outputText) throw new Error("OpenAI returned no metadata text");

  const metadata = normalizeMetadata(JSON.parse(outputText), target);
  const sources = extractSources(payload);
  if (sources.length) metadata.sources = sources;
  return metadata;
}

function normalizeInput(input) {
  const url = stringOr(input?.originalUrl, input?.url || input?.canonicalUrl || "");
  if (!url) throw new Error("URL is required");

  const targetUrl = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported");
  }

  targetUrl.hash = "";

  return {
    url: targetUrl.toString(),
    fetchedUrl: stringOr(input?.url, ""),
    canonicalUrl: stringOr(input?.canonicalUrl, ""),
    title: stringOr(input?.title, ""),
    description: stringOr(input?.description, ""),
    searchQuery: stringOr(input?.searchQuery, ""),
    siteName: stringOr(input?.siteName, ""),
    source: stringOr(input?.source, "")
  };
}

function systemPrompt() {
  return [
    "Extract place metadata for a private map/list app.",
    "Use the web search tool. Start by visiting the exact supplied URL. Follow redirects.",
    "If the URL is a share URL, search page, or interstitial, identify the intended place only when the URL or page clearly points to one place.",
    "You may navigate further within the supplied website, especially contact, location, about, menu, hours, store, reservation, and booking pages.",
    "Prefer the place's official website over aggregators or unrelated businesses with similar names.",
    "If the page is not about one specific physical place, set isRelevantPlace to false and leave unknown fields empty.",
    `Use one type from this list: ${PLACE_TYPES.join(", ")}.`,
    "Put descriptive details in tags, not type. Do not invent missing facts.",
    "Return concise, factual JSON that matches the schema."
  ].join(" ");
}

function userPrompt(target) {
  return [
    `URL to visit: ${target.url}`,
    `Fetched URL hint: ${target.fetchedUrl}`,
    `Canonical URL hint: ${target.canonicalUrl}`,
    `Search query hint: ${target.searchQuery}`,
    `Page title hint: ${target.title}`,
    `Page description hint: ${target.description}`,
    `Publisher hint: ${target.siteName || target.source}`,
    "",
    "Extract these fields:",
    "- name: public place name",
    "- address: street address, including unit/suite when available",
    "- city: locality only, without state, province, postal code, or country",
    "- country",
    "- type",
    "- description: one short factual description",
    "- tags: short descriptive tags",
    "- canonicalUrl: official page URL for the place",
    "- lat/lng when confidently available on the official site",
    "- isRelevantPlace"
  ].join("\n");
}

function reasoningConfig(env) {
  const effort = stringOr(env.OPENAI_REASONING_EFFORT, "");
  if (!effort) return null;
  if (!["minimal", "low", "medium", "high"].includes(effort)) return null;
  return { effort };
}

function metadataSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["name", "address", "city", "country", "type", "description", "tags", "canonicalUrl", "lat", "lng", "isRelevantPlace"],
    properties: {
      name: { type: "string" },
      address: { type: "string" },
      city: { type: "string" },
      country: { type: "string" },
      type: { type: "string", enum: PLACE_TYPES },
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

function normalizeMetadata(metadata, target) {
  const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
  const haystack = `${metadata.name || ""} ${metadata.type || ""} ${metadata.description || ""} ${tags.join(" ")} ${target.title || ""}`;
  const name = stringOr(metadata.name, target.title || titleFromUrl(target.url));
  const address = stringOr(metadata.address, "");
  const city = stringOr(metadata.city, "");
  const type = normalizeType(metadata.type, haystack);
  const isRelevantPlace = typeof metadata.isRelevantPlace === "boolean"
    ? metadata.isRelevantPlace
    : Boolean(name && (address || city || type !== "Other"));

  return {
    name,
    address,
    city,
    country: stringOr(metadata.country, ""),
    type,
    description: stringOr(metadata.description, target.description),
    tags: tags.map(tag => slugify(tag)).filter(Boolean).slice(0, 8),
    canonicalUrl: stringOr(metadata.canonicalUrl, target.canonicalUrl || target.url),
    lat: stringOr(metadata.lat, ""),
    lng: stringOr(metadata.lng, ""),
    isRelevantPlace,
    metadataMode: "web",
    status: isRelevantPlace && name && (address || city) ? "ready" : "metadata_incomplete",
    error: ""
  };
}

function normalizeType(type, fallbackText = "") {
  const text = String(type || "").trim();
  if (PLACE_TYPES.includes(text)) return text;

  const haystack = `${text} ${fallbackText}`;
  for (const [label, matcher] of TYPE_MATCHERS) {
    if (matcher.test(haystack)) return label;
  }

  return "Other";
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

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function messageFromError(error) {
  return error instanceof Error ? error.message : "Request failed";
}
