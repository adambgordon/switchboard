import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { shouldResync } from './storageSync'

/** Keep one localStorage-backed hook in sync with writes made by another window. */
export function useStorageSync<T>(
  key: string,
  read: () => T,
  setValue: Dispatch<SetStateAction<T>>
): void {
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (shouldResync(event.key, key)) setValue(read())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [key, read, setValue])
}
