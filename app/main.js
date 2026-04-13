import { geocodePlace, ingestPlace } from "./api.js";
import { normalizePlace, placeNeedsReview } from "./place.js";
import { loadAppState, loadSettings, saveAppState } from "./storage.js";

const SORTS = [
  { key: "newest", label: "newest first" },
  { key: "oldest", label: "oldest first" },
  { key: "name", label: "name" },
  { key: "city", label: "city" }
];

const state = {
  ...loadAppState(),
  search: "",
  currentPlaceId: null,
  isEditing: false,
  pendingDeleteId: null,
  settings: loadSettings()
};

const $ = id => document.getElementById(id);

let map;
let detailMap;
let markerLayer;
let isProcessing = false;
let toastTimer;
let markerMap = new Map();

function esc(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return "undated";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "undated";

  const now = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const label = `${months[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label}, ${date.getFullYear()}`;
}

function isUrl(value) {
  const text = value.trim();
  if (text.includes(" ") || text.length < 4) return false;
  return /^https?:\/\//i.test(text) || /^[a-z0-9][-a-z0-9]*\.[a-z]{2,}/i.test(text);
}

function save() {
  saveAppState(state);
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 2000);
}

function cityLabel(place) {
  return place.city || "Unknown";
}

function locationLabel(place) {
  const parts = [];
  const address = place.address || "";

  if (address) parts.push(address);
  if (place.city && !includesText(address, place.city)) parts.push(place.city);
  if (place.country && !includesText(address, place.country)) parts.push(place.country);

  return parts.filter(Boolean).join(", ") || "Address needed";
}

function includesText(haystack, needle) {
  return String(haystack || "").toLowerCase().includes(String(needle || "").toLowerCase());
}

function hasCoordinates(place) {
  return Number.isFinite(place.lat) && Number.isFinite(place.lng);
}

function getCurrentPlace() {
  return state.places.find(place => place.id === state.currentPlaceId) || null;
}

function placeElement(id) {
  return Array.from(document.querySelectorAll(".place-item")).find(element => element.dataset.id === String(id));
}

function initMap() {
  const Leaflet = globalThis.L;
  if (!Leaflet) {
    $("map").innerHTML = `<div class="map-empty">Map unavailable.</div>`;
    return;
  }

  map = Leaflet.map("map", {
    zoomControl: false,
    attributionControl: true
  }).setView([20, 0], 2);

  Leaflet.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
    subdomains: "abcd",
    maxZoom: 19
  }).addTo(map);

  markerLayer = Leaflet.layerGroup().addTo(map);
  requestAnimationFrame(() => map.invalidateSize());
}

function updateMarkers() {
  const Leaflet = globalThis.L;
  if (!Leaflet || !map || !markerLayer) return;

  markerLayer.clearLayers();
  markerMap = new Map();

  const bounds = [];
  const places = getFiltered().filter(hasCoordinates);

  for (const place of places) {
    const marker = Leaflet.circleMarker([place.lat, place.lng], {
      radius: 6,
      fillColor: "#8b0000",
      fillOpacity: 0.8,
      color: "#fffff8",
      weight: 2,
      opacity: 1
    });

    marker.bindTooltip(place.name, {
      direction: "top",
      offset: [0, -8],
      className: "place-tooltip"
    });

    marker.on("click", () => showDetail(place.id));
    marker.on("mouseover", () => {
      marker.setRadius(9);
      placeElement(place.id)?.classList.add("highlight");
    });
    marker.on("mouseout", () => {
      marker.setRadius(6);
      placeElement(place.id)?.classList.remove("highlight");
    });

    marker.addTo(markerLayer);
    markerMap.set(place.id, marker);
    bounds.push([place.lat, place.lng]);
  }

  if (!bounds.length) {
    map.setView([20, 0], 2);
  } else if (bounds.length === 1) {
    map.flyTo(bounds[0], 14, { duration: 0.8 });
  } else {
    map.flyToBounds(bounds, { padding: [40, 40], maxZoom: 14, duration: 0.8 });
  }
}

function highlightMarker(id) {
  const marker = markerMap.get(String(id));
  if (!marker) return;
  marker.setRadius(9);
  marker.setStyle({ fillColor: "#a52a2a" });
}

