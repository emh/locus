const DEFAULT_ENDPOINT = "https://nominatim.openstreetmap.org";
const DEFAULT_USER_AGENT = "LocusPersonalApp/0.1";
const CACHE_MAX_AGE = 60 * 60 * 24 * 30;


export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/geocode") {
        return json({ error: "Not found" }, 404);
      }

      const place = await request.json();
      const result = await geocode(place, env);
      return json(result, 200, {
        "Cache-Control": `public, max-age=${CACHE_MAX_AGE}`
      });
    } catch (error) {
      return json({ error: messageFromError(error) }, 400);
    }
  }
};

async function geocode(place, env) {
  const queries = buildQueries(place);
  if (!queries.length) {
    return {
      status: "not_found",
      error: "No address or city to geocode"
    };
  }

  const cached = await readCache(queries);
  if (cached) return cached;

  for (const query of queries) {
    const searchUrl = buildSearchUrl(query, env);
    const response = await fetch(searchUrl, {
      headers: {
        "Accept": "application/json",
        "User-Agent": env.NOMINATIM_USER_AGENT || DEFAULT_USER_AGENT,
        "Referer": "https://locus.local/"
      }
    });

    if (!response.ok) {
      throw new Error(`Nominatim returned ${response.status}`);
    }

    const results = await response.json();
    const result = normalizeResult(pickResult(Array.isArray(results) ? results : [], place, query));
    if (result.status === "ready" || result.status === "approximate") {
      await writeCache(queries, result);
      return result;
    }
  }

  const result = {
    status: "not_found",
    error: "No geocoding result"
  };
  await writeCache(queries, result);
  return result;
}

function buildQueries(place) {
  const hasLocationHint = [
    place.address,
    place.city,
    place.state,
    place.country
  ].some(value => String(value || "").trim());

  if (!hasLocationHint) return [];

  const name = cleanPlaceName(place.name);
  const address = String(place.address || "").trim();
  const simpleAddress = simplifyAddress(address);
  const streetAddress = streetAddressLine(simpleAddress || address);
  const roadAddress = roadAddressLine(streetAddress);
  const city = String(place.city || "").trim();
  const state = String(place.state || "").trim();
  const country = normalizeCountry(String(place.country || "").trim());
  const queries = [];

  addQuery(queries, [name, address, city, state, country]);
  if (address) addQuery(queries, [address, city, state, country]);
  if (simpleAddress && simpleAddress !== address) {
    addQuery(queries, [name, simpleAddress, city, state, country]);
    addQuery(queries, [simpleAddress, city, state, country]);
  }
  if (streetAddress && streetAddress !== address && streetAddress !== simpleAddress) {
    addQuery(queries, [name, streetAddress, city, state, country]);
    addQuery(queries, [streetAddress, city, state, country]);
  }
  if (roadAddress && roadAddress !== streetAddress) {
    addQuery(queries, [roadAddress, city, state, country]);
  }
  if (name && city) addQuery(queries, [name, city, state, country]);

  return queries;
}

function addQuery(queries, parts) {
  const query = parts.filter(Boolean).join(", ");
  if (query && !queries.includes(query)) queries.push(query);
}

function cleanPlaceName(name) {
  const text = String(name || "").trim();
  const pipeParts = text.split(/\s+\|\s+/).map(part => part.trim()).filter(Boolean);
  if (pipeParts.length > 1) return pipeParts[pipeParts.length - 1];
  return text;
}

function simplifyAddress(address) {
  return String(address || "")
    .replace(/\([^)]*(?:entre|between)[^)]*\)/gi, " ")
    .replace(/\b(?:entre|between)\b.+$/i, " ")
    .replace(/#\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .trim();
}

function streetAddressLine(address) {
  return String(address || "").split(",")[0]?.trim() || "";
}

function roadAddressLine(address) {
  return String(address || "")
    .replace(/^\d+[a-z]?\s+/i, "")
    .trim();
}

function normalizeCountry(country) {
  const countries = {
    CA: "Canada",
    US: "United States",
    GB: "United Kingdom"
  };

  return countries[country.toUpperCase()] || country;
}

function buildSearchUrl(query, env) {
  const endpoint = new URL(env.NOMINATIM_ENDPOINT || DEFAULT_ENDPOINT);
  if (!["https:", "http:"].includes(endpoint.protocol)) {
    throw new Error("NOMINATIM_ENDPOINT must be HTTP or HTTPS");
  }

  const searchUrl = new URL("/search", endpoint);
  searchUrl.searchParams.set("format", "jsonv2");
  searchUrl.searchParams.set("addressdetails", "1");
  searchUrl.searchParams.set("limit", "5");
  searchUrl.searchParams.set("q", query);
  return searchUrl;
}

function pickResult(results, place, query) {
  if (!results.length) return null;

  return [...results]
    .map((result, index) => ({
      result,
      score: scoreResult(result, place, query) - index * 0.01
    }))
    .sort((left, right) => right.score - left.score)[0]?.result || null;
}

