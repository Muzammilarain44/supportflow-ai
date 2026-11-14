/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import ProtectedRoute from '../components/ProtectedRoute';
import Dashboard from '../pages/Dashboard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const authValue = (user: any) => ({ user, session: null, loading: false, signIn: async () => ({ error: null }), signUp: async () => ({ error: null }), signOut: async () => {}, resetPassword: async () => ({ error: null }) });

describe('protected routes', () => {
  it('redirects unauthenticated users to /login', () => {
    render(
      <AuthContext.Provider value={authValue(null)}>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route element={<ProtectedRoute />}>
                <Route path="/" element={<div>Dashboard page</div>} />
              </Route>
              <Route path="/login" element={<div>Login page</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </AuthContext.Provider>,
    );
    expect(screen.getByText('Login page')).toBeInTheDocument();
  });
  it('renders the protected page for an authenticated user', () => {
    render(
      <AuthContext.Provider value={authValue({ id: 'u1', email: 'a@example.com' })}>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route element={<ProtectedRoute />}>
                <Route path="/" element={<div>Dashboard page</div>} />
              </Route>
              <Route path="/login" element={<div>Login page</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </AuthContext.Provider>,
    );
    expect(screen.getByText('Dashboard page')).toBeInTheDocument();
  });
});

describe('dashboard empty states', () => {
  it('shows explicit empty-state labels, not invented metrics', () => {
    render(
      <AuthContext.Provider value={authValue({ id: 'u1', email: 'a@example.com' })}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter><Dashboard /></MemoryRouter>
        </QueryClientProvider>
      </AuthContext.Provider>,
    );
    expect(screen.getByText('Total tickets')).toBeInTheDocument();
    expect(screen.getByText('No activity yet — this section fills in once conversations and tickets exist (Phase 2).')).toBeInTheDocument();
  });
});