function unhighlightMarker(id) {
  const marker = markerMap.get(String(id));
  if (!marker) return;
  marker.setRadius(6);
  marker.setStyle({ fillColor: "#8b0000" });
}

function renderStats() {
  const total = state.places.length;
  const cities = new Set(state.places.filter(place => place.city).map(place => place.city)).size;
  const review = state.places.filter(placeNeedsReview).length;
  const suffix = review ? ` - ${review} need details` : "";
  $("stats").textContent = `${total} places - ${cities} cities${suffix}`;
}

function getTypes() {
  const types = new Set(state.places.map(place => place.type || "Other"));
  return ["All", ...Array.from(types).sort((a, b) => a.localeCompare(b))];
}

function getCities() {
  const cities = new Set(state.places.map(cityLabel));
  return ["All", ...Array.from(cities).sort((a, b) => a.localeCompare(b))];
}

function renderTypeFilters() {
  $("type-filters").innerHTML = getTypes().map(type =>
    `<span class="cat-item${state.typeFilter === type ? " active" : ""}" data-type="${esc(type)}">${esc(type)}</span>`
  ).join("");
}

function renderCityFilters() {
  $("city-filters").innerHTML = getCities().map(city =>
    `<span class="cat-item${state.cityFilter === city ? " active" : ""}" data-city="${esc(city)}">${city === "All" ? "All Cities" : esc(city)}</span>`
  ).join("");
}

function renderSort() {
  $("sort-btn").textContent = SORTS[state.sortIndex].label;
}

function getFiltered() {
  let places = [...state.places];

  if (state.typeFilter !== "All") {
    places = places.filter(place => (place.type || "Other") === state.typeFilter);
  }

  if (state.cityFilter !== "All") {
    places = places.filter(place => cityLabel(place) === state.cityFilter);
  }

  if (state.search) {
    const query = state.search.toLowerCase();
    places = places.filter(place =>
      place.name.toLowerCase().includes(query) ||
      place.url.toLowerCase().includes(query) ||
      place.source.toLowerCase().includes(query) ||
      place.address.toLowerCase().includes(query) ||
      place.city.toLowerCase().includes(query) ||
      place.country.toLowerCase().includes(query) ||
      place.type.toLowerCase().includes(query) ||
      place.description.toLowerCase().includes(query) ||
      place.notes.toLowerCase().includes(query) ||
      place.tags.some(tag => tag.toLowerCase().includes(query))
    );
  }

  const sort = SORTS[state.sortIndex].key;
  switch (sort) {
    case "newest":
      places.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
      break;
    case "oldest":
      places.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
      break;
    case "name":
      places.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "city":
      places.sort((a, b) => cityLabel(a).localeCompare(cityLabel(b)) || a.name.localeCompare(b.name));
      break;
  }

  return places;
}

