/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_CENTER_URL?: string
  readonly VITE_PUBLIC_HOST?: string
  readonly VITE_PUBLIC_PATH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
