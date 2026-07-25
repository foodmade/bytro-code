import { create } from "zustand"
import { load, type Store } from "@tauri-apps/plugin-store"

interface OnboardingState {
  readonly completed: boolean

  readonly completeOnboarding: () => Promise<void>
  readonly checkOnboardingCompleted: () => Promise<boolean>
}

const ONBOARDING_STORE_FILE = ".settings.dat"
const ONBOARDING_KEY = "onboarding_completed"

let storeInstance: Store | null = null

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await load(ONBOARDING_STORE_FILE, { defaults: {}, autoSave: false })
  }
  return storeInstance
}

export const useOnboardingStore = create<OnboardingState>()((set) => ({
  completed: false,

  completeOnboarding: async () => {
    set({ completed: true })
    try {
      const store = await getStore()
      await store.set(ONBOARDING_KEY, true)
      await store.save()
    } catch {
      console.error("Failed to persist onboarding state")
    }
  },

  checkOnboardingCompleted: async () => {
    try {
      const store = await getStore()
      const completed = await store.get<boolean>(ONBOARDING_KEY)
      if (completed) {
        set({ completed: true })
      }
      return completed === true
    } catch {
      return false
    }
  },
}))