function renderPlaces() {
  const places = getFiltered();
  const container = $("place-list");
  const empty = $("empty-state");

  if (!places.length) {
    container.innerHTML = "";
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  container.innerHTML = places.map(place => {
    const review = placeNeedsReview(place);
    const tagLabel = place.tags.length ? place.tags.map(tag => esc(tag)).join(" - ") : esc(place.source);
    const meta = `${place.type || "Other"} - ${cityLabel(place)}${review ? " - needs details" : ""}`;

    return `
      <article class="place-item${review ? " needs-review" : ""}" data-id="${esc(place.id)}">
        <div class="place-meta">
          <span>${esc(meta)}</span>
          <span>${formatDate(place.dateAdded)}</span>
        </div>
        <h2 class="place-name">${esc(place.name)}</h2>
        <p class="place-address">${esc(locationLabel(place))}</p>
        <div class="place-tags">${tagLabel}</div>
      </article>
    `;
  }).join("");
}

function getNearby(place) {
  if (!place.city) return [];
  return state.places
    .filter(candidate => candidate.id !== place.id && candidate.city === place.city)
    .slice(0, 4);
}

function renderDetail(place) {
  const container = $("detail-content");
  destroyDetailMap();
  if (state.isEditing) {
    renderEditForm(place);
    return;
  }

  const nearby = getNearby(place);
  const review = placeNeedsReview(place);
  const description = place.description || "No description yet.";

  container.innerHTML = `
    <button class="back-btn" data-action="back" type="button">Back</button>

    ${hasCoordinates(place) ? `<div class="detail-map" id="detail-map"></div>` : ""}
    <h1 class="detail-name">${esc(place.name)}</h1>
    <p class="detail-address">${esc(locationLabel(place))}</p>
    <p class="detail-meta">${esc(place.type || "Other")} - ${esc(cityLabel(place))} - ${formatDate(place.dateAdded)}</p>

    ${review ? `<p class="detail-notice">Add missing details before the map pin is reliable.</p>` : ""}
    <p class="detail-description">${esc(description)}</p>
    <p class="detail-tags">${place.tags.map(tag => esc(tag)).join(" - ")}</p>

    <hr class="detail-rule">

    ${nearby.length ? `
      <div class="section-label">Nearby in ${esc(place.city)}</div>
      ${nearby.map(candidate => `
        <div class="nearby-item" data-id="${esc(candidate.id)}">
          <span class="nearby-title">${esc(candidate.name)}</span>
          <span class="nearby-meta">${esc(candidate.type)} - ${esc(locationLabel(candidate))}</span>
        </div>
      `).join("")}
      <hr class="detail-rule">
    ` : ""}

    <div class="detail-actions">
      <button class="action-link" data-action="edit" type="button">Edit</button>
      <a class="action-link muted" href="${esc(place.url)}" target="_blank" rel="noopener">Website</a>
      ${renderDeleteAction(place)}
    </div>
  `;

  renderDetailMap(place);
}

function renderDetailMap(place) {
  const Leaflet = globalThis.L;
  const container = $("detail-map");
  if (!Leaflet || !container || !hasCoordinates(place)) return;

  detailMap = Leaflet.map(container, {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    tap: false,
    touchZoom: false
  }).setView([place.lat, place.lng], 17);

  Leaflet.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
    subdomains: "abcd",
    maxZoom: 19
  }).addTo(detailMap);

  Leaflet.circleMarker([place.lat, place.lng], {
    radius: 7,
    fillColor: "#8b0000",
    fillOpacity: 0.85,
    color: "#fffff8",
    weight: 2,
    opacity: 1
  }).addTo(detailMap);

  requestAnimationFrame(() => detailMap?.invalidateSize());
}

function destroyDetailMap() {
  if (!detailMap) return;
  detailMap.remove();
  detailMap = null;
}

function renderDeleteAction(place) {
  if (state.pendingDeleteId !== place.id) {
    return `<button class="action-link muted" data-action="request-delete" type="button">Remove</button>`;
  }

  return `
    <span class="delete-confirm-label">Remove?</span>
    <button class="action-link" data-action="confirm-delete" type="button">Yes</button>
    <button class="action-link muted" data-action="cancel-delete" type="button">Cancel</button>
  `;
}

function renderEditForm(place) {
  destroyDetailMap();
  $("detail-content").innerHTML = `
    <button class="back-btn" data-action="cancel-edit" type="button">Back</button>

    <h1 class="detail-name">Edit</h1>
    <p class="detail-meta">${esc(place.source)} - ${formatDate(place.dateAdded)}</p>

    <form class="edit-form" id="place-edit-form">
      <label class="field">
        <span>Name</span>
        <input name="name" value="${esc(place.name)}" autocomplete="off">
      </label>

      <div class="field-row">
        <label class="field">
          <span>Type</span>
          <input name="type" value="${esc(place.type)}" autocomplete="off">
        </label>
        <label class="field">
          <span>City</span>
          <input name="city" value="${esc(place.city)}" autocomplete="off">
        </label>
      </div>

      <label class="field">
        <span>Address</span>
        <input name="address" value="${esc(place.address)}" autocomplete="street-address">
      </label>

      <div class="field-row">
        <label class="field">
          <span>Country</span>
          <input name="country" value="${esc(place.country)}" autocomplete="country-name">
        </label>
        <label class="field">
          <span>Tags</span>
          <input name="tags" value="${esc(place.tags.join(", "))}" autocomplete="off">
        </label>
      </div>

      <div class="field-row">
        <label class="field">
          <span>Latitude</span>
          <input name="lat" inputmode="decimal" value="${hasCoordinates(place) ? esc(place.lat) : ""}" autocomplete="off">
        </label>
        <label class="field">
          <span>Longitude</span>
          <input name="lng" inputmode="decimal" value="${hasCoordinates(place) ? esc(place.lng) : ""}" autocomplete="off">
        </label>
      </div>

      <label class="field">
        <span>Description</span>
        <textarea name="description">${esc(place.description)}</textarea>
      </label>

      <label class="field">
        <span>Notes</span>
        <textarea name="notes">${esc(place.notes)}</textarea>
      </label>

      <div class="form-actions">
        <button class="action-link" type="submit">Save details</button>
        <button class="action-link muted" data-action="cancel-edit" type="button">Cancel</button>
      </div>
    </form>
  `;
}

