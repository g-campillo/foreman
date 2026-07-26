import type { ForemanApi } from './index'

declare global {
  interface Window {
    foreman: ForemanApi
  }
}

export {}
