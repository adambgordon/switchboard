import { useEffect, type Dispatch, type SetStateAction } from 'react'

/** Keep one localStorage-backed hook in sync with writes made by another window. */
export function useStorageSync<T>(
  key: string,
  read: () => T,
  setValue: Dispatch<SetStateAction<T>>
): void {
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === key) setValue(read())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [key, read, setValue])
}