function showDetail(id, options = {}) {
  const place = state.places.find(candidate => candidate.id === String(id));
  if (!place) return;

  state.currentPlaceId = place.id;
  state.isEditing = Boolean(options.edit);
  state.pendingDeleteId = null;
  renderDetail(place);
  $("detail-overlay").classList.add("active");
  $("detail-overlay").scrollTop = 0;
  document.body.classList.add("no-scroll");
}

function goBack() {
  if (!$("detail-overlay").classList.contains("active")) return;
  destroyDetailMap();
  $("detail-overlay").classList.remove("active");
  document.body.classList.remove("no-scroll");
  state.currentPlaceId = null;
  state.isEditing = false;
  state.pendingDeleteId = null;
  renderAll();
}

function startEdit() {
  const place = getCurrentPlace();
  if (!place) return;
  state.isEditing = true;
  state.pendingDeleteId = null;
  renderDetail(place);
}

function cancelEdit() {
  const place = getCurrentPlace();
  if (!place) return goBack();

  state.isEditing = false;
  renderDetail(place);
}

async function saveEditForm(form) {
  const place = getCurrentPlace();
  if (!place) return;

  const data = new FormData(form);
  let next = normalizePlace({
    ...place,
    name: formString(data, "name") || place.name,
    type: formString(data, "type") || "Other",
    address: formString(data, "address"),
    city: formString(data, "city"),
    country: formString(data, "country"),
    tags: parseTags(formString(data, "tags")),
    lat: formNumber(data, "lat"),
    lng: formNumber(data, "lng"),
    description: formString(data, "description"),
    notes: formString(data, "notes"),
    dateUpdated: new Date().toISOString(),
    status: "ready"
  });

  next = await geocodeIfNeeded(next);
  next.status = deriveStatus(next);
  if (next.status === "ready" && next.geocodeStatus !== "ready") {
    next.geocodeStatus = "manual";
  }

  const index = state.places.findIndex(candidate => candidate.id === place.id);
  if (index >= 0) {
    state.places[index] = next;
  }

  state.currentPlaceId = next.id;
  state.isEditing = false;
  save();
  renderAll();
  renderDetail(next);
  toast(next.status === "ready" ? "Place updated" : "Place saved; details still needed");
}

async function geocodeIfNeeded(place) {
  if (hasCoordinates(place) || !(place.name || place.address || place.city)) return place;

  try {
    const geocode = await geocodePlace(place, state.settings);
    return normalizePlace({
      ...place,
      lat: geocode.lat ?? place.lat,
      lng: geocode.lng ?? place.lng,
      address: place.address || geocode.displayAddress || "",
      city: place.city || geocode.city || "",
      country: place.country || geocode.country || "",
      osmId: geocode.osmId || "",
      osmType: geocode.osmType || "",
      geocodeStatus: geocode.status || place.geocodeStatus,
      error: geocode.error ? [place.error, geocode.error].filter(Boolean).join("; ") : place.error,
      status: "ready"
    });
  } catch (error) {
    return normalizePlace({
      ...place,
      geocodeStatus: "geocode_failed",
      error: [place.error, messageFromError(error)].filter(Boolean).join("; "),
      status: "geocode_failed"
    });
  }
}

