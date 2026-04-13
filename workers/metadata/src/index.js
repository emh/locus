const MAX_PROMPT_CHARS = 28_000;
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

const SCHEMA_TYPE_MAP = new Map([
  ["Restaurant", "Restaurant"],
  ["FoodEstablishment", "Restaurant"],
  ["BarOrPub", "Bar"],
  ["CafeOrCoffeeShop", "Cafe"],
  ["Museum", "Museum"],
  ["Store", "Shop"],
  ["BookStore", "Shop"],
  ["ShoppingCenter", "Shop"],
  ["GroceryStore", "Market"],
  ["Hotel", "Hotel"],
  ["Park", "Park"],
  ["TouristAttraction", "Attraction"],
  ["LandmarksOrHistoricalBuildings", "Attraction"],
  ["EventVenue", "Venue"],
  ["MusicVenue", "Venue"],
  ["PerformingArtsTheater", "Venue"],
  ["HealthClub", "Fitness"],
  ["ExerciseGym", "Fitness"]
]);

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/metadata") {
        return json({ error: "Not found" }, 404);
      }

      const page = await request.json();
      const metadata = await createMetadata(page, env);
      return json(metadata, 200);
    } catch (error) {
      return json({ error: messageFromError(error) }, 400);
    }
  }
};

async function createMetadata(page, env) {
  if (env.MOCK_LLM === "true") {
    return heuristicMetadata(page);
  }

  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when MOCK_LLM is false");
  }

  if (!env.OPENAI_MODEL) {
    throw new Error("OPENAI_MODEL is required when MOCK_LLM is false");
  }

  return extractWithOpenAI(page, env);
}

async function extractWithOpenAI(page, env) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: `Extract place metadata for a private map/list app. Use only the provided page text, page hints, and structured data. If the page is not about one specific physical place, set isRelevantPlace to false and leave unknown fields empty. Use one type from this list: ${PLACE_TYPES.join(", ")}. Put descriptive details in tags, not type. Return concise, factual JSON.`
        },
        {
          role: "user",
          content: placePrompt(page)
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "place_metadata",
          strict: true,
          schema: metadataSchema()
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(await openAIError(response, "OpenAI metadata request failed"));
  }

  const payload = await response.json();
  const outputText = getOutputText(payload);
  if (!outputText) throw new Error("OpenAI returned no metadata text");

  return normalizeMetadata(JSON.parse(outputText), page);
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

function placePrompt(page) {
  return [
    `URL: ${page.url || ""}`,
    `Canonical URL: ${page.canonicalUrl || ""}`,
    `Original URL: ${page.originalUrl || ""}`,
    `Search query hint: ${page.searchQuery || ""}`,
    `Page title: ${page.title || ""}`,
    `Page description: ${page.description || ""}`,
    `Publisher hint: ${page.siteName || page.source || ""}`,
    "",
    "Structured data:",
    String(page.structuredData || "").slice(0, MAX_PROMPT_CHARS / 2),
    "",
    "Page text:",
    String(page.text || "").slice(0, MAX_PROMPT_CHARS)
  ].join("\n");
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

function normalizeMetadata(metadata, page) {
  const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
  const haystack = `${metadata.name || ""} ${metadata.type || ""} ${metadata.description || ""} ${tags.join(" ")} ${page.title || ""}`;
  const name = stringOr(metadata.name, page.title || titleFromUrl(page.url));
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
    description: stringOr(metadata.description, page.description || summarize(page.text)),
    tags: tags.map(tag => slugify(tag)).filter(Boolean).slice(0, 8),
    canonicalUrl: stringOr(metadata.canonicalUrl, page.canonicalUrl || page.url),
    lat: stringOr(metadata.lat, ""),
    lng: stringOr(metadata.lng, ""),
    isRelevantPlace,
    status: isRelevantPlace && name && (address || city) ? "ready" : "metadata_incomplete",
    error: ""
  };
}

function heuristicMetadata(page) {
  if (page.searchQuery) {
    return heuristicSearchQueryMetadata(page);
  }

  const structured = structuredMetadata(page);
  const name = structured.name || page.title || titleFromUrl(page.url);
  const description = structured.description || page.description || summarize(page.text);
  const type = normalizeType(structured.type, `${name} ${description} ${page.text}`);
  const address = structured.address || "";
  const city = structured.city || "";
  const tags = structured.tags.length ? structured.tags : inferTags(`${name} ${description} ${page.text}`);
  const isRelevantPlace = Boolean(address || city || structured.lat || structured.lng || type !== "Other");

  return {
    name,
    address,
    city,
    country: structured.country || "",
    type,
    description,
    tags,
    canonicalUrl: page.canonicalUrl || page.url,
    lat: structured.lat || "",
    lng: structured.lng || "",
    isRelevantPlace,
    status: isRelevantPlace && name && (address || city) ? "ready" : "metadata_incomplete",
    error: ""
  };
}

function heuristicSearchQueryMetadata(page) {
  const parsed = parsePlaceSearchQuery(page.searchQuery);
  const name = parsed.name || page.title || titleFromUrl(page.url);

  return {
    name,
    address: "",
    city: parsed.city,
    country: parsed.country,
    type: parsed.type,
    description: page.description || `Shared from Google Search: ${page.searchQuery}`,
    tags: parsed.tags,
    canonicalUrl: page.canonicalUrl || page.url,
    lat: "",
    lng: "",
    isRelevantPlace: Boolean(name),
    status: name ? "ready" : "metadata_incomplete",
    error: ""
  };
}

