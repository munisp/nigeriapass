/**
 * NigerianPass API Client
 * Design: Premium Civic — Navy authority base, typed end-to-end
 *
 * Connects to the Go onboarding service (port 8081) and Python FastAPI gateway (port 8000).
 * All requests carry a Bearer JWT. Refresh is handled transparently via interceptor.
 */

import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";

// ---------------------------------------------------------------------------
// Base URLs — in production these come from env vars injected by Vite
// ---------------------------------------------------------------------------
export const ONBOARDING_BASE = import.meta.env.VITE_ONBOARDING_API_URL ?? "/api/onboarding";
export const GATEWAY_BASE = import.meta.env.VITE_GATEWAY_API_URL ?? "/api";
export const WS_BASE = import.meta.env.VITE_WS_URL ?? (
  typeof window !== "undefined"
    ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`
    : "ws://localhost:8081/ws"
);

// ---------------------------------------------------------------------------
// Token storage helpers
// ---------------------------------------------------------------------------
const TOKEN_KEY = "np_access_token";
const REFRESH_KEY = "np_refresh_token";

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  getRefresh: () => localStorage.getItem(REFRESH_KEY),
  setRefresh: (t: string) => localStorage.setItem(REFRESH_KEY, t),
  clear: () => { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(REFRESH_KEY); },
};

// ---------------------------------------------------------------------------
// Axios instance — onboarding service
// ---------------------------------------------------------------------------
export const onboardingClient = axios.create({
  baseURL: ONBOARDING_BASE,
  timeout: 30_000,
  headers: { "Content-Type": "application/json" },
});

// Attach Bearer token to every request
onboardingClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Transparent token refresh on 401
let isRefreshing = false;
let refreshQueue: Array<(token: string) => void> = [];

onboardingClient.interceptors.response.use(
  res => res,
  async (err: AxiosError) => {
    const original = err.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (err.response?.status === 401 && !original._retry) {
      original._retry = true;
      if (isRefreshing) {
        return new Promise(resolve => {
          refreshQueue.push((token: string) => {
            original.headers.Authorization = `Bearer ${token}`;
            resolve(onboardingClient(original));
          });
        });
      }
      isRefreshing = true;
      try {
        const refresh = tokenStore.getRefresh();
        if (!refresh) throw new Error("No refresh token");
        const { data } = await axios.post(`${ONBOARDING_BASE}/auth/refresh`, { refresh_token: refresh });
        tokenStore.set(data.access_token);
        if (data.refresh_token) tokenStore.setRefresh(data.refresh_token);
        refreshQueue.forEach(cb => cb(data.access_token));
        refreshQueue = [];
        original.headers.Authorization = `Bearer ${data.access_token}`;
        return onboardingClient(original);
      } catch {
        tokenStore.clear();
        window.location.href = "/";
        return Promise.reject(err);
      } finally {
        isRefreshing = false;
      }
    }
    return Promise.reject(err);
  }
);

// ---------------------------------------------------------------------------
// API gateway client (Python FastAPI — NFC, toll, analytics)
// ---------------------------------------------------------------------------
export const gatewayClient = axios.create({
  baseURL: GATEWAY_BASE,
  timeout: 30_000,
  headers: { "Content-Type": "application/json" },
});
gatewayClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ---------------------------------------------------------------------------
// Typed request / response models
// ---------------------------------------------------------------------------

export interface LoginRequest { phone: string; password: string; }
export interface LoginResponse { access_token: string; refresh_token: string; user_id: string; role: string; }

export interface DriverOnboardingRequest {
  first_name: string; last_name: string; middle_name?: string;
  date_of_birth: string; gender: string; phone: string; email: string;
  state: string; address: string;
  nin: string; bvn: string;
  drivers_licence_number?: string; licence_expiry_date?: string; licence_class?: string;
}
export interface OnboardingResponse {
  id: string; status: string; reference: string; kyc_score?: number; message: string;
}

export interface VehicleRegistrationRequest {
  plate_number: string; vehicle_type: string; make: string; model: string;
  year: number; colour: string; engine_number: string; chassis_number: string;
  owner_nin: string; toll_class: string;
}

export interface FleetKYBRequest {
  company_name: string; cac_number: string; tin_number: string; rc_number: string;
  company_type: string; industry: string; state: string; address: string; website?: string;
  contact_name: string; contact_title: string; contact_phone: string;
  contact_email: string; contact_nin: string;
  credit_limit_requested?: number;
}

export interface DocumentUploadResponse {
  document_id: string; storage_key: string; checksum: string; status: string;
}

export interface LivenessSessionRequest { user_id: string; session_type: "driver" | "fleet_contact"; }
export interface LivenessSessionResponse {
  session_id: string; challenge: string; challenge_type: "blink" | "turn_left" | "turn_right" | "smile" | "nod";
  expires_at: string;
}
export interface LivenessVerifyRequest {
  session_id: string; challenge_response_video_b64?: string; face_image_b64: string;
}
export interface LivenessVerifyResponse {
  passed: boolean; score: number; anti_spoof_score: number; message: string;
}

export interface FaceMatchRequest {
  session_id: string; selfie_b64: string; document_id: string;
}
export interface FaceMatchResponse {
  matched: boolean; similarity: number; confidence: string; message: string;
}

export interface ApplicationStatusResponse {
  id: string; type: string; status: string; submitted_at: string; updated_at: string;
  kyc_score?: number; steps: Array<{ label: string; completed: boolean; active: boolean; timestamp?: string }>;
  notes?: string;
}

export interface DeviceHeartbeat {
  device_id: string; serial: string; status: string;
  cpu_percent: number; memory_percent: number; temperature_celsius: number;
  uptime_seconds: number; last_transaction_ms: number; timestamp: string;
}

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------
export const authApi = {
  login: (req: LoginRequest) =>
    onboardingClient.post<LoginResponse>("/auth/login", req).then(r => r.data),
  logout: () =>
    onboardingClient.post("/auth/logout").then(() => tokenStore.clear()),
  register: (req: { phone: string; email: string; password: string; role?: string }) =>
    onboardingClient.post<LoginResponse>("/auth/register", req).then(r => r.data),
  /** Request a 6-digit OTP via SMS to the given phone number */
  requestOtp: (phone: string) =>
    onboardingClient.post<{ message: string; expires_in: number }>("/auth/otp/request", { phone }).then(r => r.data),
  /** Verify the OTP and receive JWT tokens */
  verifyOtp: (phone: string, otp: string) =>
    onboardingClient.post<LoginResponse>("/auth/otp/verify", { phone, otp }).then(r => r.data),
};

// ---------------------------------------------------------------------------
// Driver Onboarding API
// ---------------------------------------------------------------------------
export const driverApi = {
  submit: (req: DriverOnboardingRequest) =>
    onboardingClient.post<OnboardingResponse>("/driver", req).then(r => r.data),

  uploadDocument: (driverId: string, docType: string, file: File, idempotencyKey: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("document_type", docType);
    form.append("driver_id", driverId);
    return onboardingClient.post<DocumentUploadResponse>("/driver/documents", form, {
      headers: { "Content-Type": "multipart/form-data", "Idempotency-Key": idempotencyKey },
    }).then(r => r.data);
  },

  startLiveness: (req: LivenessSessionRequest) =>
    onboardingClient.post<LivenessSessionResponse>("/liveness/start", req).then(r => r.data),

  verifyLiveness: (req: LivenessVerifyRequest) =>
    onboardingClient.post<LivenessVerifyResponse>("/liveness/verify", req).then(r => r.data),

  matchFace: (req: FaceMatchRequest) =>
    onboardingClient.post<FaceMatchResponse>("/liveness/face-match", req).then(r => r.data),

  getStatus: (reference: string) =>
    onboardingClient.get<ApplicationStatusResponse>(`/driver/status/${reference}`).then(r => r.data),
};

// ---------------------------------------------------------------------------
// Vehicle Registration API
// ---------------------------------------------------------------------------
export const vehicleApi = {
  submit: (req: VehicleRegistrationRequest, idempotencyKey: string) =>
    onboardingClient.post<OnboardingResponse>("/vehicle", req, {
      headers: { "Idempotency-Key": idempotencyKey },
    }).then(r => r.data),

  uploadDocument: (vehicleId: string, docType: string, file: File, idempotencyKey: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("document_type", docType);
    form.append("vehicle_id", vehicleId);
    return onboardingClient.post<DocumentUploadResponse>("/vehicle/documents", form, {
      headers: { "Content-Type": "multipart/form-data", "Idempotency-Key": idempotencyKey },
    }).then(r => r.data);
  },

  verifyPlate: (plate: string) =>
    onboardingClient.get<{ valid: boolean; details?: Record<string, string> }>(`/vehicle/verify-plate/${plate}`).then(r => r.data),

  getStatus: (reference: string) =>
    onboardingClient.get<ApplicationStatusResponse>(`/vehicle/status/${reference}`).then(r => r.data),
};

// ---------------------------------------------------------------------------
// Fleet KYB API
// ---------------------------------------------------------------------------
export const fleetApi = {
  submit: (req: FleetKYBRequest, idempotencyKey: string) =>
    onboardingClient.post<OnboardingResponse>("/fleet", req, {
      headers: { "Idempotency-Key": idempotencyKey },
    }).then(r => r.data),

  uploadDocument: (fleetId: string, docType: string, file: File, idempotencyKey: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("document_type", docType);
    form.append("fleet_id", fleetId);
    return onboardingClient.post<DocumentUploadResponse>("/fleet/documents", form, {
      headers: { "Content-Type": "multipart/form-data", "Idempotency-Key": idempotencyKey },
    }).then(r => r.data);
  },

  verifyCac: (cacNumber: string) =>
    onboardingClient.get<{ valid: boolean; company_name?: string; status?: string }>(`/fleet/verify-cac/${cacNumber}`).then(r => r.data),

  getStatus: (reference: string) =>
    onboardingClient.get<ApplicationStatusResponse>(`/fleet/status/${reference}`).then(r => r.data),
};

// ---------------------------------------------------------------------------
// Device Management API
// ---------------------------------------------------------------------------
export const deviceApi = {
  list: (plazaId?: string) =>
    onboardingClient.get("/devices", { params: plazaId ? { plaza_id: plazaId } : {} }).then(r => r.data),

  updateFirmware: (deviceId: string) =>
    onboardingClient.post(`/devices/${deviceId}/firmware-update`).then(r => r.data),

  reboot: (deviceId: string) =>
    onboardingClient.post(`/devices/${deviceId}/reboot`).then(r => r.data),

  suspend: (deviceId: string) =>
    onboardingClient.post(`/devices/${deviceId}/suspend`).then(r => r.data),

  getHeartbeats: (deviceId: string, limit = 50) =>
    onboardingClient.get<DeviceHeartbeat[]>(`/devices/${deviceId}/heartbeats`, { params: { limit } }).then(r => r.data),
};

// ---------------------------------------------------------------------------
// Admin Review API
// ---------------------------------------------------------------------------
export const adminApi = {
  listApplications: (params?: { status?: string; type?: string; page?: number; limit?: number }) =>
    onboardingClient.get("/admin/applications", { params }).then(r => r.data),

  approve: (id: string, notes?: string) =>
    onboardingClient.post(`/admin/applications/${id}/approve`, { notes }).then(r => r.data),

  reject: (id: string, reason: string) =>
    onboardingClient.post(`/admin/applications/${id}/reject`, { reason }).then(r => r.data),

  startReview: (id: string) =>
    onboardingClient.post(`/admin/applications/${id}/review`).then(r => r.data),
};

// ---------------------------------------------------------------------------
// Application Status (public — no auth required)
// ---------------------------------------------------------------------------
export const statusApi = {
  track: (reference: string) =>
    onboardingClient.get<ApplicationStatusResponse>(`/status/${reference}`).then(r => r.data),
};

// ---------------------------------------------------------------------------
// Idempotency key generator
// ---------------------------------------------------------------------------
export const newIdempotencyKey = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// ---------------------------------------------------------------------------
// Liveness API (doc-intelligence gRPC service via REST proxy)
// ---------------------------------------------------------------------------
export const livenessApi = {
  /**
   * Verify liveness by sending the captured selfie blob and completed challenges
   * to the doc-intelligence Python service. Returns a score in [0, 1].
   */
  verify: async (selfieBlob: Blob, completedChallenges: string[]): Promise<{ passed: boolean; score: number }> => {
    const form = new FormData();
    form.append("selfie", selfieBlob, "selfie.jpg");
    form.append("challenges", JSON.stringify(completedChallenges));
    const res = await onboardingClient.post<{ passed: boolean; score: number }>(
      "/liveness/passive-verify",
      form,
      { headers: { "Content-Type": "multipart/form-data" }, timeout: 20_000 }
    );
    return res.data;
  },
};

// ---------------------------------------------------------------------------
// Wallet API
// ---------------------------------------------------------------------------
export interface WalletBalance {
  account_id: string;
  balance_kobo: number;
  pending_kobo?: number;
  currency: string;
  tier: "basic" | "standard" | "premium";
  daily_cap_kobo: number;
  daily_spent_kobo: number;
  fare_cap_limit_kobo?: number;
  fare_cap_reset_date?: string;
  last_updated: string;
}

export interface WalletTransaction {
  id: string;
  type: "toll" | "topup" | "transit" | "event" | "refund" | "transfer" | "toll_charge";
  amount_kobo: number;
  direction: "debit" | "credit";
  description: string;
  reference: string;
  plaza?: string;
  vehicle_plate?: string;
  status: "completed" | "pending" | "failed";
  created_at: string;
  balance_after_kobo?: number;
}

/** Convenience alias used by the Wallet page */
export type Transaction = WalletTransaction;

export interface TopUpInitRequest {
  amount_kobo?: number;
  amount_naira?: number;
  provider: "paystack" | "flutterwave";
  callback_url?: string;
  redirect_url?: string;
}

export interface TopUpInitResponse {
  payment_url?: string;
  checkout_url?: string;
  reference: string;
  provider: string;
  expires_at: string;
}

export const walletApi = {
  getBalance: () =>
    gatewayClient.get<WalletBalance>("/wallet/balance").then(r => r.data),

  getTransactions: (params?: { page?: number; limit?: number; type?: string; from?: string; to?: string }) =>
    gatewayClient.get<{ transactions: Transaction[]; total: number; page: number }>("/wallet/transactions", { params }).then(r => r.data),

  initiateTopUp: (req: TopUpInitRequest) =>
    gatewayClient.post<TopUpInitResponse>("/wallet/topup/initiate", req).then(r => r.data),

  verifyTopUp: (reference: string) =>
    gatewayClient.get<{ status: string; amount_kobo: number; message: string }>(`/wallet/topup/verify/${reference}`).then(r => r.data),

  getReceipt: (transactionId: string) =>
    gatewayClient.get<WalletTransaction & { receipt_url?: string }>(`/wallet/transactions/${transactionId}/receipt`).then(r => r.data),
};

// ---------------------------------------------------------------------------
// Notification API
// ---------------------------------------------------------------------------
export interface AppNotification {
  id: string;
  type: "kyc_approved" | "kyc_rejected" | "kyc_review" | "vehicle_approved" | "fleet_approved" | "toll_charge" | "low_balance" | "system";
  title: string;
  message: string;
  read: boolean;
  reference?: string;
  created_at: string;
}

export const notificationApi = {
  list: (params?: { unread_only?: boolean; limit?: number }) =>
    onboardingClient.get<{ notifications: AppNotification[]; unread_count: number }>("/notifications", { params }).then(r => r.data),

  markRead: (id: string) =>
    onboardingClient.post(`/notifications/${id}/read`).then(r => r.data),

  markAllRead: () =>
    onboardingClient.post("/notifications/read-all").then(r => r.data),
};