function deriveStatus(place) {
  if (!place.name || !place.address || !place.city) return "metadata_incomplete";
  if (!hasCoordinates(place)) return "geocode_failed";
  return "ready";
}

function formString(data, name) {
  return String(data.get(name) || "").trim();
}

function formNumber(data, name) {
  const value = formString(data, name);
  if (!value) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseTags(value) {
  return value
    .split(",")
    .map(tag => tag.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .slice(0, 8);
}

function messageFromError(error) {
  return error instanceof Error ? error.message : "Request failed";
}

function requestDeleteCurrentPlace() {
  const place = getCurrentPlace();
  if (!place) return;
  state.pendingDeleteId = place.id;
  renderDetail(place);
}

function cancelDeleteCurrentPlace() {
  const place = getCurrentPlace();
  if (!place) return;
  state.pendingDeleteId = null;
  renderDetail(place);
}

function deleteCurrentPlace() {
  const place = getCurrentPlace();
  if (!place) return;

  state.places = state.places.filter(candidate => candidate.id !== place.id);
  state.currentPlaceId = null;
  state.pendingDeleteId = null;
  state.isEditing = false;
  save();

  destroyDetailMap();
  $("detail-overlay").classList.remove("active");
  document.body.classList.remove("no-scroll");
  renderAll();
  toast("Place removed");
}

async function addPlace(url) {
  if (isProcessing) return;
  isProcessing = true;
  let addedPlace = null;

  const input = $("main-input");
  const status = $("input-status");
  const progress = $("input-progress");

  input.value = "";
  input.disabled = true;
  status.textContent = "extracting and locating...";
  status.classList.remove("is-error");
  progress.classList.add("running");

  try {
    const place = await ingestPlace(url, state.settings);
    addedPlace = upsertPlace(place);
    save();
    renderAll();

    const newElement = placeElement(addedPlace.id);
    newElement?.classList.add("animate-in");

    if (placeNeedsReview(addedPlace)) {
      showDetail(addedPlace.id, { edit: true });
      toast("Add missing details");
    } else {
      toast("Place added");
    }
  } catch (error) {
    input.value = url;
    status.textContent = error instanceof Error ? error.message : "Could not add place";
    status.classList.add("is-error");
    toast("Could not add place");
  } finally {
    progress.classList.remove("running");
    progress.style.transition = "none";
    progress.style.width = "0";
    requestAnimationFrame(() => {
      progress.style.transition = "";
      progress.style.width = "";
    });
    if (addedPlace) {
      status.textContent = "";
      status.classList.remove("is-error");
    }
    input.disabled = false;
    input.focus();
    isProcessing = false;
  }
}

function upsertPlace(place) {
  const existingIndex = state.places.findIndex(candidate =>
    candidate.canonicalUrl === place.canonicalUrl ||
    candidate.url === place.url ||
    candidate.originalUrl === place.originalUrl ||
    candidate.url === place.originalUrl ||
    candidate.originalUrl === place.url
  );

  if (existingIndex >= 0) {
    const existing = state.places[existingIndex];
    const next = normalizePlace({
      ...existing,
      ...place,
      id: existing.id,
      dateAdded: existing.dateAdded,
      notes: existing.notes || place.notes,
      isFavorite: existing.isFavorite
    });
    state.places[existingIndex] = next;
    return next;
  }

  state.places.unshift(place);
  return place;
}

function renderAll() {
  renderStats();
  renderTypeFilters();
  renderCityFilters();
  renderSort();
  renderPlaces();
  updateMarkers();
}

function bindEvents() {
  const input = $("main-input");
  const status = $("input-status");

  input.addEventListener("input", () => {
    const value = input.value.trim();
    if (isUrl(value)) {
      status.textContent = "Enter to add place";
      status.classList.remove("is-error");
      state.search = "";
    } else {
      status.textContent = "";
      status.classList.remove("is-error");
      state.search = value;
    }
    renderPlaces();
    updateMarkers();
  });

  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      const value = input.value.trim();
      if (isUrl(value)) {
        event.preventDefault();
        addPlace(value);
      }
    }

    if (event.key === "Escape") {
      input.value = "";
      state.search = "";
      status.textContent = "";
      status.classList.remove("is-error");
      renderPlaces();
      updateMarkers();
      input.blur();
    }
  });

  $("type-filters").addEventListener("click", event => {
    const item = event.target.closest(".cat-item");
    if (!item) return;
    state.typeFilter = item.dataset.type;
    save();
    renderTypeFilters();
    renderPlaces();
    updateMarkers();
  });

  $("city-filters").addEventListener("click", event => {
    const item = event.target.closest(".cat-item");
    if (!item) return;
    state.cityFilter = item.dataset.city;
    save();
    renderCityFilters();
    renderPlaces();
    updateMarkers();
  });

  $("sort-btn").addEventListener("click", () => {
    state.sortIndex = (state.sortIndex + 1) % SORTS.length;
    save();
    renderSort();
    renderPlaces();
    updateMarkers();
  });

  $("place-list").addEventListener("click", event => {
    const item = event.target.closest(".place-item");
    if (item) showDetail(item.dataset.id);
  });

  $("place-list").addEventListener("mouseover", event => {
    const item = event.target.closest(".place-item");
    if (item) highlightMarker(item.dataset.id);
  });

  $("place-list").addEventListener("mouseout", event => {
    const item = event.target.closest(".place-item");
    if (item) unhighlightMarker(item.dataset.id);
  });

  $("detail-content").addEventListener("submit", event => {
    if (event.target.id !== "place-edit-form") return;
    event.preventDefault();
    saveEditForm(event.target);
  });

  $("detail-content").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (action) {
      if (action.dataset.action === "back") return goBack();
      if (action.dataset.action === "edit") return startEdit();
      if (action.dataset.action === "cancel-edit") return cancelEdit();
      if (action.dataset.action === "request-delete") return requestDeleteCurrentPlace();
      if (action.dataset.action === "confirm-delete") return deleteCurrentPlace();
      if (action.dataset.action === "cancel-delete") return cancelDeleteCurrentPlace();
    }

    const nearby = event.target.closest(".nearby-item");
    if (!nearby) return;
    showDetail(nearby.dataset.id);
  });

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if ($("detail-overlay").classList.contains("active")) {
      if (state.isEditing) cancelEdit();
      else goBack();
    }
  });
}

