export const PRODUCTION_BACKEND_URL = "https://olivepizza-owner.onrender.com";
export const DEV_BACKEND_URL = "http://localhost:5000";

export interface RoutingContext {
  env?: {
    VITE_DEV_BACKEND_URL?: string;
    VITE_API_BASE_URL?: string;
    VITE_BACKEND_URL?: string;
    [key: string]: any;
  };
  isLocalHost?: boolean;
  isNative?: boolean;
}

/**
 * Pure, testable resolution of the API Base URL.
 * Shared between runtime fetchApi and regression test suites.
 */
export function resolveApiBaseUrl(context: RoutingContext): string {
  const env = context.env || {};

  // 1. Explicit dev backend override takes highest priority in development
  if (env.VITE_DEV_BACKEND_URL) {
    return env.VITE_DEV_BACKEND_URL.replace(/\/+$/, '');
  }

  // 2. Running in local browser (localhost / 127.0.0.1) and NOT in a native container
  if (context.isLocalHost && !context.isNative) {
    return DEV_BACKEND_URL;
  }

  // 3. Configured production or staging backend URLs
  if (env.VITE_API_BASE_URL) {
    return env.VITE_API_BASE_URL.replace(/\/+$/, '');
  }
  if (env.VITE_BACKEND_URL) {
    return env.VITE_BACKEND_URL.replace(/\/+$/, '');
  }

  return PRODUCTION_BACKEND_URL;
}
