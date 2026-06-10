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
    try { await authApi.logout(); } catch (e) {}
    localStorage.removeItem('cflex_token');
    localStorage.removeItem('cflex_user');
    localStorage.removeItem('cflex_tenant');
    setUser(null);
    setTenant(null);
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