function scoreResult(result, place, query) {
  const resultName = result.name || namedAddressValue(result.address) || "";
  const wantedName = cleanPlaceName(place.name);
  const resultText = `${resultName} ${result.display_name || ""} ${result.category || ""} ${result.type || ""}`;
  const queryText = `${query} ${place.type || ""}`;
  let score = Number(result.importance || 0);

  score += tokenOverlap(wantedName, resultText) * 8;
  score += tokenOverlap(queryText, resultText) * 2;

  if (sameText(result.address?.city || result.address?.town || result.address?.village, place.city)) score += 3;
  if (sameText(result.address?.state || result.address?.region || result.address?.province, place.state)) score += 2;
  if (sameText(result.address?.country, normalizeCountry(place.country || ""))) score += 2;
  if (isCategoryMatch(place.type, result)) score += 4;

  return score;
}

function tokenOverlap(left, right) {
  const leftTokens = usefulTokens(left);
  const rightTokens = usefulTokens(right);
  if (!leftTokens.length || !rightTokens.length) return 0;
  return leftTokens.filter(token => rightTokens.includes(token)).length;
}

function usefulTokens(value) {
  const stop = new Set(["the", "and", "for", "with", "world", "largest", "independent", "bookstore"]);
  return String(value || "")
    .toLowerCase()
    .match(/[a-z0-9']{3,}/g)
    ?.filter(token => !stop.has(token)) || [];
}

function sameText(left, right) {
  const a = String(left || "").trim().toLowerCase();
  const b = String(right || "").trim().toLowerCase();
  return Boolean(a && b && a === b);
}

function isCategoryMatch(type, result) {
  const wanted = String(type || "").toLowerCase();
  const category = String(result.category || "").toLowerCase();
  const resultType = String(result.type || "").toLowerCase();

  if (/\b(shop|store|bookstore|boutique)\b/.test(wanted)) return category === "shop" || ["books", "bookstore"].includes(resultType);
  if (/\b(restaurant|diner|bistro|trattoria|pizzeria|sushi|ramen|taqueria)\b/.test(wanted)) return category === "amenity" && ["restaurant", "cafe", "bar", "pub"].includes(resultType);
  if (/\b(bar|pub|cocktail|brewery|taproom)\b/.test(wanted)) return category === "amenity" && ["bar", "pub", "biergarten"].includes(resultType);
  if (/\b(cafe|coffee|bakery|tea)\b/.test(wanted)) return category === "amenity" && ["cafe", "bakery"].includes(resultType);
  if (/\b(fitness|gym|yoga|pilates)\b/.test(wanted)) return ["leisure", "amenity"].includes(category) && ["fitness_centre", "sports_centre", "gym"].includes(resultType);
  if (/\b(museum|gallery)\b/.test(wanted)) return category === "tourism" && ["museum", "gallery"].includes(resultType);

  return false;
}

function normalizeResult(result) {
  if (!result) {
    return {
      status: "not_found",
      error: "No geocoding result"
    };
  }

  const address = result.address || {};
  const lat = Number(result.lat);
  const lng = Number(result.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      status: "not_found",
      error: "Geocoding result had no coordinates"
    };
  }

  return {
    status: isApproximateResult(result) ? "approximate" : "ready",
    name: result.name || namedAddressValue(address),
    lat,
    lng,
    displayAddress: result.display_name || "",
    city: address.city || address.town || address.village || address.hamlet || address.municipality || "",
    state: address.state || address.region || address.province || "",
    country: address.country || "",
    osmId: result.osm_id ? String(result.osm_id) : "",
    osmType: result.osm_type || "",
    provider: "nominatim"
  };
}

function isApproximateResult(result) {
  const category = String(result?.category || "").toLowerCase();
  const type = String(result?.type || "").toLowerCase();
  const addresstype = String(result?.addresstype || "").toLowerCase();

  return category === "highway" ||
    addresstype === "road" ||
    ["road", "residential", "tertiary", "secondary", "primary", "service", "footway"].includes(type);
}

function namedAddressValue(address = {}) {
  return address.shop || address.amenity || address.tourism || address.leisure || address.building || "";
}

async function readCache(queries) {
  try {
    const cached = await caches.default.match(cacheKey(queries));
    if (!cached) return null;
    return cached.json();
  } catch {
    return null;
  }
}

async function writeCache(queries, result) {
  try {
    const response = json(result, 200, {
      "Cache-Control": `public, max-age=${CACHE_MAX_AGE}`
    });
    await caches.default.put(cacheKey(queries), response);
  } catch {
    // Geocoding still succeeds if cache writes are unavailable.
  }
}

function cacheKey(queries) {
  return new Request(`https://locus-geocode.cache/v2?queries=${encodeURIComponent(queries.join("|"))}`);
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
