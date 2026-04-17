import {
  applyMutation,
  collaboratorId,
  createDeviceId,
  createMutation,
  createUser,
  listItemId,
  normalizeCollaborator,
  normalizeCode,
  normalizeList,
  normalizeListItem,
  normalizePlaceRecord,
  normalizeUser
} from "./model.js";

export const STATE_STORAGE_KEY = "locus_v2";
export const LEGACY_STORAGE_KEY = "locus_v1";
export const SCHEMA_VERSION = 2;

export function loadAppState() {
  try {
    const raw = localStorage.getItem(STATE_STORAGE_KEY);
    if (raw) return normalizeStoredState(JSON.parse(raw));
  } catch {
    // Fall through to first-run state.
  }

  return {
    ...createInitialState(),
    pendingLegacy: loadLegacyState()
  };
}

export function saveAppState(state) {
  try {
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(serializeState(state)));
  } catch {
    // Local storage can fail in private windows or quota pressure.
  }
}

export function createInitialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: createDeviceId(),
    user: null,
    hlc: { wallTime: 0, counter: 0 },
    places: [],
    lists: [],
    listItems: [],
    collaboratorsByList: {},
    placeClocks: {},
    listClocks: {},
    listItemClocks: {},
    collaboratorClocks: {},
    profileSync: createSyncState(),
    sharedListSync: {},
    typeFilter: "All",
    cityFilter: "All",
    sortIndex: 0
  };
}

export function normalizeStoredState(data = {}) {
  const state = {
    ...createInitialState(),
    schemaVersion: SCHEMA_VERSION,
    deviceId: typeof data.deviceId === "string" && data.deviceId ? data.deviceId : createDeviceId(),
    user: normalizeUser(data.user),
    hlc: normalizeClock(data.hlc),
    places: Array.isArray(data.places) ? data.places.map(normalizePlaceRecord) : [],
    lists: Array.isArray(data.lists) ? data.lists.map(normalizeList) : [],
    listItems: Array.isArray(data.listItems) ? data.listItems.map(normalizeListItem).filter(item => item.listId && item.placeId) : [],
    collaboratorsByList: normalizeCollaboratorsByList(data.collaboratorsByList),
    placeClocks: plainObject(data.placeClocks),
    listClocks: plainObject(data.listClocks),
    listItemClocks: plainObject(data.listItemClocks),
    collaboratorClocks: plainObject(data.collaboratorClocks),
    profileSync: normalizeSyncState(data.profileSync),
    sharedListSync: normalizeSharedSync(data.sharedListSync),
    typeFilter: data.typeFilter || "All",
    cityFilter: data.cityFilter || "All",
    sortIndex: Number.isInteger(data.sortIndex) ? data.sortIndex : 0
  };

  reconcileFilters(state);
  return state;
}

export function migrateLegacyForUser(state, name) {
  const nextUser = createUser(name);
  state.user = nextUser;

  const legacy = state.pendingLegacy || { places: [], lists: [], typeFilter: "All", cityFilter: "All", sortIndex: 0 };
  state.typeFilter = legacy.typeFilter || "All";
  state.cityFilter = legacy.cityFilter || "All";
  state.sortIndex = Number.isInteger(legacy.sortIndex) ? legacy.sortIndex : 0;

  for (const legacyPlace of legacy.places || []) {
    const place = normalizePlaceRecord({
      ...legacyPlace,
      addedByUserId: nextUser.id,
      addedByName: nextUser.name
    });
    const mutation = createMutation(state, "place", place.id, "_create", place);
    applyMutation(state, mutation);
    state.profileSync.mutationQueue.push(mutation);
  }

  for (const legacyList of legacy.lists || []) {
    const list = normalizeList({
      ...legacyList,
      ownerUserId: nextUser.id,
      ownerName: nextUser.name
    });
    const listMutation = createMutation(state, "list", list.id, "_create", list);
    applyMutation(state, listMutation);
    state.profileSync.mutationQueue.push(listMutation);

    for (const placeId of legacyList.placeIds || []) {
      const item = normalizeListItem({
        id: listItemId(list.id, placeId),
        listId: list.id,
        placeId,
        addedByUserId: nextUser.id,
        addedByName: nextUser.name,
        addedAt: list.dateCreated
      });
      const itemMutation = createMutation(state, "list_item", item.id, "_create", item);
      applyMutation(state, itemMutation);
      state.profileSync.mutationQueue.push(itemMutation);
    }

    const collaborator = normalizeCollaborator({
      id: collaboratorId(list.id, nextUser.id),
      listId: list.id,
      userId: nextUser.id,
      name: nextUser.name,
      joinedAt: list.dateCreated
    });
    const collaboratorMutation = createMutation(state, "collaborator", collaborator.id, "_create", collaborator);
    applyMutation(state, collaboratorMutation);
    state.profileSync.mutationQueue.push(collaboratorMutation);
  }

  delete state.pendingLegacy;
  reconcileFilters(state);
  return state;
}

export function ensureSharedSyncState(state, code, listId = "") {
  const normalized = normalizeCode(code);
  if (!normalized) return createSyncState({ listId });
  state.sharedListSync ||= {};
  state.sharedListSync[normalized] = normalizeSyncState({
    ...state.sharedListSync[normalized],
    listId: listId || state.sharedListSync[normalized]?.listId || ""
  });
  return state.sharedListSync[normalized];
}

