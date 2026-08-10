const DATABASE_NAME = "voicescope-local-recovery";
const DATABASE_VERSION = 2;
const RECORDING_STORE = "recordings";
const ACTIVE_RECORDING_KEY = "active-recording";
const SESSION_STATE_KEY = "voicescope:playback:v2";
const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;
const CHUNK_BYTES = 4 * 1024 * 1024;
const PBKDF2_ITERATIONS = 600_000;

type StoredEncryptedRecording = {
  key: typeof ACTIVE_RECORDING_KEY;
  version: 2;
  chunks: ArrayBuffer[];
  salt: Uint8Array<ArrayBuffer>;
  noncePrefix: Uint8Array<ArrayBuffer>;
  iterations: number;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  recordingId: string;
  savedAt: number;
};

export type RecoveryMetadata = Pick<StoredEncryptedRecording, "name" | "size" | "recordingId" | "savedAt">;

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
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RECORDING_STORE)) {
        database.createObjectStore(RECORDING_STORE, { keyPath: "key" });
      } else if ((event as IDBVersionChangeEvent).oldVersion < 2) {
        // Version 1 stored plaintext recording blobs. Remove them during the
        // security migration rather than silently keeping sensitive data.
        request.transaction?.objectStore(RECORDING_STORE).clear();
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

function requireCrypto() {
  if (!globalThis.crypto?.subtle) throw new Error("Encrypted recovery requires a secure browser context");
  return globalThis.crypto;
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number, usage: KeyUsage[]) {
  if (passphrase.length < 12) throw new Error("Use a recovery passphrase with at least 12 characters");
  const browserCrypto = requireCrypto();
  const material = await browserCrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return browserCrypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usage,
  );
}

function nonce(prefix: Uint8Array<ArrayBuffer>, index: number) {
  const value = new Uint8Array(12);
  value.set(prefix, 0);
  new DataView(value.buffer).setUint32(8, index, false);
  return value;
}

function authenticatedMetadata(stored: Pick<StoredEncryptedRecording, "name" | "size" | "lastModified" | "recordingId">, index: number, count: number) {
  return new TextEncoder().encode(JSON.stringify({
    name: stored.name,
    size: stored.size,
    lastModified: stored.lastModified,
    recordingId: stored.recordingId,
    index,
    count,
  }));
}

export async function persistEncryptedRecording(file: File, passphrase: string) {
  const browserCrypto = requireCrypto();
  const salt = browserCrypto.getRandomValues(new Uint8Array(16));
  const noncePrefix = browserCrypto.getRandomValues(new Uint8Array(8));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS, ["encrypt"]);
  const count = Math.max(1, Math.ceil(file.size / CHUNK_BYTES));
  if (count >= 0xffff_ffff) throw new Error("Recording is too large for encrypted recovery");
  const identity = recordingId(file);
  const metadata = { name: file.name, size: file.size, lastModified: file.lastModified, recordingId: identity };
  const chunks: ArrayBuffer[] = [];
  for (let index = 0; index < count; index++) {
    const plain = await file.slice(index * CHUNK_BYTES, Math.min(file.size, (index + 1) * CHUNK_BYTES)).arrayBuffer();
    chunks.push(await browserCrypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce(noncePrefix, index), additionalData: authenticatedMetadata(metadata, index, count), tagLength: 128 },
      key,
      plain,
    ));
  }
  const stored: StoredEncryptedRecording = {
    key: ACTIVE_RECORDING_KEY,
    version: 2,
    chunks,
    salt,
    noncePrefix,
    iterations: PBKDF2_ITERATIONS,
    type: file.type,
    ...metadata,
    savedAt: Date.now(),
  };
  await runTransaction("readwrite", (store) => store.put(stored));
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Recovery remains best-effort when persistent storage is unavailable.
  }
  return identity;
}

async function storedRecovery() {
  const stored = await runTransaction<StoredEncryptedRecording | undefined>("readonly", (store) => store.get(ACTIVE_RECORDING_KEY));
  if (!stored) return null;
  if (stored.version !== 2 || Date.now() - stored.savedAt > MAX_RECOVERY_AGE_MS) {
    await forgetRecording();
    return null;
  }
  return stored;
}

export async function inspectRecovery(): Promise<RecoveryMetadata | null> {
  const stored = await storedRecovery();
  if (!stored) return null;
  return { name: stored.name, size: stored.size, recordingId: stored.recordingId, savedAt: stored.savedAt };
}

export async function recoverEncryptedRecording(passphrase: string): Promise<RecoveredRecording | null> {
  const stored = await storedRecovery();
  if (!stored) return null;
  const key = await deriveKey(passphrase, stored.salt, stored.iterations, ["decrypt"]);
  const plainChunks: ArrayBuffer[] = [];
  for (let index = 0; index < stored.chunks.length; index++) {
    plainChunks.push(await requireCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: nonce(stored.noncePrefix, index), additionalData: authenticatedMetadata(stored, index, stored.chunks.length), tagLength: 128 },
      key,
      stored.chunks[index],
    ));
  }
  const file = new File(plainChunks, stored.name, { type: stored.type, lastModified: stored.lastModified });
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
    // Remove the older unencrypted session snapshot during migration.
    localStorage.removeItem("voicescope:playback:v1");
  } catch {
    // Storage may be disabled.
  }
}
