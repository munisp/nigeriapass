/**
 * NigerianPass API Clients
 * ========================
 * Two backends:
 *  - Go Toll Backend  → NFC tags, toll sessions, devices, wallets (port 8080)
 *  - Go Onboarding    → KYC, OTP, notifications (port 8081)
 *
 * NOTE: Auth (OTP login) and KYC submissions go through tRPC (client/src/lib/trpc.ts).
 * This module only retains the REST clients that live code actually uses
 * (device management). Dead clients targeting nonexistent endpoints were removed.
 */
import axios, { AxiosError, AxiosInstance } from "axios";

// ─── Base URLs ────────────────────────────────────────────────────────────────
const ONBOARDING_BASE = import.meta.env.VITE_ONBOARDING_API_URL ?? "/api/onboarding";
export const WS_BASE =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

// ─── Token store ─────────────────────────────────────────────────────────────
// Legacy bearer-token store used by the device-heartbeat WebSocket query param.
// Primary auth is the server session cookie set by trpc.otp.verify.
const TOKEN_KEY = "np_auth_token";
const REFRESH_KEY = "np_refresh_token";

export const tokenStore = {
  get: (): string | null => localStorage.getItem(TOKEN_KEY),
  getRefresh: (): string | null => localStorage.getItem(REFRESH_KEY),
  set: (token: string, refresh?: string) => {
    localStorage.setItem(TOKEN_KEY, token);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

// ─── Axios factory with 401 refresh interceptor ───────────────────────────────
function makeClient(baseURL: string): AxiosInstance {
  const client = axios.create({ baseURL, timeout: 15000 });

  client.interceptors.request.use(config => {
    const token = tokenStore.get();
    if (token) config.headers.Authorization = `Bearer ${token}`;
    config.headers["X-Client-Version"] = "1.0.0";
    return config;
  });

  client.interceptors.response.use(
    res => res,
    async (error: AxiosError) => {
      if (error.response?.status === 401) {
        tokenStore.clear();
      }
      return Promise.reject(error);
    }
  );
  return client;
}

const onboardingClient = makeClient(ONBOARDING_BASE);

// ─── Types ────────────────────────────────────────────────────────────────────
export interface WalletBalance {
  account_id: string;
  balance_kobo: number;
  pending_kobo: number;
  currency: string;
  tier: string;
  daily_cap_kobo: number;
  daily_spent_kobo: number;
  fare_cap_limit_kobo: number;
  fare_cap_reset_date: string;
  last_updated: string;
}

export interface Transaction {
  id: string;
  type: "topup" | "toll_charge" | "refund" | "adjustment";
  amount_kobo: number;
  direction: "credit" | "debit";
  description: string;
  reference: string;
  plaza?: string;
  vehicle_plate?: string;
  created_at: string;
  status: "pending" | "completed" | "failed" | "reversed";
  balance_after_kobo: number;
}

export interface AppNotification {
  id: string;
  type: "kyc_approved" | "kyc_rejected" | "kyc_review" | "vehicle_approved" | "fleet_approved" | "toll_charge" | "low_balance" | "system";
  title: string;
  message: string;
  read: boolean;
  reference?: string;
  created_at: string;
}

export interface DeviceHeartbeat {
  device_id: string;
  serial: string;
  status: string;
  cpu: number;
  memory: number;
  temp: number;
  cpu_percent: number;
  memory_percent: number;
  temperature_celsius: number;
  uptime_h: number;
  transactions_today: number;
  timestamp: string;
}

// ─── Device API (Go Toll Backend) ─────────────────────────────────────────────
export const deviceApi = {
  list: (plazaId?: string) =>
    onboardingClient.get<DeviceHeartbeat[]>("/devices", {
      params: plazaId ? { plaza: plazaId } : undefined,
    }),
  heartbeat: (deviceId: string) => onboardingClient.get(`/devices/${deviceId}/heartbeat`),
  reboot: (deviceId: string) => onboardingClient.post(`/devices/${deviceId}/reboot`),
  toggleMaintenance: (deviceId: string, enabled: boolean) =>
    onboardingClient.patch(`/devices/${deviceId}/maintenance`, { enabled }),
};