function parsePlaceSearchQuery(query) {
  const parts = String(query || "")
    .split(/\s+-\s+/)
    .map(part => part.trim())
    .filter(Boolean);
  const name = parts[0] || "";
  const rest = parts.slice(1).join(" ");
  const city = inferCity(`${rest} ${query}`);
  const country = countryForCity(city);
  const typeText = city
    ? (parts[1] || "").replace(new RegExp(`\\b${escapeRegExp(city)}\\b`, "i"), "").trim()
    : (parts[1] || "").trim();
  const type = normalizeType(typeText, query);
  const tags = [
    typeText,
    ...parts.slice(2)
  ].map(tag => slugify(tag)).filter(Boolean).slice(0, 8);

  return {
    name,
    city,
    country,
    type,
    tags
  };
}

function inferCity(text) {
  const cities = [
    "Vancouver",
    "Toronto",
    "Montreal",
    "New York",
    "Portland",
    "London",
    "Paris",
    "Tokyo",
    "Hanoi",
    "Los Angeles",
    "San Francisco",
    "Seattle",
    "Chicago"
  ];

  return cities.find(city => new RegExp(`\\b${escapeRegExp(city)}\\b`, "i").test(text)) || "";
}

function countryForCity(city) {
  const countries = new Map([
    ["Vancouver", "Canada"],
    ["Toronto", "Canada"],
    ["Montreal", "Canada"],
    ["New York", "United States"],
    ["Portland", "United States"],
    ["Los Angeles", "United States"],
    ["San Francisco", "United States"],
    ["Seattle", "United States"],
    ["Chicago", "United States"],
    ["London", "United Kingdom"],
    ["Paris", "France"],
    ["Tokyo", "Japan"],
    ["Hanoi", "Vietnam"]
  ]);

  return countries.get(city) || "";
}

function structuredMetadata(page) {
  const nodes = parseStructuredNodes(page.structuredData);
  const place = pickPlaceNode(nodes) || {};
  const rawAddress = place.address;
  const address = typeof rawAddress === "object" && rawAddress ? rawAddress : {};
  const addressText = typeof rawAddress === "string" ? rawAddress.trim() : formatAddress(address);
  const parsedAddress = parseAddressText(addressText);
  const geo = typeof place.geo === "object" && place.geo ? place.geo : {};
  const schemaTypes = getSchemaTypes(place);

  return {
    name: stringOr(place.name, ""),
    address: addressText,
    city: stringOr(address.addressLocality, parsedAddress.city),
    country: stringOr(address.addressCountry?.name || address.addressCountry, parsedAddress.country),
    type: schemaTypes.map(type => SCHEMA_TYPE_MAP.get(type)).find(Boolean) || "",
    description: stringOr(place.description, ""),
    tags: schemaTypes.map(type => slugify(type)).filter(Boolean).slice(0, 6),
    lat: stringOr(geo.latitude, ""),
    lng: stringOr(geo.longitude, "")
  };
}

function pickPlaceNode(nodes) {
  return nodes
    .filter(node => isPlaceNode(node))
    .sort((a, b) => placeNodeScore(b) - placeNodeScore(a))[0] || null;
}

function placeNodeScore(node) {
  const address = node?.address;
  const geo = node?.geo;
  let score = 0;

  if (node?.name) score += 1;
  if (typeof address === "string" && address.trim()) score += 2;
  if (typeof address === "object" && address) {
    if (address.streetAddress) score += 3;
    if (address.addressLocality) score += 2;
    if (address.addressCountry) score += 1;
  }
  if (typeof geo === "object" && geo && (geo.latitude || geo.longitude)) score += 4;

  return score;
}

function parseStructuredNodes(raw) {
  const nodes = [];
  for (const chunk of String(raw || "").split(/\n{2,}/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    try {
      collectStructuredNodes(JSON.parse(trimmed), nodes);
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }
  return nodes;
}

function collectStructuredNodes(value, nodes) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredNodes(item, nodes);
    return;
  }
  if (typeof value !== "object") return;

  nodes.push(value);
  if (value["@graph"]) collectStructuredNodes(value["@graph"], nodes);
  if (value.itemListElement) collectStructuredNodes(value.itemListElement, nodes);
}

function isPlaceNode(node) {
  const types = getSchemaTypes(node);
  return types.some(type =>
    SCHEMA_TYPE_MAP.has(type) ||
    type === "LocalBusiness" ||
    type === "Place" ||
    type.endsWith("Business")
  );
}

function getSchemaTypes(node) {
  const raw = node?.["@type"];
  if (Array.isArray(raw)) return raw.map(String);
  if (raw) return [String(raw)];
  return [];
}

function formatAddress(address) {
  if (typeof address === "string") return address.trim();
  return [
    address.streetAddress,
    address.addressLocality,
    address.addressRegion,
    address.postalCode,
    address.addressCountry?.name || address.addressCountry
  ].filter(Boolean).join(", ");
}

function parseAddressText(value) {
  const text = String(value || "").trim();
  const lines = text
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);

  const tail = lines.length > 1 ? lines.slice(1).join(", ") : text;
  const parts = tail
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);

  return {
    city: parts[0] || "",
    country: parts.length > 1 ? parts[parts.length - 1] : ""
  };
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

function normalizeType(type, fallbackText = "") {
  const text = String(type || "").trim();
  if (PLACE_TYPES.includes(text)) return text;

  const haystack = `${text} ${fallbackText}`;
  for (const [label, matcher] of TYPE_MATCHERS) {
    if (matcher.test(haystack)) return label;
  }

  return "Other";
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