export function loadSettings() {
  return {
    apiBaseUrl: getConfiguredApiBaseUrl() || getDefaultPlaceApiBaseUrl(),
    syncBaseUrl: getConfiguredSyncBaseUrl() || getDefaultSyncBaseUrl(),
    appToken: ""
  };
}

function serializeState(state) {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: state.deviceId,
    user: state.user || null,
    hlc: normalizeClock(state.hlc),
    places: state.places || [],
    lists: state.lists || [],
    listItems: state.listItems || [],
    collaboratorsByList: state.collaboratorsByList || {},
    placeClocks: state.placeClocks || {},
    listClocks: state.listClocks || {},
    listItemClocks: state.listItemClocks || {},
    collaboratorClocks: state.collaboratorClocks || {},
    profileSync: normalizeSyncState(state.profileSync),
    sharedListSync: normalizeSharedSync(state.sharedListSync),
    typeFilter: state.typeFilter,
    cityFilter: state.cityFilter,
    sortIndex: state.sortIndex
  };
}

function loadLegacyState() {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.places)) return null;
    const places = data.places.map(normalizePlaceRecord);
    const placeIds = new Set(places.map(place => place.id));
    const lists = normalizeLegacyLists(data.lists, placeIds);
    return {
      places,
      lists,
      typeFilter: data.typeFilter || "All",
      cityFilter: data.cityFilter || "All",
      sortIndex: Number.isInteger(data.sortIndex) ? data.sortIndex : 0
    };
  } catch {
    return null;
  }
}

function normalizeLegacyLists(lists, validPlaceIds) {
  if (!Array.isArray(lists)) return [];

  return lists
    .map(list => {
      const normalized = normalizeList(list);
      const placeIds = Array.isArray(list?.placeIds) ? list.placeIds : [];
      return {
        ...normalized,
        placeIds: Array.from(new Set(placeIds.map(id => String(id)))).filter(id => validPlaceIds.has(id))
      };
    })
    .filter(list => list.name);
}

function normalizeCollaboratorsByList(value) {
  const result = {};
  if (!value || typeof value !== "object") return result;

  for (const [listId, collaborators] of Object.entries(value)) {
    if (!Array.isArray(collaborators)) continue;
    const normalized = collaborators.map(normalizeCollaborator).filter(collaborator => collaborator.listId && collaborator.userId && collaborator.name);
    if (normalized.length) result[String(listId)] = normalized;
  }

  return result;
}

function createSyncState(input = {}) {
  return {
    mutationQueue: Array.isArray(input.mutationQueue) ? input.mutationQueue.filter(isQueuedMutation) : [],
    lastSyncTimestamp: typeof input.lastSyncTimestamp === "string" ? input.lastSyncTimestamp : "",
    listId: typeof input.listId === "string" ? input.listId : ""
  };
}

function normalizeSyncState(input = {}) {
  return createSyncState(input);
}

function normalizeSharedSync(input) {
  const result = {};
  if (!input || typeof input !== "object") return result;

  for (const [code, syncState] of Object.entries(input)) {
    const normalized = normalizeCode(code);
    if (normalized) result[normalized] = normalizeSyncState(syncState);
  }

  return result;
}

function normalizeClock(clock) {
  return {
    wallTime: Number.isFinite(clock?.wallTime) ? clock.wallTime : 0,
    counter: Number.isFinite(clock?.counter) ? clock.counter : 0
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function reconcileFilters(state) {
  const places = (state.places || []).filter(place => !place.deleted);
  if (state.typeFilter !== "All" && state.typeFilter !== "Favorites" && !places.some(place => place.type === state.typeFilter)) {
    state.typeFilter = "All";
  }

  if (state.cityFilter !== "All" && !places.some(place => cityLabel(place, places) === state.cityFilter)) {
    state.cityFilter = "All";
  }
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

function getDefaultPlaceApiBaseUrl() {
  const host = globalThis.location?.hostname || "";
  const protocol = globalThis.location?.protocol || "";

  if (protocol === "file:" || host === "localhost" || host === "127.0.0.1") {
    return "http://localhost:8797";
  }

  return "";
}

function getDefaultSyncBaseUrl() {
  const host = globalThis.location?.hostname || "";
  const protocol = globalThis.location?.protocol || "";

  if (protocol === "file:" || host === "localhost" || host === "127.0.0.1") {
    return "http://localhost:8796";
  }

  return "";
}

function getConfiguredApiBaseUrl() {
  const value = globalThis.LOCUS_CONFIG?.apiBaseUrl;
  if (typeof value !== "string") return "";
  if (value.includes("YOUR_")) return "";
  return value.trim().replace(/\/+$/, "");
}

function getConfiguredSyncBaseUrl() {
  const value = globalThis.LOCUS_CONFIG?.syncBaseUrl;
  if (typeof value !== "string") return "";
  if (value.includes("YOUR_")) return "";
  return value.trim().replace(/\/+$/, "");
}

function isQueuedMutation(mutation) {
  return Boolean(
    mutation &&
    typeof mutation.id === "string" &&
    typeof mutation.entityType === "string" &&
    typeof mutation.entityId === "string" &&
    typeof mutation.field === "string" &&
    typeof mutation.timestamp === "string"
  );
}
