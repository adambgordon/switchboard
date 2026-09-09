import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { startStorageSync } from './storageSync'

/** Keep one localStorage-backed hook in sync with writes made by another window. */
export function useStorageSync<T>(
  key: string,
  read: () => T,
  setValue: Dispatch<SetStateAction<T>>
): void {
  useEffect(() => {
    return startStorageSync(key, read, setValue, (listener) => {
      const onStorage = (event: StorageEvent): void => listener(event)
      window.addEventListener('storage', onStorage)
      return () => window.removeEventListener('storage', onStorage)
    })
  }, [key, read, setValue])
}
