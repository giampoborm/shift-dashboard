/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional build-time default for the Google OAuth client ID used by Drive sync.
   *  Usually left unset — the user pastes their client ID into Settings instead. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}
