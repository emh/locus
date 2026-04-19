const PLACE_TYPE_RULES = [
  ["bakery", /\b(bakery|boulangerie|patisserie|p\u00e2tisserie|pastry shop)\b/],
  ["cafe", /\b(caf[e\u00e9]|coffee shop|coffeehouse|tea house|tearoom)\b/],
  ["restaurant", /\b(restaurant|diner|bistro|brasserie|trattoria|pizzeria|taqueria|izakaya|ramen|sushi|omakase|yakitori|steakhouse|eatery|food hall|noodle|noodles|bbq|barbecue|tapas|fine dining)\b/],
  ["bar", /\b(cocktail bar|wine bar|bar|pub|brewery|taproom|biergarten|speakeasy|lounge)\b/],
  ["museum", /\b(museum)\b/],
  ["gallery", /\b(gallery)\b/],
  ["gym", /\b(gym|fitness|fitness center|fitness centre|yoga studio|pilates studio)\b/],
  ["bookstore", /\b(bookstore|bookshop)\b/],
  ["market", /\b(market|grocery|supermarket|farmers market|food market)\b/],
  ["hotel", /\b(hotel|motel|inn|resort|hostel)\b/],
  ["park", /\b(park|garden|playground|beach)\b/],
  ["music venue", /\b(music venue|concert hall|live music|jazz club)\b/],
  ["theater", /\b(theater|theatre|cinema|movie theater|movie theatre)\b/],
  ["shop", /\b(shop|store|boutique|retailer|florist)\b/],
  ["salon", /\b(salon|barbershop|barber shop)\b/],
  ["spa", /\b(spa)\b/],
  ["library", /\b(library)\b/],
  ["school", /\b(school|college|university)\b/],
  ["venue", /\b(venue|event space|event hall)\b/]
];

const BROAD_PLACE_TYPES = new Set([
  "restaurant",
  "bar",
  "cafe",
  "bakery",
  "museum",
  "gallery",
  "gym",
  "bookstore",
  "market",
  "hotel",
  "park",
  "music venue",
  "theater",
  "shop",
  "salon",
  "spa",
  "library",
  "school",
  "venue"
]);

export function normalizePlace(place) {
  const source = place.source || hostFromUrl(place.url);
  const lat = numberOrNull(place.lat);
  const lng = numberOrNull(place.lng);
  const status = place.status || getDerivedStatus(place, lat, lng);

  return {
    id: String(place.id || crypto.randomUUID()),
    url: place.url,
    originalUrl: place.originalUrl || place.url,
    canonicalUrl: place.canonicalUrl || place.url,
    source,
    name: stringOr(place.name, titleFromUrl(place.url, source)),
    address: stringOr(place.address, ""),
    city: stringOr(place.city, ""),
    state: stringOr(place.state, ""),
    country: stringOr(place.country, ""),
    type: normalizeType(place.type),
    tags: normalizeTags(place.tags),
    description: stringOr(place.description, ""),
    notes: stringOr(place.notes, ""),
    lat,
    lng,
    osmId: place.osmId || "",
    osmType: place.osmType || "",
    geocodeStatus: place.geocodeStatus || "",
    dateAdded: place.dateAdded || new Date().toISOString(),
    dateUpdated: place.dateUpdated || "",
    status,
    error: place.error || "",
    isFavorite: Boolean(place.isFavorite)
  };
}

export function placeNeedsReview(place) {
  return !place.name ||
    !place.address ||
    !place.city ||
    !Number.isFinite(place.lat) ||
    !Number.isFinite(place.lng) ||
    place.status === "metadata_incomplete" ||
    place.status === "geocode_failed";
}

function getDerivedStatus(place, lat, lng) {
  if (!place.name || !place.address || !place.city) return "metadata_incomplete";
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "geocode_failed";
  return "ready";
}

export function normalizePlaceType(type) {
  const text = stringOr(type, "Other").replace(/\s+/g, " ").trim();
  const normalized = text.toLowerCase();
  if (!normalized || normalized === "other") return "Other";

  for (const [label, pattern] of PLACE_TYPE_RULES) {
    if (pattern.test(normalized)) return label;
  }

  if (BROAD_PLACE_TYPES.has(normalized)) return normalized;
  return normalized.length > 80 ? normalized.slice(0, 80).trim() : normalized;
}

function normalizeType(type) {
  return normalizePlaceType(type);
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map(tag => String(tag || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .slice(0, 8);
}

function numberOrNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "place";
  }
}

function titleFromUrl(input, fallback) {
  try {
    const url = new URL(input);
    const slug = url.pathname.split("/").filter(Boolean).pop() || fallback || url.hostname;
    return slug
      .replace(/\.[a-z0-9]+$/i, "")
      .split(/[-_]+/g)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  } catch {
    return fallback || "Untitled place";
  }
}
