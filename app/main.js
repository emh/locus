import { geocodePlace, ingestPlace } from "./api.js";
import {
  applyMutation,
  applyMutations,
  collaboratorId,
  createId,
  createMutation,
  getListItems,
  listItemId,
  normalizeCode,
  normalizeCollaborator,
  normalizeList,
  normalizeListItem,
  normalizePlaceRecord,
  normalizeUserName,
  visibleLists,
  visiblePlaces
} from "./model.js";
import { normalizePlace, placeNeedsReview } from "./place.js";
import { ensureSharedSyncState, loadAppState, loadSettings, migrateLegacyForUser, saveAppState } from "./storage.js";
import { LocusSync, createRemoteList, createRemoteProfile, fetchRemoteList, fetchRemoteProfile, joinRemoteList } from "./sync.js";

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
  createListPlaceId: null,
  pickerSearch: "",
  listChooserPlaceId: null,
  listContributorFilter: "",
  setupScreen: null,
  setupPayload: null,
  syncStatus: "idle",
  listSyncStatuses: {},
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
let profileSync = null;
let renderedSetupKey = "";
let screenTransitionToken = 0;
const listSyncs = new Map();

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
const SCREEN_EXIT_MS = 180;

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

function hasUser() {
  return Boolean(state.user?.id && state.user?.name);
}

function currentUserLabel() {
  return state.user?.name || "";
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
  return visiblePlaces(state.places).find(place => place.id === state.currentPlaceId) || null;
}

function getCurrentScreen() {
  return state.screenStack[state.screenStack.length - 1] || null;
}

function getList(id) {
  return visibleLists(state.lists).find(list => list.id === String(id)) || null;
}

function getListsForPlace(placeId) {
  const id = String(placeId);
  const listIds = new Set((state.listItems || [])
    .filter(item => !item.deleted && item.placeId === id)
    .map(item => item.listId));
  return visibleLists(state.lists).filter(list => listIds.has(list.id));
}

function getListPlaces(list) {
  if (!list) return [];
  const ids = new Set(getListItems(state, list.id).map(item => item.placeId));
  return visiblePlaces(state.places).filter(place => ids.has(place.id));
}

function getListItem(listId, placeId, options = {}) {
  return getListItems(state, listId, options).find(item => item.placeId === String(placeId)) || null;
}

function getListContributors(listId) {
  const collaborators = (state.collaboratorsByList?.[listId] || []).filter(collaborator => !collaborator.deleted);
  const byId = new Map(collaborators.map(collaborator => [collaborator.userId, collaborator]));

  for (const item of getListItems(state, listId)) {
    if (!item.addedByUserId || byId.has(item.addedByUserId)) continue;
    byId.set(item.addedByUserId, normalizeCollaborator({
      id: collaboratorId(listId, item.addedByUserId),
      listId,
      userId: item.addedByUserId,
      name: item.addedByName || "Unknown",
      joinedAt: item.addedAt
    }));
  }

  return Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name) || left.userId.localeCompare(right.userId));
}

function contributorLabel(listId, userId) {
  const contributors = getListContributors(listId);
  const contributor = contributors.find(candidate => candidate.userId === userId);
  if (!contributor) return "Unknown";
  const duplicate = contributors.filter(candidate => candidate.name.toLowerCase() === contributor.name.toLowerCase()).length > 1;
  return duplicate ? `${contributor.name} ${contributor.userId.slice(0, 4)}` : contributor.name;
}

function getPlacePool(context = {}) {
  const list = context.listId ? getList(context.listId) : null;
  return list ? getListPlaces(list) : visiblePlaces(state.places);
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
      sortIndex: state.listSortIndex,
      contributorFilter: state.listContributorFilter
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

  if (context.listId && filters.contributorFilter && !getListContributors(context.listId).some(contributor => contributor.userId === filters.contributorFilter)) {
    state.listContributorFilter = "";
  }
}

function renderStats(targetId = "stats", context = {}) {
  const places = getPlacePool(context);
  const total = places.length;
  const cities = new Set(places.filter(place => place.city).map(place => cityLabel(place))).size;
  const review = places.filter(placeNeedsReview).length;
  const suffix = review ? ` - ${review} need details` : "";
  const user = !context.listId && currentUserLabel() ? ` - ${currentUserLabel()}` : "";
  $(targetId).textContent = `${total} places - ${cities} cities${suffix}${user}`;
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
    `<span class="cat-item${filters.typeFilter === type ? " active" : ""}" data-action="type-filter" data-type="${esc(type)}">${esc(filterLabel(type))}</span>`
  ).join("");
}

function renderCityFilters(targetId = "city-filters", context = {}) {
  const filters = getFilterState(context);
  $(targetId).innerHTML = getCities(context).map(city =>
    `<span class="cat-item${filters.cityFilter === city ? " active" : ""}" data-action="city-filter" data-city="${esc(city)}">${city === "All" ? "all cities" : esc(city)}</span>`
  ).join("");
}

function filterLabel(value) {
  return value === "All" ? "all" : String(value || "").toLowerCase();
}

