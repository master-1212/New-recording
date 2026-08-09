const DATABASE_NAME = "voicescope-local-recovery";
const DATABASE_VERSION = 1;
const RECORDING_STORE = "recordings";
const ACTIVE_RECORDING_KEY = "active-recording";
const SESSION_STATE_KEY = "voicescope:playback:v1";
const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;

type StoredRecording = {
  key: typeof ACTIVE_RECORDING_KEY;
  blob: Blob;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  recordingId: string;
  savedAt: number;
};

export type PlaybackSnapshot = {
  recordingId: string;
  currentTime: number;
  rate: number;
  volume: number;
  loop: boolean;
  savedAt: number;
};

export type RecoveredRecording = {
  file: File;
  recordingId: string;
  snapshot: PlaybackSnapshot | null;
};

export function recordingId(file: Pick<File, "name" | "size" | "lastModified">) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is unavailable"));
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RECORDING_STORE)) {
        request.result.createObjectStore(RECORDING_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Local recovery database could not open"));
  });
}

function runTransaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(RECORDING_STORE, mode);
    const request = operation(transaction.objectStore(RECORDING_STORE));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    const fail = () => {
      database.close();
      reject(transaction.error ?? request.error ?? new Error("Local recovery transaction failed"));
    };
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
    transaction.onerror = fail;
    transaction.onabort = fail;
  }));
}

export async function persistRecording(file: File) {
  const stored: StoredRecording = {
    key: ACTIVE_RECORDING_KEY,
    blob: file,
    name: file.name,
    type: file.type,
    size: file.size,
    lastModified: file.lastModified,
    recordingId: recordingId(file),
    savedAt: Date.now(),
  };
  await runTransaction("readwrite", (store) => store.put(stored));
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Recovery remains best-effort when persistent storage is unavailable.
  }
  return stored.recordingId;
}

export async function recoverRecording(): Promise<RecoveredRecording | null> {
  const stored = await runTransaction<StoredRecording | undefined>("readonly", (store) => store.get(ACTIVE_RECORDING_KEY));
  if (!stored) return null;
  if (Date.now() - stored.savedAt > MAX_RECOVERY_AGE_MS) {
    await forgetRecording();
    return null;
  }
  const file = new File([stored.blob], stored.name, { type: stored.type, lastModified: stored.lastModified });
  const snapshot = loadPlaybackSnapshot();
  return {
    file,
    recordingId: stored.recordingId,
    snapshot: snapshot?.recordingId === stored.recordingId ? snapshot : null,
  };
}

export async function forgetRecording() {
  try {
    await runTransaction("readwrite", (store) => store.delete(ACTIVE_RECORDING_KEY));
  } finally {
    clearPlaybackSnapshot();
  }
}

export function savePlaybackSnapshot(snapshot: PlaybackSnapshot) {
  try {
    localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(snapshot));
  } catch {
    // Safari private browsing and full storage quotas can reject localStorage.
  }
}

export function loadPlaybackSnapshot(): PlaybackSnapshot | null {
  try {
    const raw = localStorage.getItem(SESSION_STATE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PlaybackSnapshot>;
    if (typeof value.recordingId !== "string" || typeof value.currentTime !== "number" || typeof value.savedAt !== "number") return null;
    return {
      recordingId: value.recordingId,
      currentTime: Math.max(0, value.currentTime),
      rate: typeof value.rate === "number" ? value.rate : 1,
      volume: typeof value.volume === "number" ? value.volume : 0.9,
      loop: value.loop === true,
      savedAt: value.savedAt,
    };
  } catch {
    return null;
  }
}

export function clearPlaybackSnapshot() {
  try {
    localStorage.removeItem(SESSION_STATE_KEY);
  } catch {
    // Storage may be disabled.
  }
}
