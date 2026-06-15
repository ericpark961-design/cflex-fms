// ============================================================
// C-Flex FMS — Auth Context / Hook
// ============================================================

import { createContext, useContext, useState, useEffect } from 'react';
import { authApi } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [tenant, setTenant] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('cflex_token');
    const savedUser = localStorage.getItem('cflex_user');
    const savedTenant = localStorage.getItem('cflex_tenant');

    if (token && savedUser) {
      try {
        setUser(JSON.parse(savedUser));
        if (savedTenant) setTenant(JSON.parse(savedTenant));
      } catch (e) {
        localStorage.clear();
      }
    }
    setLoading(false);
  }, []);

  const login = async (email, password) => {
    const { data } = await authApi.login(email, password);
    localStorage.setItem('cflex_token', data.token);
    localStorage.setItem('cflex_user', JSON.stringify(data.user));
    if (data.tenant) {
      localStorage.setItem('cflex_tenant', JSON.stringify(data.tenant));
    }
    setUser(data.user);
    setTenant(data.tenant);
    return data;
  };

  const logout = async () => {
    // API 응답 기다리지 말고 즉시 토큰 비우고 /login으로 hard redirect.
    // (이전에는 authApi.logout()이 401로 막혀 무한 재시도되며 redirect 못 가던 버그.)
    ['cflex_token', 'cflex_user', 'cflex_tenant'].forEach(k => localStorage.removeItem(k));
    setUser(null);
    setTenant(null);
    try { await authApi.logout(); } catch (e) {}
    window.location.replace('/login');
  };

  return (
    <AuthContext.Provider value={{ user, tenant, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
