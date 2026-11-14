import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import Dashboard from './pages/Dashboard';
import Onboarding from './pages/Onboarding';
import { LoginPage, SignupPage } from './pages/Auth';
import { AnalyticsPage, AutomationsPage, InboxPage, KnowledgePage, SettingsPage, TeamPage, TicketsPage } from './pages/Placeholders';
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/tickets" element={<TicketsPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/team" element={<TeamPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<LoginPage />} />
    </Routes>
  );
}
