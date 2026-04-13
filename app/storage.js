import { normalizePlace } from "./place.js";

const STATE_STORAGE_KEY = "locus_v1";

export function loadAppState() {
  try {
    const raw = localStorage.getItem(STATE_STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.places)) {
        const places = data.places.map(normalizePlace);
        let typeFilter = data.typeFilter || "All";
        let cityFilter = data.cityFilter || "All";

        if (typeFilter !== "All" && typeFilter !== "Favorites" && !places.some(place => place.type === typeFilter)) {
          typeFilter = "All";
        }

        if (cityFilter !== "All" && !places.some(place => cityLabel(place) === cityFilter)) {
          cityFilter = "All";
        }

        return {
          places,
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
    typeFilter: "All",
    cityFilter: "All",
    sortIndex: 0
  };
}

export function saveAppState(state) {
  try {
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify({
      places: state.places,
      typeFilter: state.typeFilter,
      cityFilter: state.cityFilter,
      sortIndex: state.sortIndex
    }));
  } catch {
    // Local storage can fail in private windows or quota pressure.
  }
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

function cityLabel(place) {
  return place.city || "Unknown";
}
