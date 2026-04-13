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

function normalizeType(type) {
  const text = stringOr(type, "Other");
  if (text.length > 28 || /[&/]/.test(text)) return "Other";
  return text;
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
