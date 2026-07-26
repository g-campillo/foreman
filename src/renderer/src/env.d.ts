/// <reference types="vite/client" />

import type { ForemanApi } from '../../preload'

declare global {
  interface Window {
    foreman: ForemanApi
  }
}

declare module '*.css' {
  const css: string
  export default css
}

export {}
