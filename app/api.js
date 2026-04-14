import { loadSettings } from "./storage.js";
import { normalizePlace } from "./place.js";


const PLACE_PATH = "/api/places";
const GEOCODE_PATH = "/api/geocode";

export async function ingestPlace(url, settings = loadSettings()) {
  const endpoint = getEndpoint(settings.apiBaseUrl, PLACE_PATH);
  const headers = {
    "Content-Type": "application/json"
  };

  if (settings.appToken) {
    headers.Authorization = `Bearer ${settings.appToken}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ url })
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response));
  }

  const payload = await response.json();
  return normalizePlace(payload.place || payload);
}

export async function geocodePlace(place, settings = loadSettings()) {
  const endpoint = getEndpoint(settings.apiBaseUrl, GEOCODE_PATH);
  const headers = {
    "Content-Type": "application/json"
  };

  if (settings.appToken) {
    headers.Authorization = `Bearer ${settings.appToken}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: place.name,
      address: place.address,
      city: place.city,
      state: place.state,
      country: place.country,
      type: place.type
    })
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response));
  }

  const payload = await response.json();
  return payload.geocode || payload;
}

function getEndpoint(apiBaseUrl, path) {
  const base = apiBaseUrl ? apiBaseUrl.replace(/\/+$/, "") : getSameOriginApiBase();
  return new URL(path, `${base}/`).toString();
}

function getSameOriginApiBase() {
  const host = globalThis.location?.hostname || "";
  if (host.endsWith(".github.io")) {
    throw new Error("Production API URL is not configured. Set app/config.js to the place Worker URL.");
  }
  return globalThis.location.origin;
}

async function getErrorMessage(response) {
  try {
    const payload = await response.json();
    if (typeof payload.error === "string" && payload.error) return payload.error;
  } catch {
    // Fall through to status text.
  }

  return response.statusText || "Request failed";
}
