import { geocodePlace, ingestPlace } from "./api.js";
import { normalizePlace, placeNeedsReview } from "./place.js";
import { loadAppState, loadSettings, saveAppState } from "./storage.js";

const SORTS = [
  { key: "newest", label: "newest first" },
  { key: "oldest", label: "oldest first" },
  { key: "name", label: "name" },
  { key: "city", label: "city" }
];

const loadedState = loadAppState();
const state = {
  ...loadedState,
  search: "",
  listSearch: "",
  listTypeFilter: "All",
  listCityFilter: "All",
  listSortIndex: clampSortIndex(loadedState.sortIndex),
  currentPlaceId: null,
  isEditing: false,
  pendingDeleteId: null,
  screenStack: [],
  isCreatingList: false,
  pickerSearch: "",
  listChooserPlaceId: null,
  settings: loadSettings()
};

state.sortIndex = clampSortIndex(state.sortIndex);

const $ = id => document.getElementById(id);

let map;
let detailMap;
let markerLayer;
let isProcessing = false;
let toastTimer;
let markerMap = new Map();

const TILE_LAYER_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_LAYER_OPTIONS = {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  subdomains: "abcd",
  maxZoom: 19
};

const PLACE_MARKER_STYLE = {
  radius: 6,
  fillColor: "#8b0000",
  fillOpacity: 0.8,
  color: "#fffff8",
  weight: 2,
  opacity: 1
};

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

function clampSortIndex(value) {
  return Number.isInteger(value) && value >= 0 && value < SORTS.length ? value : 0;
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

function cityLabel(place, places = state.places) {
  const city = place.city || "";
  if (!city) return "Unknown";

  const states = new Set(places
    .filter(candidate => candidate.city === city)
    .map(candidate => candidate.state || "")
  );

  return states.size > 1 && place.state ? `${city}, ${place.state}` : city;
}

function locationLabel(place) {
  const parts = [];
  const address = place.address || "";

  if (address) parts.push(address);
  if (place.city && !includesText(address, place.city)) parts.push(place.city);
  if (place.state && !includesText(address, place.state)) parts.push(place.state);
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

function getCurrentScreen() {
  return state.screenStack[state.screenStack.length - 1] || null;
}

function getList(id) {
  return state.lists.find(list => list.id === String(id)) || null;
}

function getListsForPlace(placeId) {
  const id = String(placeId);
  return state.lists.filter(list => list.placeIds.includes(id));
}

function getListPlaces(list) {
  if (!list) return [];
  const ids = new Set(list.placeIds);
  return state.places.filter(place => ids.has(place.id));
}

function getPlacePool(context = {}) {
  const list = context.listId ? getList(context.listId) : null;
  return list ? getListPlaces(list) : [...state.places];
}

function placeElement(id, scope = document) {
  return Array.from(scope.querySelectorAll(".place-item")).find(element => element.dataset.id === String(id));
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

  Leaflet.tileLayer(TILE_LAYER_URL, TILE_LAYER_OPTIONS).addTo(map);

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
      ...PLACE_MARKER_STYLE
    });

    marker.bindTooltip(place.name, {
      direction: "top",
      offset: [0, -8],
      className: "place-tooltip"
    });

    marker.on("click", () => showDetail(place.id));
    marker.on("mouseover", () => {
      marker.setRadius(9);
      placeElement(place.id, $("place-list"))?.classList.add("highlight");
    });
    marker.on("mouseout", () => {
      marker.setRadius(6);
      placeElement(place.id, $("place-list"))?.classList.remove("highlight");
    });

    marker.addTo(markerLayer);
    markerMap.set(place.id, marker);
    bounds.push([place.lat, place.lng]);
  }

  fitMapToBounds(map, bounds);
}