function init() {
  initMap();
  renderAll();
  bindEvents();
  registerServiceWorker();
  watchForAppUpdates();
}

init();

function isLocalHost() {
  const host = globalThis.location?.hostname || "";
  return host === "localhost" || host === "127.0.0.1";
}

function shouldUseServiceWorker() {
  return "serviceWorker" in navigator && globalThis.location?.protocol === "https:" && !isLocalHost();
}

function registerServiceWorker() {
  if (!shouldUseServiceWorker()) return;

  let isReloadingForServiceWorker = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (isReloadingForServiceWorker) return;
    isReloadingForServiceWorker = true;
    globalThis.location.reload();
  });

  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
    .then(registration => {
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;

        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });

      setInterval(() => {
        registration.update().catch(() => {});
      }, 60_000);
    })
    .catch(() => {});
}

function watchForAppUpdates() {
  if (isLocalHost()) return;

  let didReload = false;
  const currentBuildId = globalThis.LOCUS_BUILD_ID || "";

  async function checkVersion() {
    if (didReload || !currentBuildId) return;

    try {
      const versionUrl = new URL("./version.js", globalThis.location.href);
      versionUrl.searchParams.set("t", Date.now().toString());
      const response = await fetch(versionUrl, { cache: "no-store" });
      if (!response.ok) return;

      const nextBuildId = parseBuildId(await response.text());
      if (!nextBuildId || nextBuildId === currentBuildId) return;

      didReload = true;
      const registration = await navigator.serviceWorker?.getRegistration?.();
      await registration?.update?.().catch(() => {});
      globalThis.location.reload();
    } catch {
      // Stay on the current version if the version check is unavailable.
    }
  }

  setInterval(checkVersion, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkVersion();
  });
}

function parseBuildId(scriptText) {
  return scriptText.match(/LOCUS_BUILD_ID\s*=\s*["']([^"']+)["']/)?.[1] || "";
}