function renderContributorFilters(targetId, listId) {
  const target = $(targetId);
  if (!target) return;

  const contributors = getListContributors(listId);
  if (contributors.length <= 1) {
    state.listContributorFilter = "";
    target.innerHTML = "";
    return;
  }

  const all = `<span class="cat-item${state.listContributorFilter ? "" : " active"}" data-action="contributor-filter" data-user-id="">all contributors</span>`;
  target.innerHTML = [
    all,
    ...contributors.map(contributor =>
      `<span class="cat-item${state.listContributorFilter === contributor.userId ? " active" : ""}" data-action="contributor-filter" data-user-id="${esc(contributor.userId)}">${esc(contributorLabel(listId, contributor.userId))}</span>`
    )
  ].join("");
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

  if (context.listId && filters.contributorFilter) {
    const ids = new Set(getListItems(state, context.listId)
      .filter(item => item.addedByUserId === filters.contributorFilter)
      .map(item => item.placeId));
    places = places.filter(place => ids.has(place.id));
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
  const item = context.listId ? getListItem(context.listId, place.id) : null;
  const contributor = item?.addedByUserId ? ` - added by ${contributorLabel(context.listId, item.addedByUserId)}` : "";
  const meta = `${place.type || "Other"} - ${cityLabel(place)}${review ? " - needs details" : ""}${contributor}`;
  const removeAction = context.listId ? `
    <button class="row-action" data-action="remove-from-list" data-list-id="${esc(context.listId)}" data-place-id="${esc(place.id)}" type="button">remove from list</button>
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
  return visiblePlaces(state.places)
    .filter(candidate => candidate.id !== place.id && candidate.city === place.city && candidate.state === place.state)
    .slice(0, 4);
}

function renderScreen(options = {}) {
  const overlay = $("detail-overlay");
  const container = $("detail-content");
  const screen = getCurrentScreen();
  const wasActive = overlay.classList.contains("active");
  const hasContent = Boolean(container.innerHTML.trim());
  const direction = options.direction === "back" ? "back" : "forward";
  const shouldTransitionContent = Boolean(options.transition && wasActive && screen && hasContent);
  const token = ++screenTransitionToken;

  if (!screen) {
    overlay.classList.remove("active");
    document.body.classList.remove("no-scroll");
    state.currentPlaceId = null;
    setTimeout(() => {
      if (token !== screenTransitionToken) return;
      destroyDetailMap();
      container.className = "overlay-content";
      container.innerHTML = "";
    }, 350);
    return;
  }

  overlay.classList.add("active");
  document.body.classList.add("no-scroll");
  if (screen.type !== "place-detail") {
    state.currentPlaceId = null;
  }
  if (options.resetScroll && !shouldTransitionContent) {
    overlay.scrollTop = 0;
  }

  if (shouldTransitionContent) {
    container.classList.remove("screen-enter", "screen-enter-forward", "screen-enter-back", "screen-exit-forward", "screen-exit-back");
    container.classList.add(direction === "back" ? "screen-exit-back" : "screen-exit-forward");
    setTimeout(() => {
      if (token !== screenTransitionToken) return;
      renderScreenBody(screen, options);
      requestAnimationFrame(() => {
        if (token !== screenTransitionToken) return;
        container.classList.add(direction === "back" ? "screen-enter-back" : "screen-enter-forward");
      });
    }, SCREEN_EXIT_MS);
    return;
  }

  renderScreenBody(screen, options);
  if (options.resetScroll) {
    container.classList.remove("screen-enter", "screen-enter-forward", "screen-enter-back");
    requestAnimationFrame(() => container.classList.add(direction === "back" ? "screen-enter-back" : "screen-enter-forward"));
  }
}

function renderScreenBody(screen, options = {}) {
  const overlay = $("detail-overlay");
  const container = $("detail-content");

  destroyDetailMap();
  container.classList.remove("screen-enter", "screen-enter-forward", "screen-enter-back", "screen-exit-forward", "screen-exit-back");

  if (screen.type === "lists") {
    renderListsIndex();
  } else if (screen.type === "list-detail") {
    renderListDetail(screen.listId);
  } else if (screen.type === "place-picker") {
    renderPlacePicker(screen.listId);
  } else if (screen.type === "place-detail") {
    const place = visiblePlaces(state.places).find(candidate => candidate.id === String(screen.placeId));
    if (!place) {
      closeTopScreen();
      return;
    }
    state.currentPlaceId = place.id;
    renderDetail(place);
  }

  if (options.resetScroll) {
    overlay.scrollTop = 0;
  }
}

function pushScreen(screen) {
  if (screen.type !== "place-detail") {
    state.isEditing = false;
    state.pendingDeleteId = null;
    state.listChooserPlaceId = null;
    state.createListPlaceId = null;
  }

  state.screenStack.push(screen);
  renderScreen({ resetScroll: true, transition: true, direction: "forward" });
}

function closeTopScreen() {
  state.screenStack.pop();
  state.isEditing = false;
  state.isCreatingList = false;
  state.pendingDeleteId = null;
  state.listChooserPlaceId = null;
  state.createListPlaceId = null;
  state.pickerSearch = "";
  renderScreen({ resetScroll: true, transition: true, direction: "back" });
  renderAll();
}

function showLists() {
  state.isCreatingList = false;
  state.createListPlaceId = null;
  pushScreen({ type: "lists" });
}

function showListDetail(listId) {
  const list = getList(listId);
  if (!list) return;

  state.listSearch = "";
  state.listTypeFilter = "All";
  state.listCityFilter = "All";
  state.listSortIndex = state.sortIndex;
  state.listContributorFilter = "";
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
  const lists = visibleLists(state.lists);
  container.className = "overlay-content list-screen";
  container.innerHTML = `
    <button class="back-btn" data-action="back" type="button">back</button>

    <header class="screen-header">
      <h1 class="detail-name">lists</h1>
      <p class="detail-meta">${lists.length} ${lists.length === 1 ? "list" : "lists"}</p>
    </header>

    <div class="list-actions">
      ${state.isCreatingList && !state.createListPlaceId ? renderCreateListForm() : `<button class="action-link" data-action="show-create-list" type="button">new list</button>`}
    </div>

    <div class="saved-lists">
      ${lists.length ? lists.map(renderListItem).join("") : `<div class="empty-state inline-empty">No lists yet.</div>`}
    </div>
  `;

  if (state.isCreatingList) {
    requestAnimationFrame(() => $("new-list-name")?.focus());
  }
}

function renderCreateListForm(placeId = "") {
  return `
    <form class="inline-form" id="list-create-form" data-place-id="${esc(placeId)}">
      <label class="field">
        <span>List name</span>
        <input id="new-list-name" name="name" autocomplete="off">
      </label>
      <div class="form-actions compact">
        <button class="action-link" type="submit">create</button>
        <button class="action-link muted" data-action="cancel-create-list" type="button">cancel</button>
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
      <button class="back-btn" data-action="back" type="button">back</button>
      <h1 class="detail-name">List not found</h1>
    `;
    return;
  }

  const context = { listId: list.id };
  const contributors = getListContributors(list.id);
  container.className = "overlay-content detail-view";
  container.innerHTML = `
    <div class="detail-map-container"><div class="detail-map" id="detail-map"></div></div>

    <div class="detail-body">
      <button class="back-btn" data-action="back" type="button">back</button>

      <header class="screen-header title-row list-title-row">
        <div>
          <h1 class="detail-name">${esc(list.name)}</h1>
          <p class="detail-meta" id="list-stats"></p>
        </div>
        <button class="nav-link" data-action="share-list" data-list-id="${esc(list.id)}" type="button">share</button>
      </header>

      <div class="list-actions">
        <button class="action-link list-add-control" data-action="add-place-to-list" data-list-id="${esc(list.id)}" type="button">add place</button>
      </div>

      <div class="input-wrap">
        <div class="input-field">
          <input type="text" id="list-input" placeholder="search this list..." autocomplete="off" spellcheck="false" value="${esc(state.listSearch)}">
        </div>
        <div id="list-input-status"></div>
      </div>

      <nav class="filter-row" id="list-type-filters" aria-label="Place types"></nav>
      <nav class="filter-row" id="list-city-filters" aria-label="Cities"></nav>
      ${contributors.length > 1 ? `<nav class="filter-row" id="list-contributor-filters" aria-label="Contributors"></nav>` : ""}
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
  renderContributorFilters("list-contributor-filters", list.id);
  scheduleListDetailMap(list.id, getFiltered(context));
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
  renderContributorFilters("list-contributor-filters", listId);
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

  const selected = new Set(getListItems(state, list.id).map(item => item.placeId));
  const query = state.pickerSearch.toLowerCase();
  const places = visiblePlaces(state.places)
    .filter(place => !selected.has(place.id))
    .filter(place => !query || placeMatchesSearch(place, query))
    .sort((a, b) => a.name.localeCompare(b.name));

  container.className = "overlay-content list-screen";
  container.innerHTML = `
    <button class="back-btn" data-action="back" type="button">back</button>

    <header class="screen-header">
      <h1 class="detail-name">add place</h1>
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
      <button class="back-btn" data-action="back" type="button">back</button>

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
        <button class="action-link" data-action="edit" type="button">edit</button>
        <a class="action-link muted" href="${esc(place.canonicalUrl || place.url)}" target="_blank" rel="noopener">website</a>
        ${renderDeleteAction(place)}
      </div>
    </div>
  `;

  schedulePlaceDetailMap(place.id, place);
  if (state.isCreatingList && state.createListPlaceId === place.id) {
    requestAnimationFrame(() => $("new-list-name")?.focus());
  }
}

function scheduleListDetailMap(listId, places) {
  const token = screenTransitionToken;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const current = getCurrentScreen();
      if (token !== screenTransitionToken || current?.type !== "list-detail" || current.listId !== listId) return;
      renderListDetailMap(places);
    });
  });
}