function fitMapToBounds(targetMap, bounds) {
  if (!targetMap) return;

  if (!bounds.length) {
    targetMap.setView([20, 0], 2);
  } else if (bounds.length === 1) {
    targetMap.flyTo(bounds[0], 14, { duration: 0.8 });
  } else {
    targetMap.flyToBounds(bounds, { padding: [40, 40], maxZoom: 14, duration: 0.8 });
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

function getFilterState(context = {}) {
  if (context.listId) {
    return {
      search: state.listSearch,
      typeFilter: state.listTypeFilter,
      cityFilter: state.listCityFilter,
      sortIndex: state.listSortIndex
    };
  }

  return {
    search: state.search,
    typeFilter: state.typeFilter,
    cityFilter: state.cityFilter,
    sortIndex: state.sortIndex
  };
}

function setSearch(context, value) {
  if (context.listId) {
    state.listSearch = value;
  } else {
    state.search = value;
  }
}

function setTypeFilter(context, value) {
  if (context.listId) {
    state.listTypeFilter = value;
  } else {
    state.typeFilter = value;
    save();
  }
}

function setCityFilter(context, value) {
  if (context.listId) {
    state.listCityFilter = value;
  } else {
    state.cityFilter = value;
    save();
  }
}

function advanceSort(context) {
  if (context.listId) {
    state.listSortIndex = (state.listSortIndex + 1) % SORTS.length;
  } else {
    state.sortIndex = (state.sortIndex + 1) % SORTS.length;
    save();
  }
}

function ensureFilterState(context = {}) {
  const places = getPlacePool(context);
  const filters = getFilterState(context);

  if (filters.typeFilter !== "All" && !places.some(place => (place.type || "Other") === filters.typeFilter)) {
    setTypeFilter(context, "All");
  }

  if (filters.cityFilter !== "All" && !places.some(place => cityLabel(place) === filters.cityFilter)) {
    setCityFilter(context, "All");
  }
}

function renderStats(targetId = "stats", context = {}) {
  const places = getPlacePool(context);
  const total = places.length;
  const cities = new Set(places.filter(place => place.city).map(place => cityLabel(place))).size;
  const review = places.filter(placeNeedsReview).length;
  const suffix = review ? ` - ${review} need details` : "";
  $(targetId).textContent = `${total} places - ${cities} cities${suffix}`;
}

function getTypes(context = {}) {
  const types = new Set(getPlacePool(context).map(place => place.type || "Other"));
  return ["All", ...Array.from(types).sort((a, b) => a.localeCompare(b))];
}

function getCities(context = {}) {
  const cities = new Set(getPlacePool(context).map(place => cityLabel(place)));
  return ["All", ...Array.from(cities).sort((a, b) => a.localeCompare(b))];
}

function renderTypeFilters(targetId = "type-filters", context = {}) {
  const filters = getFilterState(context);
  $(targetId).innerHTML = getTypes(context).map(type =>
    `<span class="cat-item${filters.typeFilter === type ? " active" : ""}" data-action="type-filter" data-type="${esc(type)}">${esc(type)}</span>`
  ).join("");
}

function renderCityFilters(targetId = "city-filters", context = {}) {
  const filters = getFilterState(context);
  $(targetId).innerHTML = getCities(context).map(city =>
    `<span class="cat-item${filters.cityFilter === city ? " active" : ""}" data-action="city-filter" data-city="${esc(city)}">${city === "All" ? "All Cities" : esc(city)}</span>`
  ).join("");
}

function renderSort(targetId = "sort-btn", context = {}) {
  const filters = getFilterState(context);
  $(targetId).textContent = SORTS[clampSortIndex(filters.sortIndex)].label;
}

function placeMatchesSearch(place, query) {
  return place.name.toLowerCase().includes(query) ||
    place.url.toLowerCase().includes(query) ||
    place.source.toLowerCase().includes(query) ||
    place.address.toLowerCase().includes(query) ||
    place.city.toLowerCase().includes(query) ||
    place.state.toLowerCase().includes(query) ||
    place.country.toLowerCase().includes(query) ||
    place.type.toLowerCase().includes(query) ||
    place.description.toLowerCase().includes(query) ||
    place.notes.toLowerCase().includes(query) ||
    place.tags.some(tag => tag.toLowerCase().includes(query));
}

function getFiltered(context = {}) {
  let places = [...getPlacePool(context)];
  const filters = getFilterState(context);

  if (filters.typeFilter !== "All") {
    places = places.filter(place => (place.type || "Other") === filters.typeFilter);
  }

  if (filters.cityFilter !== "All") {
    places = places.filter(place => cityLabel(place) === filters.cityFilter);
  }

  if (filters.search) {
    const query = filters.search.toLowerCase();
    places = places.filter(place => placeMatchesSearch(place, query));
  }

  const sort = SORTS[clampSortIndex(filters.sortIndex)].key;
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

function renderPlaces(targetId = "place-list", emptyId = "empty-state", context = {}) {
  const places = getFiltered(context);
  const container = $(targetId);
  const empty = $(emptyId);

  if (!places.length) {
    container.innerHTML = "";
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  container.innerHTML = places.map(place => renderPlaceItem(place, context)).join("");
}

function renderPlaceItem(place, context = {}) {
  const review = placeNeedsReview(place);
  const tagLabel = place.tags.length ? place.tags.map(tag => esc(tag)).join(" - ") : esc(place.source);
  const meta = `${place.type || "Other"} - ${cityLabel(place)}${review ? " - needs details" : ""}`;
  const removeAction = context.listId ? `
    <button class="row-action" data-action="remove-from-list" data-list-id="${esc(context.listId)}" data-place-id="${esc(place.id)}" type="button">Remove from list</button>
  ` : "";

  return `
    <article class="place-item${review ? " needs-review" : ""}" data-id="${esc(place.id)}">
      <div class="place-meta">
        <span>${esc(meta)}</span>
        <span>${formatDate(place.dateAdded)}</span>
      </div>
      <h2 class="place-name">${esc(place.name)}</h2>
      <p class="place-address">${esc(locationLabel(place))}</p>
      <div class="place-tags">${tagLabel}</div>
      ${removeAction}
    </article>
  `;
}

function renderPlaceBrowser(ids, context = {}) {
  ensureFilterState(context);
  renderStats(ids.stats, context);
  renderTypeFilters(ids.typeFilters, context);
  renderCityFilters(ids.cityFilters, context);
  renderSort(ids.sort, context);
  renderPlaces(ids.placeList, ids.empty, context);
}

function getNearby(place) {
  if (!place.city) return [];
  return state.places
    .filter(candidate => candidate.id !== place.id && candidate.city === place.city && candidate.state === place.state)
    .slice(0, 4);
}

function renderScreen(options = {}) {
  const overlay = $("detail-overlay");
  const container = $("detail-content");
  const screen = getCurrentScreen();

  destroyDetailMap();

  if (!screen) {
    overlay.classList.remove("active");
    document.body.classList.remove("no-scroll");
    container.className = "overlay-content";
    container.innerHTML = "";
    state.currentPlaceId = null;
    return;
  }

  overlay.classList.add("active");
  document.body.classList.add("no-scroll");
  if (screen.type !== "place-detail") {
    state.currentPlaceId = null;
  }
  if (options.resetScroll) {
    overlay.scrollTop = 0;
  }

  if (screen.type === "lists") {
    renderListsIndex();
  } else if (screen.type === "list-detail") {
    renderListDetail(screen.listId);
  } else if (screen.type === "place-picker") {
    renderPlacePicker(screen.listId);
  } else if (screen.type === "place-detail") {
    const place = state.places.find(candidate => candidate.id === String(screen.placeId));
    if (!place) {
      closeTopScreen();
      return;
    }
    state.currentPlaceId = place.id;
    renderDetail(place);
  }

  if (options.resetScroll) {
    container.classList.remove("screen-enter");
    requestAnimationFrame(() => container.classList.add("screen-enter"));
  }
}

function pushScreen(screen) {
  if (screen.type !== "place-detail") {
    state.isEditing = false;
    state.pendingDeleteId = null;
    state.listChooserPlaceId = null;
  }

  state.screenStack.push(screen);
  renderScreen({ resetScroll: true });
}

function closeTopScreen() {
  state.screenStack.pop();
  state.isEditing = false;
  state.pendingDeleteId = null;
  state.listChooserPlaceId = null;
  state.pickerSearch = "";
  renderScreen({ resetScroll: true });
  renderAll();
}

function showLists() {
  state.isCreatingList = false;
  pushScreen({ type: "lists" });
}

function showListDetail(listId) {
  const list = getList(listId);
  if (!list) return;

  state.listSearch = "";
  state.listTypeFilter = "All";
  state.listCityFilter = "All";
  state.listSortIndex = state.sortIndex;
  pushScreen({ type: "list-detail", listId: list.id });
}

function showPlacePicker(listId) {
  const list = getList(listId);
  if (!list) return;

  state.pickerSearch = "";
  pushScreen({ type: "place-picker", listId: list.id });
}

function renderListsIndex() {
  const container = $("detail-content");
  container.className = "overlay-content list-screen";
  container.innerHTML = `
    <button class="back-btn" data-action="back" type="button">Back</button>

    <header class="screen-header">
      <h1 class="detail-name">lists</h1>
      <p class="detail-meta">${state.lists.length} ${state.lists.length === 1 ? "list" : "lists"}</p>
    </header>

    <div class="list-actions">
      ${state.isCreatingList ? renderCreateListForm() : `<button class="action-link" data-action="show-create-list" type="button">New list</button>`}
    </div>

    <div class="saved-lists">
      ${state.lists.length ? state.lists.map(renderListItem).join("") : `<div class="empty-state inline-empty">No lists yet.</div>`}
    </div>
  `;

  if (state.isCreatingList) {
    requestAnimationFrame(() => $("new-list-name")?.focus());
  }
}

function renderCreateListForm() {
  return `
    <form class="inline-form" id="list-create-form">
      <label class="field">
        <span>List name</span>
        <input id="new-list-name" name="name" autocomplete="off">
      </label>
      <div class="form-actions compact">
        <button class="action-link" type="submit">Create</button>
        <button class="action-link muted" data-action="cancel-create-list" type="button">Cancel</button>
      </div>
    </form>
  `;
}

function renderListItem(list) {
  const places = getListPlaces(list);
  const count = places.length;
  const city = getMainCityLabel(places);

  return `
    <article class="list-item" data-list-id="${esc(list.id)}">
      <div>
        <h2 class="place-name">${esc(list.name)}</h2>
        <p class="place-address">${count} ${count === 1 ? "place" : "places"} - ${esc(city)}</p>
      </div>
      <span class="list-arrow">View</span>
    </article>
  `;
}

function getMainCityLabel(places) {
  if (!places.length) return "No places yet";

  const counts = new Map();
  for (const place of places) {
    const label = cityLabel(place);
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function renderListDetail(listId) {
  const list = getList(listId);
  const container = $("detail-content");
  if (!list) {
    container.className = "overlay-content";
    container.innerHTML = `
      <button class="back-btn" data-action="back" type="button">Back</button>
      <h1 class="detail-name">List not found</h1>
    `;
    return;
  }

  const context = { listId: list.id };
  container.className = "overlay-content detail-view";
  container.innerHTML = `
    <div class="detail-map-container"><div class="detail-map" id="detail-map"></div></div>

    <div class="detail-body">
      <button class="back-btn" data-action="back" type="button">Back</button>

      <header class="screen-header">
        <h1 class="detail-name">${esc(list.name)}</h1>
        <p class="detail-meta" id="list-stats"></p>
      </header>

      <button class="action-link list-add-control" data-action="add-place-to-list" data-list-id="${esc(list.id)}" type="button">Add place</button>

      <div class="input-wrap">
        <div class="input-field">
          <input type="text" id="list-input" placeholder="search this list..." autocomplete="off" spellcheck="false" value="${esc(state.listSearch)}">
        </div>
        <div id="list-input-status"></div>
      </div>

      <nav class="filter-row" id="list-type-filters" aria-label="Place types"></nav>
      <nav class="filter-row" id="list-city-filters" aria-label="Cities"></nav>
      <button class="sort-control" id="list-sort-btn" data-action="sort" type="button"></button>
      <div id="list-place-list"></div>
      <div class="empty-state" id="list-empty-state">No places found.</div>
    </div>
  `;

  renderPlaceBrowser({
    stats: "list-stats",
    typeFilters: "list-type-filters",
    cityFilters: "list-city-filters",
    sort: "list-sort-btn",
    placeList: "list-place-list",
    empty: "list-empty-state"
  }, context);
  renderListDetailMap(getFiltered(context));
}

function refreshListDetailResults(listId) {
  const context = { listId };
  renderPlaceBrowser({
    stats: "list-stats",
    typeFilters: "list-type-filters",
    cityFilters: "list-city-filters",
    sort: "list-sort-btn",
    placeList: "list-place-list",
    empty: "list-empty-state"
  }, context);
  destroyDetailMap();
  renderListDetailMap(getFiltered(context));
}

function renderListDetailMap(places) {
  const Leaflet = globalThis.L;
  const container = $("detail-map");
  if (!container) return;
  if (!Leaflet) {
    container.innerHTML = `<div class="map-empty">Map unavailable.</div>`;
    return;
  }

  detailMap = Leaflet.map(container, {
    zoomControl: false,
    attributionControl: true
  }).setView([20, 0], 2);

  Leaflet.tileLayer(TILE_LAYER_URL, TILE_LAYER_OPTIONS).addTo(detailMap);

  const bounds = [];
  for (const place of places.filter(hasCoordinates)) {
    const marker = Leaflet.circleMarker([place.lat, place.lng], {
      ...PLACE_MARKER_STYLE
    });

    marker.bindTooltip(place.name, {
      direction: "top",
      offset: [0, -8],
      className: "place-tooltip"
    });
    marker.on("click", () => showDetail(place.id));
    marker.addTo(detailMap);
    bounds.push([place.lat, place.lng]);
  }

  requestAnimationFrame(() => {
    detailMap?.invalidateSize();
    fitMapToBounds(detailMap, bounds);
  });
}

function renderPlacePicker(listId) {
  const list = getList(listId);
  const container = $("detail-content");
  if (!list) {
    closeTopScreen();
    return;
  }

  const selected = new Set(list.placeIds);
  const query = state.pickerSearch.toLowerCase();
  const places = state.places
    .filter(place => !selected.has(place.id))
    .filter(place => !query || placeMatchesSearch(place, query))
    .sort((a, b) => a.name.localeCompare(b.name));

  container.className = "overlay-content list-screen";
  container.innerHTML = `
    <button class="back-btn" data-action="back" type="button">Back</button>

    <header class="screen-header">
      <h1 class="detail-name">Add place</h1>
      <p class="detail-meta">${esc(list.name)}</p>
    </header>

    <div class="input-wrap">
      <div class="input-field">
        <input type="text" id="place-picker-input" placeholder="search saved places..." autocomplete="off" spellcheck="false" value="${esc(state.pickerSearch)}">
      </div>
    </div>

    <div class="picker-list">
      ${places.length ? places.map(place => `
        <article class="picker-item" data-action="choose-place-for-list" data-list-id="${esc(list.id)}" data-place-id="${esc(place.id)}">
          <h2 class="place-name">${esc(place.name)}</h2>
          <p class="place-address">${esc(locationLabel(place))}</p>
          <div class="place-tags">${esc(place.type || "Other")} - ${esc(cityLabel(place))}</div>
        </article>
      `).join("") : `<div class="empty-state inline-empty">No saved places to add.</div>`}
    </div>
  `;

  requestAnimationFrame(() => {
    const input = $("place-picker-input");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
}

function renderDetail(place) {
  const container = $("detail-content");
  destroyDetailMap();
  if (state.isEditing) {
    renderEditForm(place);
    return;
  }

  container.className = "overlay-content detail-view";

  const nearby = getNearby(place);
  const review = placeNeedsReview(place);
  const description = place.description || "No description yet.";

  container.innerHTML = `
    ${hasCoordinates(place) ? `<div class="detail-map-container"><div class="detail-map" id="detail-map"></div></div>` : ""}

    <div class="detail-body">
      <button class="back-btn" data-action="back" type="button">Back</button>

      <h1 class="detail-name">${esc(place.name)}</h1>
      <p class="detail-address">${esc(locationLabel(place))}</p>
      <p class="detail-meta">${esc(place.type || "Other")} - ${esc(cityLabel(place))} - ${formatDate(place.dateAdded)}</p>

      ${review ? `<p class="detail-notice">Add missing details before the map pin is reliable.</p>` : ""}
      <p class="detail-description">${esc(description)}</p>
      <p class="detail-tags">${place.tags.map(tag => esc(tag)).join(" - ")}</p>

      <hr class="detail-rule">
      ${renderPlaceListsSection(place)}

      ${nearby.length ? `
        <hr class="detail-rule">
        <div class="section-label">Nearby in ${esc(place.city)}</div>
        ${nearby.map(candidate => `
          <div class="nearby-item" data-id="${esc(candidate.id)}">
            <span class="nearby-title">${esc(candidate.name)}</span>
            <span class="nearby-meta">${esc(candidate.type)} - ${esc(locationLabel(candidate))}</span>
          </div>
        `).join("")}
      ` : ""}

      <hr class="detail-rule">
      <div class="detail-actions">
        <button class="action-link" data-action="edit" type="button">Edit</button>
        <a class="action-link muted" href="${esc(place.canonicalUrl || place.url)}" target="_blank" rel="noopener">Website</a>
        ${renderDeleteAction(place)}
      </div>
    </div>
  `;

  renderDetailMap(place);
}

function renderPlaceListsSection(place) {
  const lists = getListsForPlace(place.id);
  const chips = lists.length
    ? lists.map(list => `<span class="list-chip">${esc(list.name)}</span>`).join("")
    : `<span class="detail-empty">No lists yet.</span>`;
  const chooser = state.listChooserPlaceId === place.id ? renderListChooser(place) : "";

  return `
    <div class="section-label">Lists</div>
    <div class="list-chip-row">${chips}</div>
    <button class="action-link" data-action="${state.lists.length ? "toggle-list-chooser" : "open-lists"}" data-place-id="${esc(place.id)}" type="button">Add to list</button>
    ${chooser}
  `;
}

function renderListChooser(place) {
  if (!state.lists.length) {
    return `<div class="detail-empty">Create a list first.</div>`;
  }

  return `
    <div class="list-toggle-grid">
      ${state.lists.map(list => {
        const active = list.placeIds.includes(place.id);
        return `
          <button class="list-toggle${active ? " active" : ""}" data-action="toggle-list-membership" data-list-id="${esc(list.id)}" data-place-id="${esc(place.id)}" type="button">
            ${esc(list.name)}
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderDetailMap(place) {
  const Leaflet = globalThis.L;
  const container = $("detail-map");
  if (!Leaflet || !container || !hasCoordinates(place)) return;

  detailMap = Leaflet.map(container, {
    zoomControl: false,
    attributionControl: true
  }).setView([place.lat, place.lng], 17);

  Leaflet.tileLayer(TILE_LAYER_URL, TILE_LAYER_OPTIONS).addTo(detailMap);

  const marker = Leaflet.circleMarker([place.lat, place.lng], {
    ...PLACE_MARKER_STYLE
  }).addTo(detailMap);

  marker.bindTooltip(place.name, {
    direction: "top",
    offset: [0, -8],
    className: "place-tooltip"
  });

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
  const container = $("detail-content");
  container.className = "overlay-content";
  container.innerHTML = `
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
          <span>Tags</span>
          <input name="tags" value="${esc(place.tags.join(", "))}" autocomplete="off">
        </label>
      </div>

      <label class="field">
        <span>Description</span>
        <textarea name="description">${esc(place.description)}</textarea>
      </label>

      <label class="field">
        <span>Address</span>
        <input name="address" value="${esc(place.address)}" autocomplete="street-address">
      </label>

      <div class="field-row">
        <label class="field">
          <span>City</span>
          <input name="city" value="${esc(place.city)}" autocomplete="address-level2">
        </label>
        <label class="field">
          <span>State</span>
          <input name="state" value="${esc(place.state)}" autocomplete="address-level1">
        </label>
      </div>

      <label class="field">
        <span>Country</span>
        <input name="country" value="${esc(place.country)}" autocomplete="country-name">
      </label>

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
  state.listChooserPlaceId = null;
  pushScreen({ type: "place-detail", placeId: place.id });
}

function goBack() {
  if (!$("detail-overlay").classList.contains("active")) return;
  if (state.isEditing) return cancelEdit();
  closeTopScreen();
}

function startEdit() {
  const place = getCurrentPlace();
  if (!place) return;
  state.isEditing = true;
  state.pendingDeleteId = null;
  renderScreen();
}

function cancelEdit() {
  const place = getCurrentPlace();
  if (!place) return goBack();

  state.isEditing = false;
  renderScreen();
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
    state: formString(data, "state"),
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
  renderScreen();
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
      state: place.state || geocode.state || "",
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
  renderScreen();
}

function cancelDeleteCurrentPlace() {
  const place = getCurrentPlace();
  if (!place) return;
  state.pendingDeleteId = null;
  renderScreen();
}

function deleteCurrentPlace() {
  const place = getCurrentPlace();
  if (!place) return;

  state.places = state.places.filter(candidate => candidate.id !== place.id);
  state.lists = state.lists.map(list => ({
    ...list,
    placeIds: list.placeIds.filter(id => id !== place.id)
  }));
  state.screenStack = state.screenStack.filter(screen => screen.type !== "place-detail" || screen.placeId !== place.id);
  state.currentPlaceId = null;
  state.pendingDeleteId = null;
  state.isEditing = false;
  state.listChooserPlaceId = null;
  save();

  renderScreen({ resetScroll: true });
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

    const newElement = placeElement(addedPlace.id, $("place-list"));
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

function createList(form) {
  const data = new FormData(form);
  const name = formString(data, "name");

  if (!name) {
    toast("Name required");
    return;
  }

  if (state.lists.some(list => list.name.toLowerCase() === name.toLowerCase())) {
    toast("List already exists");
    return;
  }

  state.lists.push({
    id: crypto.randomUUID(),
    name,
    placeIds: [],
    dateCreated: new Date().toISOString()
  });
  state.isCreatingList = false;
  save();
  renderScreen();
  renderAll();
  toast("List created");
}

function addPlaceToList(listId, placeId) {
  const list = getList(listId);
  const place = state.places.find(candidate => candidate.id === String(placeId));
  if (!list || !place || list.placeIds.includes(place.id)) return;

  list.placeIds.push(place.id);
  save();
  closeTopScreen();
  toast("Place added to list");
}

function removePlaceFromList(listId, placeId) {
  const list = getList(listId);
  if (!list) return;

  const nextIds = list.placeIds.filter(id => id !== String(placeId));
  if (nextIds.length === list.placeIds.length) return;

  list.placeIds = nextIds;
  save();
  renderScreen();
  renderAll();
  toast("Removed from list");
}

function toggleListMembership(listId, placeId) {
  const list = getList(listId);
  const place = state.places.find(candidate => candidate.id === String(placeId));
  if (!list || !place) return;

  if (list.placeIds.includes(place.id)) {
    list.placeIds = list.placeIds.filter(id => id !== place.id);
    toast("Removed from list");
  } else {
    list.placeIds.push(place.id);
    toast("Added to list");
  }

  save();
  renderAll();
  renderScreen();
}

function renderAll() {
  renderStats();
  renderTypeFilters();
  renderCityFilters();
  renderSort();
  renderPlaces();
  updateMarkers();
}

function getContextFromElement(element) {
  return element.closest("#detail-content") && getCurrentScreen()?.type === "list-detail"
    ? { listId: getCurrentScreen().listId }
    : {};
}

function bindEvents() {
  const input = $("main-input");
  const status = $("input-status");

  $("lists-btn").addEventListener("click", showLists);

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
    setTypeFilter({}, item.dataset.type);
    renderTypeFilters();
    renderPlaces();
    updateMarkers();
  });

  $("city-filters").addEventListener("click", event => {
    const item = event.target.closest(".cat-item");
    if (!item) return;
    setCityFilter({}, item.dataset.city);
    renderCityFilters();
    renderPlaces();
    updateMarkers();
  });

  $("sort-btn").addEventListener("click", () => {
    advanceSort({});
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

  $("detail-content").addEventListener("input", event => {
    if (event.target.id === "list-input") {
      state.listSearch = event.target.value.trim();
      const current = getCurrentScreen();
      if (current?.type === "list-detail") {
        refreshListDetailResults(current.listId);
      }
    }

    if (event.target.id === "place-picker-input") {
      state.pickerSearch = event.target.value.trim();
      renderScreen();
    }
  });

  $("detail-content").addEventListener("submit", event => {
    if (event.target.id === "place-edit-form") {
      event.preventDefault();
      saveEditForm(event.target);
    }

    if (event.target.id === "list-create-form") {
      event.preventDefault();
      createList(event.target);
    }
  });

  $("detail-content").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (action) {
      const current = getCurrentScreen();

      if (action.dataset.action === "back") return goBack();
      if (action.dataset.action === "edit") return startEdit();
      if (action.dataset.action === "cancel-edit") return cancelEdit();
      if (action.dataset.action === "request-delete") return requestDeleteCurrentPlace();
      if (action.dataset.action === "confirm-delete") return deleteCurrentPlace();
      if (action.dataset.action === "cancel-delete") return cancelDeleteCurrentPlace();
      if (action.dataset.action === "open-lists") return showLists();
      if (action.dataset.action === "show-create-list") {
        state.isCreatingList = true;
        return renderScreen();
      }
      if (action.dataset.action === "cancel-create-list") {
        state.isCreatingList = false;
        return renderScreen();
      }
      if (action.dataset.action === "add-place-to-list") return showPlacePicker(action.dataset.listId);
      if (action.dataset.action === "choose-place-for-list") return addPlaceToList(action.dataset.listId, action.dataset.placeId);
      if (action.dataset.action === "remove-from-list") return removePlaceFromList(action.dataset.listId, action.dataset.placeId);
      if (action.dataset.action === "toggle-list-chooser") {
        state.listChooserPlaceId = state.listChooserPlaceId === action.dataset.placeId ? null : action.dataset.placeId;
        return renderScreen();
      }
      if (action.dataset.action === "toggle-list-membership") return toggleListMembership(action.dataset.listId, action.dataset.placeId);
      if (action.dataset.action === "type-filter") {
        const context = getContextFromElement(action);
        setTypeFilter(context, action.dataset.type);
        return context.listId ? renderScreen() : renderAll();
      }
      if (action.dataset.action === "city-filter") {
        const context = getContextFromElement(action);
        setCityFilter(context, action.dataset.city);
        return context.listId ? renderScreen() : renderAll();
      }
      if (action.dataset.action === "sort") {
        const context = current?.type === "list-detail" ? { listId: current.listId } : {};
        advanceSort(context);
        return context.listId ? renderScreen() : renderAll();
      }
    }

    const listItem = event.target.closest(".list-item");
    if (listItem) return showListDetail(listItem.dataset.listId);

    const placeItem = event.target.closest(".place-item");
    if (placeItem) return showDetail(placeItem.dataset.id);

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
