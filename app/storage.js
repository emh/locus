import { normalizePlace } from "./place.js";

const STATE_STORAGE_KEY = "locus_v1";

export function loadAppState() {
  try {
    const raw = localStorage.getItem(STATE_STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.places)) {
        const places = data.places.map(normalizePlace);
        const placeIds = new Set(places.map(place => place.id));
        const lists = normalizeLists(data.lists, placeIds);
        let typeFilter = data.typeFilter || "All";
        let cityFilter = data.cityFilter || "All";

        if (typeFilter !== "All" && typeFilter !== "Favorites" && !places.some(place => place.type === typeFilter)) {
          typeFilter = "All";
        }

        if (cityFilter !== "All" && !places.some(place => cityLabel(place, places) === cityFilter)) {
          cityFilter = "All";
        }

        return {
          places,
          lists,
          typeFilter,
          cityFilter,
          sortIndex: Number.isInteger(data.sortIndex) ? data.sortIndex : 0
        };
      }
    }
  } catch {
    // Fall through to empty state.
  }

  return {
    places: [],
    lists: [],
    typeFilter: "All",
    cityFilter: "All",
    sortIndex: 0
  };
}

export function saveAppState(state) {
  try {
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify({
      places: state.places,
      lists: normalizeLists(state.lists, new Set(state.places.map(place => place.id))),
      typeFilter: state.typeFilter,
      cityFilter: state.cityFilter,
      sortIndex: state.sortIndex
    }));
  } catch {
    // Local storage can fail in private windows or quota pressure.
  }
}

function normalizeLists(lists, validPlaceIds) {
  if (!Array.isArray(lists)) return [];

  return lists
    .map(list => normalizeList(list, validPlaceIds))
    .filter(Boolean);
}

function normalizeList(list, validPlaceIds) {
  if (!list || typeof list !== "object") return null;

  const name = typeof list.name === "string" ? list.name.trim() : "";
  if (!name) return null;

  const placeIds = Array.isArray(list.placeIds) ? list.placeIds : [];
  return {
    id: String(list.id || crypto.randomUUID()),
    name,
    placeIds: Array.from(new Set(placeIds.map(id => String(id)))).filter(id => validPlaceIds.has(id)),
    dateCreated: list.dateCreated || new Date().toISOString()
  };
}

export function loadSettings() {
  return {
    apiBaseUrl: getConfiguredApiBaseUrl() || getDefaultApiBaseUrl(),
    appToken: ""
  };
}

function getDefaultApiBaseUrl() {
  const host = globalThis.location?.hostname || "";
  const protocol = globalThis.location?.protocol || "";

  if (protocol === "file:" || host === "localhost" || host === "127.0.0.1") {
    return "http://localhost:8797";
  }

  return "";
}

function getConfiguredApiBaseUrl() {
  const value = globalThis.LOCUS_CONFIG?.apiBaseUrl;
  if (typeof value !== "string") return "";
  if (value.includes("YOUR_")) return "";
  return value.trim().replace(/\/+$/, "");
}

function cityLabel(place, places) {
  const city = place.city || "";
  if (!city) return "Unknown";

  const states = new Set(places
    .filter(candidate => candidate.city === city)
    .map(candidate => candidate.state || "")
  );

  return states.size > 1 && place.state ? `${city}, ${place.state}` : city;
}
