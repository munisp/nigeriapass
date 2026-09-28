/**
 * NigerianPass Auth Context
 * Provides JWT auth state, login/logout, and role-based access across the app.
 */
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { authApi, tokenStore } from "@/lib/api";

interface AuthUser {
  user_id: string;
  role: string;
  phone?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (phone: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  register: (phone: string, email: string, password: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore session from localStorage on mount
  useEffect(() => {
    const token = tokenStore.get();
    if (token) {
      try {
        // Decode JWT payload (no verification — server validates)
        const payload = JSON.parse(atob(token.split(".")[1]));
        if (payload.exp * 1000 > Date.now()) {
          setUser({ user_id: payload.sub, role: payload.role ?? "driver" });
        } else {
          tokenStore.clear();
        }
      } catch {
        tokenStore.clear();
      }
    }
    setIsLoading(false);
  }, []);

  const login = useCallback(async (phone: string, password: string) => {
    const data = await authApi.login({ phone, password });
    tokenStore.set(data.access_token);
    tokenStore.setRefresh(data.refresh_token);
    setUser({ user_id: data.user_id, role: data.role });
  }, []);

  const logout = useCallback(async () => {
    try { await authApi.logout(); } catch { /* ignore */ }
    tokenStore.clear();
    setUser(null);
  }, []);

  const register = useCallback(async (phone: string, email: string, password: string) => {
    const data = await authApi.register({ phone, email, password });
    tokenStore.set(data.access_token);
    tokenStore.setRefresh(data.refresh_token);
    setUser({ user_id: data.user_id, role: data.role });
  }, []);

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, isLoading, login, logout, register }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