function schedulePlaceDetailMap(placeId, place) {
  const token = screenTransitionToken;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const current = getCurrentScreen();
      if (token !== screenTransitionToken || current?.type !== "place-detail" || current.placeId !== placeId) return;
      renderDetailMap(place);
    });
  });
}

function renderPlaceListsSection(place) {
  const lists = getListsForPlace(place.id);
  const chips = lists.length
    ? lists.map(list => `<span class="list-chip">${esc(list.name)}</span>`).join("")
    : `<span class="detail-empty">No lists yet.</span>`;
  const chooserOpen = state.listChooserPlaceId === place.id;
  const chooser = chooserOpen ? renderListChooser(place) : "";

  return `
    <div class="section-label">Lists</div>
    <div class="list-chip-row">${chips}</div>
    <button class="action-link" data-action="toggle-list-chooser" data-place-id="${esc(place.id)}" type="button" aria-expanded="${chooserOpen ? "true" : "false"}">add to list</button>
    ${chooser}
  `;
}

function renderListChooser(place) {
  const lists = visibleLists(state.lists);
  const creating = state.isCreatingList && state.createListPlaceId === place.id;

  return `
    ${lists.length ? `
      <div class="list-toggle-grid">
        ${lists.map(list => {
          const active = Boolean(getListItem(list.id, place.id));
          return `
            <button class="list-toggle${active ? " active" : ""}" data-action="toggle-list-membership" data-list-id="${esc(list.id)}" data-place-id="${esc(place.id)}" type="button">
              ${esc(list.name)}
            </button>
          `;
        }).join("")}
      </div>
    ` : ""}
    ${creating ? renderCreateListForm(place.id) : `<button class="action-link" data-action="show-create-list" data-place-id="${esc(place.id)}" type="button">new list</button>`}
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
    return `<button class="action-link muted" data-action="request-delete" type="button">remove</button>`;
  }

  return `
    <span class="delete-confirm-label">remove?</span>
    <button class="action-link" data-action="confirm-delete" type="button">yes</button>
    <button class="action-link muted" data-action="cancel-delete" type="button">cancel</button>
  `;
}

function renderEditForm(place) {
  destroyDetailMap();
  const container = $("detail-content");
  container.className = "overlay-content";
  container.innerHTML = `
    <button class="back-btn" data-action="cancel-edit" type="button">back</button>

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
        <button class="action-link" type="submit">save details</button>
        <button class="action-link muted" data-action="cancel-edit" type="button">cancel</button>
      </div>
    </form>
  `;
}

function showDetail(id, options = {}) {
  const place = visiblePlaces(state.places).find(candidate => candidate.id === String(id));
  if (!place) return;

  state.currentPlaceId = place.id;
  state.isEditing = Boolean(options.edit);
  state.isCreatingList = false;
  state.pendingDeleteId = null;
  state.listChooserPlaceId = null;
  state.createListPlaceId = null;
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
  let next = normalizePlaceRecord({
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

  state.currentPlaceId = next.id;
  state.isEditing = false;
  const changes = placeFieldChanges(place, next).map(field => ({
    entityType: "place",
    entityId: place.id,
    field,
    value: next[field]
  }));

  if (changes.length) {
    commitChanges(changes, next.status === "ready" ? "Place updated" : "Place saved; details still needed");
  } else {
    renderAll();
    renderScreen();
    toast("No changes");
  }
}

function placeFieldChanges(previous, next) {
  const fields = [
    "name",
    "type",
    "address",
    "city",
    "state",
    "country",
    "tags",
    "lat",
    "lng",
    "description",
    "notes",
    "dateUpdated",
    "status",
    "geocodeStatus",
    "error",
    "osmId",
    "osmType"
  ];

  return fields.filter(field => JSON.stringify(previous[field] ?? null) !== JSON.stringify(next[field] ?? null));
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

function commitChanges(changes, message) {
  if (!hasUser()) {
    showNamePrompt();
    return;
  }

  const mutations = changes.map(change => ({
    change,
    mutation: createMutation(state, change.entityType, change.entityId, change.field, change.value)
  }));

  for (const { change, mutation } of mutations) {
    applyMutation(state, mutation);
    queueMutation(mutation, change);
  }

  save();
  flushSyncs();
  renderAll();
  renderScreen();
  if (message) toast(message);
  return mutations.map(item => item.mutation);
}

function queueMutation(mutation, change = {}) {
  if (change.profile !== false) {
    state.profileSync.mutationQueue.push(mutation);
  }

  const sharedCode = sharedCodeForChange(change);
  if (sharedCode) {
    ensureSharedSyncState(state, sharedCode, change.listId || mutation.value?.listId || mutation.entityId);
    state.sharedListSync[sharedCode].mutationQueue.push(mutation);
  }
}

function sharedCodeForChange(change = {}) {
  if (change.sharedCode) return normalizeCode(change.sharedCode);
  if (change.sharedListId) return getList(change.sharedListId)?.sharedCode || "";
  if (change.listId) return getList(change.listId)?.sharedCode || "";
  if (change.entityType === "list") return getList(change.entityId)?.sharedCode || "";
  if (change.entityType === "list_item") return getList(change.value?.listId || change.entityId.split(":")[0])?.sharedCode || "";
  return "";
}

function flushSyncs() {
  profileSync?.flush();
  for (const sync of listSyncs.values()) sync.flush();
}

function applyRemotePayload(payload) {
  if (payload?.user) {
    state.user = {
      ...payload.user,
      profileCode: payload.user.profileCode || payload.code || state.user?.profileCode || ""
    };
  }

  if (Array.isArray(payload?.mutations)) {
    applyMutations(state, payload.mutations);
  } else {
    mergeMaterializedPayload(payload);
  }

  if (payload?.highWatermark) {
    if (payload.room?.type === "profile" || payload.user) {
      state.profileSync.lastSyncTimestamp = payload.highWatermark;
    } else if (payload.code) {
      ensureSharedSyncState(state, payload.code, payload.room?.listId || payload.lists?.[0]?.id || "").lastSyncTimestamp = payload.highWatermark;
    }
  }
}

function mergeMaterializedPayload(payload = {}) {
  const synthetic = [];
  for (const place of payload.places || []) {
    synthetic.push(createSyntheticMutation("place", place.id, "_create", place));
  }
  for (const list of payload.lists || []) {
    synthetic.push(createSyntheticMutation("list", list.id, "_create", list));
  }
  for (const item of payload.listItems || []) {
    synthetic.push(createSyntheticMutation("list_item", item.id, "_create", item));
  }
  for (const collaborators of Object.values(payload.collaboratorsByList || {})) {
    for (const collaborator of collaborators) {
      synthetic.push(createSyntheticMutation("collaborator", collaborator.id, "_create", collaborator));
    }
  }
  applyMutations(state, synthetic);
}

function createSyntheticMutation(entityType, entityId, field, value) {
  return {
    id: createId(),
    entityType,
    entityId,
    field,
    value,
    timestamp: `${String(Date.now()).padStart(13, "0")}:0000:import`,
    authorId: value.addedByUserId || value.ownerUserId || value.userId || state.user?.id || "import",
    authorName: value.addedByName || value.ownerName || value.name || state.user?.name || "Imported",
    deviceId: "import"
  };
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

  const changes = [
    { entityType: "place", entityId: place.id, field: "deleted", value: true }
  ];

  for (const item of (state.listItems || []).filter(candidate => candidate.placeId === place.id && !candidate.deleted)) {
    changes.push({
      entityType: "list_item",
      entityId: item.id,
      field: "deleted",
      value: true,
      listId: item.listId
    });
  }

  state.screenStack = state.screenStack.filter(screen => screen.type !== "place-detail" || screen.placeId !== place.id);
  state.currentPlaceId = null;
  state.pendingDeleteId = null;
  state.isEditing = false;
  state.listChooserPlaceId = null;
  state.createListPlaceId = null;
  commitChanges(changes, "Place removed");
}

async function addPlace(url) {
  if (!hasUser()) {
    showNamePrompt();
    return;
  }

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
  if (!hasUser()) {
    showNamePrompt();
    return normalizePlaceRecord(place);
  }

  const existingIndex = state.places.findIndex(candidate =>
    candidate.canonicalUrl === place.canonicalUrl ||
    candidate.url === place.url ||
    candidate.originalUrl === place.originalUrl ||
    candidate.url === place.originalUrl ||
    candidate.originalUrl === place.url
  );

  if (existingIndex >= 0) {
    const existing = state.places[existingIndex];
    const next = normalizePlaceRecord({
      ...existing,
      ...place,
      id: existing.id,
      dateAdded: existing.dateAdded,
      notes: existing.notes || place.notes,
      isFavorite: existing.isFavorite,
      addedByUserId: existing.addedByUserId || state.user.id,
      addedByName: existing.addedByName || state.user.name
    });
    const changes = placeFieldChanges(existing, next).map(field => ({
      entityType: "place",
      entityId: existing.id,
      field,
      value: next[field]
    }));
    if (changes.length) commitChanges(changes);
    return state.places.find(candidate => candidate.id === existing.id) || next;
  }

  const next = normalizePlaceRecord({
    ...place,
    addedByUserId: state.user.id,
    addedByName: state.user.name
  });
  commitChanges([{ entityType: "place", entityId: next.id, field: "_create", value: next }]);
  return state.places.find(candidate => candidate.id === next.id) || next;
}

function createList(form) {
  if (!hasUser()) {
    showNamePrompt();
    return;
  }

  const data = new FormData(form);
  const name = formString(data, "name");
  const placeId = String(form.dataset.placeId || state.createListPlaceId || "");
  const place = placeId ? visiblePlaces(state.places).find(candidate => candidate.id === placeId) : null;

  if (!name) {
    toast("Name required");
    return;
  }

  if (visibleLists(state.lists).some(list => list.name.toLowerCase() === name.toLowerCase())) {
    toast("List already exists");
    return;
  }

  const list = normalizeList({
    id: createId(),
    name,
    ownerUserId: state.user.id,
    ownerName: state.user.name,
    dateCreated: new Date().toISOString()
  });
  const collaborator = normalizeCollaborator({
    id: collaboratorId(list.id, state.user.id),
    listId: list.id,
    userId: state.user.id,
    name: state.user.name,
    joinedAt: list.dateCreated
  });

  const changes = [
    { entityType: "list", entityId: list.id, field: "_create", value: list },
    { entityType: "collaborator", entityId: collaborator.id, field: "_create", value: collaborator }
  ];

  if (place) {
    const item = normalizeListItem({
      id: listItemId(list.id, place.id),
      listId: list.id,
      placeId: place.id,
      addedByUserId: state.user.id,
      addedByName: state.user.name,
      addedAt: new Date().toISOString()
    });
    changes.push({
      entityType: "list_item",
      entityId: item.id,
      field: "_create",
      value: item,
      listId: list.id
    });
  }

  state.isCreatingList = false;
  state.createListPlaceId = null;
  state.listChooserPlaceId = null;
  commitChanges(changes, place ? "Added to new list" : "List created");
}

function addPlaceToList(listId, placeId) {
  const list = getList(listId);
  const place = visiblePlaces(state.places).find(candidate => candidate.id === String(placeId));
  if (!list || !place || getListItem(list.id, place.id)) return;

  const item = normalizeListItem({
    id: listItemId(list.id, place.id),
    listId: list.id,
    placeId: place.id,
    addedByUserId: state.user.id,
    addedByName: state.user.name,
    addedAt: new Date().toISOString()
  });
  const changes = sharedSeedChangesForPlace(list, place);
  changes.push({
    entityType: "list_item",
    entityId: item.id,
    field: "_create",
    value: item,
    listId: list.id
  });
  commitChanges(changes, "Place added to list");
  closeTopScreen();
}

function removePlaceFromList(listId, placeId) {
  const list = getList(listId);
  if (!list) return;

  const item = getListItem(list.id, placeId);
  if (!item) return;

  commitChanges([{
    entityType: "list_item",
    entityId: item.id,
    field: "deleted",
    value: true,
    listId: list.id
  }], "Removed from list");
}

function toggleListMembership(listId, placeId) {
  const list = getList(listId);
  const place = visiblePlaces(state.places).find(candidate => candidate.id === String(placeId));
  if (!list || !place) return;

  const item = getListItem(list.id, place.id, { includeDeleted: true });
  if (item && !item.deleted) {
    state.isCreatingList = false;
    state.createListPlaceId = null;
    state.listChooserPlaceId = null;
    commitChanges([{
      entityType: "list_item",
      entityId: item.id,
      field: "deleted",
      value: true,
      listId: list.id
    }], "Removed from list");
  } else {
    const nextItem = normalizeListItem({
      ...(item || {}),
      id: item?.id || listItemId(list.id, place.id),
      listId: list.id,
      placeId: place.id,
      addedByUserId: item?.addedByUserId || state.user.id,
      addedByName: item?.addedByName || state.user.name,
      addedAt: item?.addedAt || new Date().toISOString(),
      deleted: false
    });
    const changes = sharedSeedChangesForPlace(list, place);
    changes.push(item ? {
      entityType: "list_item",
      entityId: item.id,
      field: "deleted",
      value: false,
      listId: list.id
    } : {
      entityType: "list_item",
      entityId: nextItem.id,
      field: "_create",
      value: nextItem,
      listId: list.id
    });
    state.isCreatingList = false;
    state.createListPlaceId = null;
    state.listChooserPlaceId = null;
    commitChanges(changes, "Added to list");
  }
}

function sharedSeedChangesForPlace(list, place) {
  if (!list.sharedCode) return [];
  return [{
    entityType: "place",
    entityId: place.id,
    field: "_create",
    value: normalizePlaceRecord(place),
    sharedListId: list.id,
    profile: false
  }];
}

function renderSetupScreen() {
  const screen = $("setup-screen");
  const content = $("setup-content");
  if (!screen || !content) return;

  const active = !hasUser() || Boolean(state.setupScreen);
  screen.classList.toggle("active", active);
  document.body.classList.toggle("no-scroll", active || $("detail-overlay").classList.contains("active"));
  if (!active) {
    renderedSetupKey = "";
    return;
  }

  if (!hasUser() && state.setupScreen !== "list-preview") {
    setSetupContent(renderNamePrompt(), "name", () => $("setup-name")?.focus());
    return;
  }

  if (state.setupScreen === "device-share") {
    const code = state.setupPayload?.code || state.user.profileCode;
    const url = deviceLink(code);
    setSetupContent(`
      <button class="back-btn" data-action="close-setup" type="button">back</button>
      <h1>link device</h1>
      <p class="setup-copy">Open this on another device.</p>
      <input class="share-field" id="device-share-url" value="${esc(url)}" readonly>
      <div class="setup-code" id="device-share-code">${esc(code)}</div>
      <div class="detail-actions">
        <button class="action-link" data-action="share-device-url" type="button">share url</button>
        <button class="action-link" data-action="copy-device-url" type="button">copy url</button>
        <button class="action-link muted" data-action="copy-device-code" type="button">copy code</button>
      </div>
    `, `device-share:${code}`);
    return;
  }

  if (state.setupScreen === "list-share") {
    const list = getList(state.setupPayload?.listId);
    const code = list?.sharedCode || state.setupPayload?.code || "";
    const url = listShareLink(code);
    setSetupContent(`
      <button class="back-btn" data-action="close-setup" type="button">back</button>
      <h1>${esc(list?.name || "shared list")}</h1>
      <p class="setup-copy">Share this list.</p>
      <input class="share-field" id="list-share-url" value="${esc(url)}" readonly>
      <div class="setup-code" id="list-share-code">${esc(code)}</div>
      <div class="detail-actions">
        <button class="action-link" data-action="share-list-url" type="button">share url</button>
        <button class="action-link" data-action="copy-list-url" type="button">copy url</button>
        <button class="action-link muted" data-action="copy-list-code" type="button">copy code</button>
      </div>
    `, `list-share:${list?.id || ""}:${code}`);
    return;
  }

  if (state.setupScreen === "list-preview") {
    const code = state.setupPayload?.code || state.setupPayload?.room?.code || "";
    setSetupContent(renderListPreview(), `list-preview:${code}`, () => $("shared-list-name")?.focus());
  }
}

function setSetupContent(html, key, afterRender) {
  const content = $("setup-content");
  if (!content) return;
  const changed = renderedSetupKey !== key;
  if (changed) {
    content.innerHTML = html;
    renderedSetupKey = key;
    content.classList.remove("screen-enter");
    requestAnimationFrame(() => content.classList.add("screen-enter"));
  }
  if (afterRender) requestAnimationFrame(afterRender);
}

function renderNamePrompt() {
  return `
    <h1>locus</h1>
    <p class="setup-copy">Pick a name before saving places.</p>
    <label class="field">
      <span>Your name</span>
      <input id="setup-name" autocomplete="name" spellcheck="false">
    </label>
    <div class="detail-actions">
      <button class="action-link" data-action="save-name" type="button">continue</button>
    </div>
  `;
}

function renderListPreview() {
  const payload = state.setupPayload || {};
  const list = payload.lists?.[0] || {};
  const places = payload.places || [];
  const joinControl = hasUser()
    ? `<button class="action-link" data-action="join-shared-list" type="button">add me as ${esc(state.user.name)}</button>`
    : `
      <label class="field">
        <span>Your name</span>
        <input id="shared-list-name" autocomplete="name" spellcheck="false">
      </label>
      <div class="detail-actions">
        <button class="action-link" data-action="join-shared-list" type="button">add me</button>
      </div>
    `;

  return `
    ${hasUser() ? '<button class="back-btn" data-action="close-setup" type="button">back</button>' : ""}
    <h1>${esc(list.name || "shared list")}</h1>
    <p class="setup-copy">${places.length} ${places.length === 1 ? "place" : "places"}</p>
    <div class="setup-preview-list">
      ${places.length ? places.map(place => `
        <article class="place-item">
          <div class="place-meta">
            <span>${esc(place.type || "Other")} - ${esc(place.city || "Unknown")}</span>
          </div>
          <h2 class="place-name">${esc(place.name)}</h2>
          <p class="place-address">${esc(locationLabel(place))}</p>
        </article>
      `).join("") : `<div class="empty-state inline-empty">No places yet.</div>`}
    </div>
    ${joinControl}
  `;
}

function showNamePrompt() {
  state.setupScreen = "name";
  state.setupPayload = null;
  renderAll();
}

function completeNameSetup() {
  const name = normalizeUserName($("setup-name")?.value);
  if (!name) {
    toast("Name required");
    return;
  }

  migrateLegacyForUser(state, name);
  state.setupScreen = null;
  state.setupPayload = null;
  save();
  configureSync();
  renderAll();
}

async function showDeviceLink() {
  if (!hasUser()) return showNamePrompt();
  const code = await ensureProfileCode();
  state.setupScreen = "device-share";
  state.setupPayload = { code };
  renderAll();
}

async function ensureProfileCode() {
  if (state.user?.profileCode) return state.user.profileCode;
  const payload = await createRemoteProfile({
    user: state.user,
    mutations: state.profileSync.mutationQueue
  }, state.settings);
  applyRemotePayload(payload);
  state.user.profileCode = payload.code;
  if (Array.isArray(payload.confirmedIds)) {
    const confirmed = new Set(payload.confirmedIds);
    state.profileSync.mutationQueue = state.profileSync.mutationQueue.filter(mutation => !confirmed.has(mutation.id));
  }
  save();
  configureSync();
  return state.user.profileCode;
}

async function linkDevice(code) {
  const payload = await fetchRemoteProfile(code, state.settings);
  applyRemotePayload(payload);
  state.user = {
    ...payload.user,
    profileCode: payload.code
  };
  state.profileSync.mutationQueue = [];
  state.profileSync.lastSyncTimestamp = payload.highWatermark || "";
  stripInviteQueries();
  save();
  configureSync();
  state.setupScreen = null;
  state.setupPayload = null;
  renderAll();
  toast("Device linked");
}

async function shareList(listId) {
  if (!hasUser()) return showNamePrompt();
  const list = getList(listId);
  if (!list) return;
  const code = await ensureListShared(list);
  state.setupScreen = "list-share";
  state.setupPayload = { listId: list.id, code };
  renderAll();
}

async function ensureListShared(list) {
  if (list.sharedCode) return list.sharedCode;
  const payload = await createRemoteList({
    list,
    user: state.user,
    places: getListPlaces(list),
    listItems: getListItems(state, list.id)
  }, state.settings);
  applyRemotePayload(payload);
  for (const mutation of payload.mutations || []) {
    state.profileSync.mutationQueue.push(mutation);
  }
  ensureSharedSyncState(state, payload.code, list.id).lastSyncTimestamp = payload.highWatermark || "";
  save();
  configureSync();
  return payload.code;
}

async function showSharedListPreview(code) {
  const payload = await fetchRemoteList(code, state.settings);
  state.setupScreen = "list-preview";
  state.setupPayload = payload;
  renderAll();
}

async function joinSharedList() {
  const code = state.setupPayload?.code || state.setupPayload?.room?.code;
  if (!code) return;

  if (!hasUser()) {
    const name = normalizeUserName($("shared-list-name")?.value);
    if (!name) {
      toast("Name required");
      return;
    }
    migrateLegacyForUser(state, name);
  }

  const payload = await joinRemoteList(code, state.user, state.settings);
  applyRemotePayload(payload);
  for (const mutation of payload.mutations || []) {
    state.profileSync.mutationQueue.push(mutation);
  }
  const listId = payload.room?.listId || payload.lists?.[0]?.id || "";
  ensureSharedSyncState(state, payload.code, listId).lastSyncTimestamp = payload.highWatermark || "";
  stripInviteQueries();
  save();
  configureSync();
  state.setupScreen = null;
  state.setupPayload = null;
  renderAll();
  if (listId && getList(listId)) {
    state.screenStack = [{ type: "list-detail", listId }];
    state.listSearch = "";
    state.listTypeFilter = "All";
    state.listCityFilter = "All";
    state.listSortIndex = state.sortIndex;
    state.listContributorFilter = "";
    renderScreen({ resetScroll: true });
  }
  toast("list added");
}

function closeSetup() {
  state.setupScreen = null;
  state.setupPayload = null;
  stripInviteQueries();
  renderAll();
}

function deviceLink(code) {
  const url = new URL(globalThis.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("device", code);
  return url.toString();
}

function listShareLink(code) {
  const url = new URL(globalThis.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("list", code);
  return url.toString();
}

function stripInviteQueries() {
  const url = new URL(globalThis.location.href);
  if (!url.searchParams.has("device") && !url.searchParams.has("list")) return;
  url.searchParams.delete("device");
  url.searchParams.delete("list");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

async function copyText(value, message) {
  await navigator.clipboard?.writeText(value);
  toast(message);
}

async function shareText(title, url, fallbackMessage) {
  if (navigator.share) {
    await navigator.share({ title, url });
  } else {
    await copyText(url, fallbackMessage);
  }
}

function renderAll() {
  renderSetupScreen();
  if (!hasUser()) {
    updateMarkers();
    return;
  }

  renderSyncIndicator();
  renderStats();
  renderTypeFilters();
  renderCityFilters();
  renderSort();
  renderPlaces();
  updateMarkers();
}

function renderSyncIndicator() {
  const dot = $("sync-dot");
  if (!dot) return;
  const profilePending = state.profileSync?.mutationQueue?.length > 0;
  const listPending = Object.values(state.sharedListSync || {}).some(syncState => syncState.mutationQueue?.length > 0);
  const synced = Boolean(state.user?.profileCode && !profilePending && !listPending && state.syncStatus !== "syncing");
  dot.classList.toggle("synced", synced);
  dot.classList.toggle("unsynced", !synced);
  dot.setAttribute("aria-label", synced ? "synced" : "not synced");
  dot.title = synced ? "synced" : "not synced";
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
  $("link-device-btn").addEventListener("click", () => runAction(showDeviceLink));

  $("setup-content").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;

    runAction(async () => {
      if (action.dataset.action === "save-name") return completeNameSetup();
      if (action.dataset.action === "close-setup") return closeSetup();
      if (action.dataset.action === "copy-device-url") return copyText($("device-share-url")?.value || "", "url copied");
      if (action.dataset.action === "copy-device-code") return copyText($("device-share-code")?.textContent || "", "code copied");
      if (action.dataset.action === "share-device-url") return shareText("link locus device", $("device-share-url")?.value || "", "url copied");
      if (action.dataset.action === "copy-list-url") return copyText($("list-share-url")?.value || "", "url copied");
      if (action.dataset.action === "copy-list-code") return copyText($("list-share-code")?.textContent || "", "code copied");
      if (action.dataset.action === "share-list-url") return shareText("share locus list", $("list-share-url")?.value || "", "url copied");
      if (action.dataset.action === "join-shared-list") return joinSharedList();
    });
  });

  $("setup-content").addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    if (event.target?.id === "setup-name") {
      event.preventDefault();
      completeNameSetup();
    }
    if (event.target?.id === "shared-list-name") {
      event.preventDefault();
      runAction(joinSharedList);
    }
  });

  input.addEventListener("input", () => {
    const value = input.value.trim();
    if (isUrl(value)) {
      status.textContent = "enter to add place";
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
        state.createListPlaceId = action.dataset.placeId || null;
        if (state.createListPlaceId) state.listChooserPlaceId = state.createListPlaceId;
        return renderScreen();
      }
      if (action.dataset.action === "cancel-create-list") {
        state.isCreatingList = false;
        state.createListPlaceId = null;
        return renderScreen();
      }
      if (action.dataset.action === "add-place-to-list") return showPlacePicker(action.dataset.listId);
      if (action.dataset.action === "share-list") return runAction(() => shareList(action.dataset.listId));
      if (action.dataset.action === "choose-place-for-list") return addPlaceToList(action.dataset.listId, action.dataset.placeId);
      if (action.dataset.action === "remove-from-list") return removePlaceFromList(action.dataset.listId, action.dataset.placeId);
      if (action.dataset.action === "toggle-list-chooser") {
        const isOpen = state.listChooserPlaceId === action.dataset.placeId;
        state.listChooserPlaceId = isOpen ? null : action.dataset.placeId;
        if (isOpen) {
          state.isCreatingList = false;
          state.createListPlaceId = null;
        }
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
      if (action.dataset.action === "contributor-filter") {
        state.listContributorFilter = action.dataset.userId || "";
        return renderScreen();
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

function runAction(fn) {
  Promise.resolve(fn()).catch(error => {
    toast(error instanceof Error ? error.message : String(error));
  });
}

function configureSync() {
  if (!hasUser()) {
    profileSync?.stop();
    profileSync = null;
    for (const sync of listSyncs.values()) sync.stop();
    listSyncs.clear();
    state.syncStatus = "idle";
    return;
  }

  if (state.user.profileCode) {
    if (!profileSync || profileSync.code !== state.user.profileCode) {
      profileSync?.stop();
      profileSync = new LocusSync({
        kind: "profiles",
        code: state.user.profileCode,
        state,
        save,
        onStatus(status) {
          state.syncStatus = status;
          renderSyncIndicator();
        },
        onChange() {
          save();
          configureSync();
          renderAll();
          renderScreen();
        },
        onRoom(room) {
          if (room?.code && state.user) {
            state.user.profileCode = room.code;
            save();
          }
        }
      });
      profileSync.start();
    }
  } else {
    profileSync?.stop();
    profileSync = null;
  }

  const desired = new Map();
  for (const list of visibleLists(state.lists)) {
    if (!list.sharedCode) continue;
    desired.set(list.sharedCode, list.id);
    ensureSharedSyncState(state, list.sharedCode, list.id);
  }

  for (const [code, sync] of listSyncs.entries()) {
    if (!desired.has(code)) {
      sync.stop();
      listSyncs.delete(code);
    }
  }

  for (const [code, listId] of desired.entries()) {
    if (listSyncs.has(code)) continue;
    const sync = new LocusSync({
      kind: "lists",
      code,
      state,
      save,
      onStatus(status) {
        state.listSyncStatuses[code] = status;
        renderSyncIndicator();
      },
      onChange() {
        save();
        renderAll();
        renderScreen();
      },
      onRoom(room) {
        if (room?.code) ensureSharedSyncState(state, room.code, room.listId || listId);
      }
    });
    listSyncs.set(code, sync);
    sync.start();
  }
}

function handleInviteQueries() {
  const params = new URLSearchParams(globalThis.location.search);
  const deviceCode = normalizeCode(params.get("device"));
  const listCode = normalizeCode(params.get("list"));

  if (deviceCode) {
    runAction(() => linkDevice(deviceCode));
    return;
  }

  if (listCode) {
    runAction(() => showSharedListPreview(listCode));
    return;
  }

  if (!hasUser()) showNamePrompt();
}

function init() {
  initMap();
  bindEvents();
  handleInviteQueries();
  configureSync();
  renderAll();
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
