const DB_NAME = 'battle-simulator-5e'
const DB_VERSION = 1
const STORE_NAME = 'cache'

const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

export const readCache = async <T>(key: string): Promise<T | undefined> => {
  const database = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.get(key)

    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}

export const writeCache = async <T>(key: string, value: T): Promise<void> => {
  const database = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.put(value, key)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export const deleteCache = async (key: string): Promise<void> => {
  const database = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.delete(key)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export const readJsonState = <T>(key: string, fallback: T): T => {
  try {
    const stored = localStorage.getItem(key)
    return stored ? (JSON.parse(stored) as T) : fallback
  } catch {
    return fallback
  }
}

export const writeJsonState = <T>(key: string, value: T) => {
  localStorage.setItem(key, JSON.stringify(value))
}
